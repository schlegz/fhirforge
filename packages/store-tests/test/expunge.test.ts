import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, FhirError, type AuthorizeRequest, type FhirStorage, type StoreAuditEvent } from '@fhirforge/core';
import { postgresStorage, type Database, type SqlClient } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

describe.each(backends)('expunge on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<unknown>[];
  let policy: (req: AuthorizeRequest<unknown>) => boolean | Promise<boolean>;
  const makeStore = () =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: (req: AuthorizeRequest<unknown>) => policy(req),
      expunge: {},
      onAudit: (e) => {
        events.push(e);
      },
    });
  let fhir: ReturnType<typeof makeStore>;
  const user = () => fhir.as({});

  beforeEach(async () => {
    storage = await backend.storage();
    events = [];
    policy = () => true;
    fhir = makeStore();
    await fhir.migrate();
  });
  afterAll(() => backend.close());

  it('removes every version and every search index row, and lets the id be reused', async () => {
    const p = await user().update({ resourceType: 'Patient', id: 'expunge-me', name: [{ family: 'Synthetic-Doe' }] });
    await user().update({ ...p, active: true });
    const other = await user().create({ resourceType: 'Patient', name: [{ family: 'Synthetic-Doe' }] });
    expect((await user().search('Patient', { family: 'synthetic-doe' })).total).toBe(2);

    await user().expunge('Patient', 'expunge-me', { reason: 'test erasure' });

    expect((await fhirError(() => user().read('Patient', 'expunge-me'))).status).toBe(404); // not 410: no trace left
    expect((await fhirError(() => user().vread('Patient', 'expunge-me', '1'))).status).toBe(404);
    expect((await fhirError(() => user().history('Patient', 'expunge-me'))).status).toBe(404);
    const found = await user().search('Patient', { family: 'synthetic-doe' });
    expect(found.resources.map((r) => r.id)).toEqual([other.id]);
    // The id is free again: update-as-create starts at version 1.
    expect((await user().update({ resourceType: 'Patient', id: 'expunge-me' })).meta.versionId).toBe('1');
  });

  it('expunges a deleted resource, and is a separate operation from delete', async () => {
    const p = await user().create({ resourceType: 'Patient' });
    await user().delete('Patient', p.id);
    expect((await user().history('Patient', p.id)).length).toBe(2); // delete keeps history
    await user().expunge('Patient', p.id, { reason: 'test erasure' });
    expect((await fhirError(() => user().history('Patient', p.id))).status).toBe(404);
  });

  it('is 404 for missing resources and for denied ones, and removes nothing when denied', async () => {
    expect((await fhirError(() => user().expunge('Patient', 'missing', { reason: 'test erasure' }))).status).toBe(404);
    const p = await user().create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
    const seen: AuthorizeRequest<unknown>[] = [];
    policy = (req) => {
      seen.push(req);
      return req.action !== 'expunge';
    };
    const err = await fhirError(() => user().expunge('Patient', p.id, { reason: 'test erasure' }));
    expect([err.status, err.message]).toEqual([404, `Patient/${p.id} not found`]);
    expect(seen.find((r) => r.action === 'expunge')?.resource).toMatchObject({ id: p.id, name: [{ family: 'Doe' }] });
    expect((await user().read('Patient', p.id)).id).toBe(p.id);
  });

  it('is pinned: a stale ifMatch, or a change while the policy decides, fails with 412 and removes nothing', async () => {
    const p = await user().create({ resourceType: 'Patient' });
    await user().update({ ...p, active: true });
    expect((await fhirError(() => user().expunge('Patient', p.id, { reason: 'test erasure', ifMatch: 'W/"1"' }))).status).toBe(412);

    let raced = false;
    policy = async (req) => {
      if (req.action === 'expunge' && !raced) {
        raced = true;
        await fhir.asSystem('race').update({ ...p, active: false });
      }
      return true;
    };
    expect((await fhirError(() => user().expunge('Patient', p.id, { reason: 'test erasure' }))).status).toBe(412);
    expect((await user().read('Patient', p.id)).meta.versionId).toBe('3');
  });

  it('is audited as its own action, with the version that was removed', async () => {
    const p = await user().create({ resourceType: 'Patient' });
    events = [];
    await fhir.asSystem('nightly retention job').expunge('Patient', p.id, { reason: 'erasure request #1234' });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'expunge',
        resourceType: 'Patient',
        id: p.id,
        versionId: '1',
        outcome: 'success',
        system: true,
        reason: 'nightly retention job',
        expungeReason: 'erasure request #1234',
      }),
    ]);
  });

  it('needs a reason, and is off unless the store enables it', async () => {
    const p = await user().create({ resourceType: 'Patient' });
    for (const options of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(1001) }]) {
      const err = await fhirError(() => user().expunge('Patient', p.id, options as never));
      expect([err.status, err.message]).toEqual([400, expect.stringMatching(/needs a reason/)]);
    }
    const plain = createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize: 'allow-all' });
    const off = await fhirError(() => plain.expunge('Patient', p.id, { reason: 'test erasure' }));
    expect([off.status, off.message]).toEqual([400, expect.stringMatching(/expunge is not enabled/)]);
    expect((await user().read('Patient', p.id)).id).toBe(p.id);
  });
});

describe('expunge and the audit table (PGlite)', () => {
  const db = new PGlite();
  afterAll(() => db.close());

  it('keeps the resource’s audit rows and records the expunge in the same transaction', async () => {
    const store = createFhirStore({
      storage: pgliteStorage(db, { schema: 'fhir_expunge_audit' }),
      fhir: r4,
      resources: ['Patient'],
      authorize: 'allow-all',
      audit: { table: true, actor: () => 'svc' },
      // A second storage on the same schema, used only for expunge (in production: a role with DELETE).
      expunge: { storage: pgliteStorage(db, { schema: 'fhir_expunge_audit' }) },
    });
    await store.migrate();
    const p = await store.create({ resourceType: 'Patient', name: [{ family: 'Synthetic-Doe' }] });
    await store.read('Patient', p.id);
    await store.expunge('Patient', p.id, { reason: 'test erasure' });
    const { rows } = await db.query<{ action: string; resource_id: string; version_id: string | number; expunge_reason: string | null }>(
      `SELECT action, resource_id, version_id, expunge_reason FROM fhir_expunge_audit."_audit" ORDER BY seq`,
    );
    expect(rows.map((r) => [r.action, r.resource_id === p.id, String(r.version_id), r.expunge_reason])).toEqual([
      ['create', true, '1', null],
      ['read', true, '1', null],
      ['expunge', true, '1', 'test erasure'],
    ]);
    const { rows: left } = await db.query(`SELECT 1 FROM fhir_expunge_audit."Patient_history" UNION ALL SELECT 1 FROM fhir_expunge_audit."Patient_string"`);
    expect(left).toEqual([]);
  });
});

const url = process.env.FHIRFORGE_TEST_DATABASE_URL;

describe.skipIf(!url)('expunge privileges (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const schema = `fhir_expunge_priv_${process.pid}`;
  const role = `fhir_test_expunge_${process.pid}`;
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    await pool.end();
  });

  /** Runs every query as the restricted role. */
  const asRole = (): Database => {
    const inTx = async <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE "${role}"`);
        const result = await fn({ query: (sql, params) => client.query(sql, params) as never });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    };
    return { query: (sql, params) => inTx((tx) => tx.query(sql, params)), transaction: inTx };
  };

  it('keeps DELETE off the runtime role: expunge runs on its own storage with a privileged role', async () => {
    const config = { fhir: r4, resources: ['Patient'] as const, authorize: 'allow-all' as const };
    await createFhirStore({ ...config, storage: postgresStorage(pool, { schema }) }).migrate();
    const s = `"${schema}"`;
    const index = ['string', 'token', 'date', 'reference', 'number', 'quantity', 'uri', 'blind'].map((k) => `${s}."Patient_${k}"`).join(', ');
    for (const sql of [
      `CREATE ROLE "${role}" NOLOGIN`,
      `GRANT USAGE ON SCHEMA ${s} TO "${role}"`,
      `GRANT SELECT, INSERT, UPDATE ON ${s}."Patient", ${s}."Patient_history" TO "${role}"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${index} TO "${role}"`,
    ]) {
      await pool.query(sql);
    }
    // Expunge on the runtime storage: the runtime role has no DELETE, so it's refused and nothing is removed.
    const runtimeOnly = createFhirStore({ ...config, storage: postgresStorage(asRole(), { schema }), expunge: {} });
    const p = await runtimeOnly.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
    await expect(runtimeOnly.expunge('Patient', p.id, { reason: 'test erasure' })).rejects.toThrow(/permission denied/);
    expect((await runtimeOnly.read('Patient', p.id)).id).toBe(p.id);

    // Expunge on its own storage (here the owner pool, in production a role with DELETE on resource
    // and history tables): it works, while every other operation still runs as the runtime role.
    const runtime = createFhirStore({ ...config, storage: postgresStorage(asRole(), { schema }), expunge: { storage: postgresStorage(pool, { schema }) } });
    await runtime.expunge('Patient', p.id, { reason: 'test erasure' });
    const { rows } = await pool.query(`SELECT (SELECT count(*) FROM ${s}."Patient_history")::int AS h, (SELECT count(*) FROM ${s}."Patient_string")::int AS i`);
    expect(rows[0]).toEqual({ h: 0, i: 0 });
  });
});

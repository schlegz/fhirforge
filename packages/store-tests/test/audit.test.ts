import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, FhirError, type AuthorizeRequest, type StoreAuditEvent } from '@fhirforge/core';
import { migrationSql, postgresStorage, type Database, type SqlClient } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Synthetic data only (see CLAUDE.md).
interface Session {
  userId: string;
}

interface AuditRowRecord {
  operation_id: string;
  actor: string | null;
  system: boolean;
  reason: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  version_id: string | null;
  outcome: string;
  status: number | null;
  params: string[] | null;
  result_ids: string[] | null;
  entries: number | null;
}

async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

describe('built-in audit table (PGlite)', () => {
  const db = new PGlite();
  let n = 0;
  let schema: string;
  let events: StoreAuditEvent<Session>[];
  let policy: (req: AuthorizeRequest<Session>) => boolean;
  const makeStore = () =>
    createFhirStore({
      storage: pgliteStorage(db, { schema }),
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: (req: AuthorizeRequest<Session>) => policy(req),
      audit: { table: true, actor: (ctx: Session) => ctx.userId },
      onAudit: (e) => {
        events.push(e);
      },
    });
  let store: ReturnType<typeof makeStore>;
  const user = () => store.as({ userId: 'user-1' });
  const rows = async () =>
    (await db.query<AuditRowRecord>(`SELECT * FROM "${schema}"."_audit" ORDER BY seq`)).rows.map((r) => ({
      ...r,
      version_id: r.version_id === null ? null : String(r.version_id),
    }));

  beforeEach(async () => {
    schema = `fhir_audit_${n++}`;
    events = [];
    policy = () => true;
    store = makeStore();
    await store.migrate();
  });
  afterAll(() => db.close());

  it('is off unless configured, and needs an actor mapping when on', async () => {
    const plain = createFhirStore({ storage: pgliteStorage(db, { schema: 'fhir_no_audit' }), fhir: r4, resources: ['Patient'], authorize: 'allow-all' });
    expect((await plain.migrate()).applied).not.toContain('audit:1');
    const { rows: tables } = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'fhir_no_audit' AND table_name = '_audit'`);
    expect(tables).toHaveLength(0);
    expect(() =>
      createFhirStore({ storage: pgliteStorage(db), fhir: r4, resources: ['Patient'], authorize: 'allow-all', audit: { table: true } as never }),
    ).toThrow(/audit\.actor/);
    expect(migrationSql(['Patient'], { audit: true })).toContain('"_audit_no_update_delete"');
  });

  it('records writes with their version, reads, searches and failures, without content or values', async () => {
    const p = await user().create({ resourceType: 'Patient', name: [{ family: 'Synthetic-Doe' }], birthDate: '1974-12-25' });
    await user().update({ ...p, active: true });
    await user().read('Patient', p.id);
    await user().search('Patient', { family: 'Synthetic-Doe' });
    await fhirError(() => user().read('Patient', 'missing'));
    policy = (req) => req.action !== 'delete';
    await fhirError(() => user().delete('Patient', p.id));
    policy = () => true;
    await user().delete('Patient', p.id);
    await store.asSystem('nightly import').create({ resourceType: 'Patient' });

    const r = await rows();
    expect(r.map((x) => [x.action, x.resource_id === p.id ? 'p' : x.resource_id, x.version_id, x.outcome, x.status])).toEqual([
      ['create', 'p', '1', 'success', null],
      ['update', 'p', '2', 'success', null],
      ['read', 'p', '2', 'success', null],
      ['search', null, null, 'success', null],
      ['read', 'missing', null, 'not-found', 404],
      ['delete', 'p', null, 'not-found', 404], // a denied delete is hidden as 404
      ['delete', 'p', '3', 'success', null],
      ['create', r[7]!.resource_id, '1', 'success', null],
    ]);
    expect(r[0]!.actor).toBe('user-1');
    expect(r[3]!.params).toEqual(['family']);
    expect(r[3]!.result_ids).toEqual([p.id]);
    expect([r[7]!.actor, r[7]!.system, r[7]!.reason]).toEqual([null, true, 'nightly import']);
    expect(JSON.stringify(r)).not.toMatch(/Synthetic|1974/);
    // Each single operation has its own operation id, and onAudit sees the same events.
    expect(new Set(r.map((x) => x.operation_id)).size).toBe(r.length);
    expect(events.map((e) => e.operationId)).toEqual(r.map((x) => x.operation_id));
  });

  it('writes a change and its audit row together: no audit row, no change', async () => {
    await db.query(`DROP TABLE "${schema}"."_audit"`); // the audit store is gone
    await expect(user().create({ resourceType: 'Patient' })).rejects.toThrow();
    const { rows: count } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${schema}"."Patient"`);
    expect(count[0]!.n).toBe(0);
  });

  it('fails a read whose audit row cannot be written, and reports both errors for a failed operation', async () => {
    const p = await user().create({ resourceType: 'Patient' });
    await db.query(`DROP TABLE "${schema}"."_audit"`);
    await expect(user().read('Patient', p.id)).rejects.not.toBeInstanceOf(FhirError);
    const both = await user()
      .read('Patient', 'missing')
      .catch((e: unknown) => e);
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors[1]).toBeInstanceOf(FhirError);
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    await user().create({ resourceType: 'Patient' });
    for (const sql of [
      `UPDATE "${schema}"."_audit" SET actor = 'someone-else'`,
      `DELETE FROM "${schema}"."_audit"`,
      `TRUNCATE "${schema}"."_audit"`,
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/append-only/);
    }
    expect(await rows()).toHaveLength(1);
  });

  it('groups a transaction: entry rows and the Bundle row in one operation, committed with the data', async () => {
    const res = await user().transaction({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { fullUrl: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01', resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
        {
          resource: { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01' } } as never,
          request: { method: 'POST', url: 'Observation' },
        },
        { request: { method: 'DELETE', url: 'Patient/never-existed' } },
        { request: { method: 'GET', url: 'Patient?_count=1' } },
      ],
    });
    const r = await rows();
    expect(r.map((x) => [x.action, x.resource_type, x.version_id, x.outcome, x.entries])).toEqual([
      ['create', 'Patient', '1', 'success', null],
      ['create', 'Observation', '1', 'success', null],
      ['delete', 'Patient', null, 'success', null],
      ['transaction', 'Bundle', null, 'success', 4],
      ['search', 'Patient', null, 'success', null], // GET entries run after the commit
    ]);
    expect(r[0]!.resource_id).toBe(res.entry[0]!.resource!.id);
    expect(new Set(r.map((x) => x.operation_id)).size).toBe(1);
    expect(events.map((e) => e.operationId)).toEqual(r.map((x) => x.operation_id));
  });

  it('records a failed transaction as failed rows, with nothing written', async () => {
    policy = (req) => req.resourceType !== 'Observation';
    await fhirError(() =>
      user().transaction({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          { resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
          { resource: { resourceType: 'Observation', status: 'final', code: { text: 'hr' } } as never, request: { method: 'POST', url: 'Observation' } },
        ],
      }),
    );
    const r = await rows();
    expect(r.map((x) => [x.action, x.outcome, x.status])).toEqual([
      ['create', 'error', 403],
      ['create', 'denied', 403],
      ['transaction', 'denied', 403],
    ]);
    expect(new Set(r.map((x) => x.operation_id)).size).toBe(1);
  });
});

/** Runs every query as a restricted role (SET LOCAL ROLE inside a transaction). */
function asRole(pool: pg.Pool, role: string): Database {
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
}

const url = process.env.FHIRFORGE_TEST_DATABASE_URL;

describe.skipIf(!url)('audit table privileges (Postgres)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const schema = `fhir_audit_priv_${process.pid}`;
  const role = `fhir_test_runtime_${process.pid}`;
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS "${role}"`);
    await pool.end();
  });

  it('works for a runtime role with only the documented grants, which cannot read or change audit rows', async () => {
    const config = { fhir: r4, resources: ['Patient'] as const, authorize: 'allow-all' as const, audit: { table: true as const, actor: () => 'svc' } };
    await createFhirStore({ ...config, storage: postgresStorage(pool, { schema }) }).migrate();

    // The grants README > Storage layout documents for the runtime role.
    const s = `"${schema}"`;
    for (const sql of [
      `CREATE ROLE "${role}" NOLOGIN`,
      `GRANT USAGE ON SCHEMA ${s} TO "${role}"`,
      `GRANT SELECT, INSERT, UPDATE ON ${s}."Patient", ${s}."Patient_history" TO "${role}"`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${['string', 'token', 'date', 'reference', 'number', 'quantity', 'uri', 'blind'].map((k) => `${s}."Patient_${k}"`).join(', ')} TO "${role}"`,
      `GRANT INSERT ON ${s}."_audit" TO "${role}"`,
    ]) {
      await pool.query(sql);
    }

    const runtime = createFhirStore({ ...config, storage: postgresStorage(asRole(pool, role), { schema }) });
    const p = await runtime.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
    await runtime.update({ ...p, active: true });
    await runtime.search('Patient', { family: 'doe' });
    await runtime.delete('Patient', p.id);

    const audited = asRole(pool, role);
    await expect(audited.query(`SELECT * FROM ${s}."_audit"`)).rejects.toThrow(/permission denied/);
    await expect(audited.query(`DELETE FROM ${s}."_audit"`)).rejects.toThrow(/permission denied/);
    const { rows } = await pool.query(`SELECT action FROM ${s}."_audit" ORDER BY seq`);
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'search', 'delete']);
  });
});

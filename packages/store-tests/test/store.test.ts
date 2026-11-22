import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, FhirError, type FhirStorage } from '@fhirforge/core';
import { migrationSql } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

const makeStore = (storage: FhirStorage) =>
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient', 'Observation'] });

/** Runs `fn` and returns the FhirError it throws. */
async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

describe.each(backends)('createFhirStore on $name', (backend) => {
  let fhir: ReturnType<typeof makeStore>;

  beforeEach(async () => {
    fhir = makeStore(await backend.storage());
    await fhir.migrate();
  });
  afterAll(() => backend.close());

  it('migrates once and is then up to date', async () => {
    const storage = await backend.storage();
    const store = makeStore(storage);
    const first = await store.migrate();
    expect(first.applied).toEqual([
      'resource:Observation:1',
      'resource:Observation:2',
      'resource:Patient:1',
      'resource:Patient:2',
    ]);
    expect(first.reindexed).toEqual({ Observation: 0, Patient: 0 });
    expect(await store.migrate()).toEqual({ applied: [] });
  });

  it('serializes concurrent migrations (several instances starting at once)', async () => {
    const storage = await backend.storage();
    const results = await Promise.all([makeStore(storage).migrate(), makeStore(storage).migrate(), makeStore(storage).migrate()]);
    expect(results.flatMap((r) => r.applied).sort()).toEqual([
      'resource:Observation:1',
      'resource:Observation:2',
      'resource:Patient:1',
      'resource:Patient:2',
    ]);
  });

  it('creates and reads a Patient', async () => {
    const created = await fhir.create({
      resourceType: 'Patient',
      id: 'client-chosen-id-is-ignored',
      name: [{ family: 'Doe', given: ['Jane'] }],
      gender: 'female',
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.meta.versionId).toBe('1');
    expect(new Date(created.meta.lastUpdated).toISOString()).toBe(created.meta.lastUpdated);

    const read = await fhir.read('Patient', created.id);
    expect(read).toEqual(created);
    expect(read.name?.[0]?.family).toBe('Doe');
  });

  it('keeps other meta fields the client sent', async () => {
    const created = await fhir.create({
      resourceType: 'Patient',
      meta: { tag: [{ system: 'urn:test', code: 'demo' }], versionId: '99' },
    });
    expect(created.meta.versionId).toBe('1');
    expect(created.meta.tag).toEqual([{ system: 'urn:test', code: 'demo' }]);
  });

  it('updates with a new version and keeps history', async () => {
    const v1 = await fhir.create({ resourceType: 'Patient', active: true });
    const v2 = await fhir.update({ ...v1, active: false });
    expect(v2.meta.versionId).toBe('2');
    expect((await fhir.read('Patient', v1.id)).active).toBe(false);
    expect((await fhir.vread('Patient', v1.id, '1')).active).toBe(true);

    const history = await fhir.history('Patient', v1.id);
    expect(history.map((h) => h.versionId)).toEqual(['2', '1']);
    expect(history[0]!.resource).toEqual(v2);
  });

  it('rejects a stale ifMatch with 412 and accepts a current one (bare or ETag)', async () => {
    const v1 = await fhir.create({ resourceType: 'Patient' });
    await fhir.update({ ...v1, active: true }, { ifMatch: '1' });

    const stale = await fhirError(() => fhir.update({ ...v1, active: false }, { ifMatch: '1' }));
    expect(stale.status).toBe(412);
    expect(stale.outcome.issue[0]!.code).toBe('conflict');

    const v3 = await fhir.update({ ...v1, active: false }, { ifMatch: 'W/"2"' });
    expect(v3.meta.versionId).toBe('3');
  });

  it('lets only one of two concurrent updates with the same ifMatch win', async () => {
    const v1 = await fhir.create({ resourceType: 'Patient' });
    const results = await Promise.allSettled([
      fhir.update({ ...v1, gender: 'male' }, { ifMatch: '1' }),
      fhir.update({ ...v1, gender: 'female' }, { ifMatch: '1' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as FhirError).status).toBe(412);
    expect((await fhir.read('Patient', v1.id)).meta.versionId).toBe('2');
  });

  it('creates on update when the id is new (client-assigned id)', async () => {
    const p = await fhir.update({ resourceType: 'Patient', id: 'mrn-12345', active: true });
    expect(p.id).toBe('mrn-12345');
    expect(p.meta.versionId).toBe('1');
    const conflict = await fhirError(() => fhir.update({ resourceType: 'Patient', id: 'mrn-999' }, { ifMatch: '1' }));
    expect(conflict.status).toBe(412);
  });

  it('deletes with 410 on read, keeps history, and can be recreated', async () => {
    const v1 = await fhir.create({ resourceType: 'Patient' });
    await fhir.delete('Patient', v1.id);
    expect((await fhirError(() => fhir.read('Patient', v1.id))).status).toBe(410);
    await fhir.delete('Patient', v1.id); // idempotent

    const history = await fhir.history('Patient', v1.id);
    expect(history.map((h) => [h.versionId, h.deleted])).toEqual([
      ['2', true],
      ['1', false],
    ]);
    expect(history[0]!.resource).toBeUndefined();
    expect((await fhirError(() => fhir.vread('Patient', v1.id, '2'))).status).toBe(410);

    const v3 = await fhir.update({ resourceType: 'Patient', id: v1.id, active: true });
    expect(v3.meta.versionId).toBe('3');
  });

  it('returns 404 for unknown resources and versions', async () => {
    expect((await fhirError(() => fhir.read('Patient', 'nope'))).status).toBe(404);
    expect((await fhirError(() => fhir.history('Patient', 'nope'))).status).toBe(404);
    const p = await fhir.create({ resourceType: 'Patient' });
    expect((await fhirError(() => fhir.vread('Patient', p.id, '7'))).status).toBe(404);
    expect((await fhirError(() => fhir.vread('Patient', p.id, 'abc'))).status).toBe(404);
  });

  it('rejects invalid ids and resource types it does not manage', async () => {
    expect((await fhirError(() => fhir.read('Patient', 'bad id!'))).status).toBe(400);
    const wrongType = await fhirError(() => fhir.read('Encounter' as 'Patient', 'x'));
    expect(wrongType.status).toBe(400);
    expect(wrongType.code).toBe('not-supported');
  });

  it('keeps resource types in separate tables', async () => {
    const p = await fhir.create({ resourceType: 'Patient' });
    const o = await fhir.create({
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Heart rate' },
      subject: { reference: `Patient/${p.id}` },
      valueQuantity: { value: 72, unit: 'beats/minute' },
    });
    expect((await fhir.read('Observation', o.id)).valueQuantity?.value).toBe(72);
    expect((await fhirError(() => fhir.read('Patient', o.id))).status).toBe(404);
  });

  describe('validation', () => {
    // Untyped input, as it would arrive from JSON (TypeScript would reject these at compile time).
    const untyped = <T>(resource: unknown) => resource as T;

    it('rejects an invalid create with 400, an issue per problem (paths only), and writes nothing', async () => {
      const before = (await fhir.search('Patient', {})).total;
      const err = await fhirError(() =>
        fhir.create(untyped({ resourceType: 'Patient', birthDate: 'Synthetic-1974', gender: 'Synthetic-x', nickname: 'Jo' })),
      );
      expect(err.status).toBe(400);
      expect(err.code).toBe('invalid');
      expect(err.message).toBe('Invalid Patient: Patient.birthDate is not a valid date (YYYY, YYYY-MM or YYYY-MM-DD) (and 2 more)');
      expect(err.outcome.issue.map((i) => i.expression)).toEqual([['Patient.birthDate'], ['Patient.gender'], ['Patient.nickname']]);
      expect(err.outcome.issue.every((i) => i.severity === 'error' && i.code === 'invalid')).toBe(true);
      expect(JSON.stringify(err.outcome) + err.message).not.toMatch(/Synthetic|Jo"/);
      expect((await fhir.search('Patient', {})).total).toBe(before);
    });

    it('ignores the id on create (it is replaced), but validates everything else', async () => {
      const created = await fhir.create(untyped({ resourceType: 'Patient', id: 'not a valid id!' }));
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rejects an invalid update and keeps the stored version', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      const err = await fhirError(() => fhir.update(untyped({ ...p, name: { family: 'Doe' } })));
      expect(err.status).toBe(400);
      expect(err.outcome.issue[0]!.expression).toEqual(['Patient.name']);
      const read = await fhir.read('Patient', p.id);
      expect(read.meta.versionId).toBe('1');
      // Update-as-create is validated too.
      const created = await fhirError(() => fhir.update(untyped({ resourceType: 'Observation', id: 'obs-new', status: 'final' })));
      expect(created.outcome.issue[0]!.expression).toEqual(['Observation.code']);
      expect((await fhirError(() => fhir.read('Observation', 'obs-new'))).status).toBe(404);
    });

    it('rejects a hostile value as invalid rather than passing it on', async () => {
      const err = await fhirError(() => fhir.create(untyped({ resourceType: 'Patient', birthDate: "1974'); DROP TABLE x; --" })));
      expect(err.status).toBe(400);
      expect(err.message).not.toContain('DROP');
    });

    it('requires validation rules in the version package', () => {
      expect(() =>
        createFhirStore({
          authorize: 'allow-all',
          storage: {} as FhirStorage,
          fhir: { fhirVersion: r4.fhirVersion, searchParameters: r4.searchParameters },
          resources: ['Patient'] as never[],
        }),
      ).toThrow(/no validation rules/);
    });
  });
});

describe('postgres storage details', () => {
  it('explains a missing migration instead of a raw SQL error', async () => {
    const db = new PGlite();
    const store = makeStore(pgliteStorage(db));
    await expect(store.read('Patient', 'x')).rejects.toThrow(/Run store\.migrate\(\) first/);
    await db.close();
  });

  it('uses a custom schema', async () => {
    const db = new PGlite();
    const store = makeStore(pgliteStorage(db, { schema: 'clinical' }));
    await store.migrate();
    const p = await store.create({ resourceType: 'Patient' });
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM clinical."Patient"');
    expect(rows[0]!.n).toBe(1);
    expect((await store.read('Patient', p.id)).id).toBe(p.id);
    await db.close();
  });

  it('emits plain SQL for external migration tools', () => {
    const sql = migrationSql(['Patient']);
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "fhir"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "fhir"."Patient_history"');
    expect(sql).toContain(`INSERT INTO "fhir"."_migrations" (id) VALUES ('resource:Patient:1')`);
  });
});

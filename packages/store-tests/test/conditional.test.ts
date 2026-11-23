import { createFhirStore, FhirError, type AuthorizeRequest, type AuthorizeResult, type FhirStorage, type StoreAuditEvent } from '@fhirforge/core';
import { r4, type Patient } from '@fhirforge/r4';
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

const MRN = 'urn:oid:1.2.36.1.2001.1003.0';
const patient = (value: string, extra: Record<string, unknown> = {}): Patient & { resourceType: 'Patient' } =>
  ({ resourceType: 'Patient', identifier: [{ system: MRN, value }], ...extra }) as Patient & { resourceType: 'Patient' };

describe.each(backends)('conditional operations on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<unknown>[];
  let policy: (req: AuthorizeRequest<unknown>) => AuthorizeResult | Promise<AuthorizeResult>;
  const makeStore = () =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: (req: AuthorizeRequest<unknown>) => policy(req),
      onAudit: (e) => {
        events.push(e);
      },
    });
  let fhir: ReturnType<typeof makeStore>;
  const user = () => fhir.as({});
  const count = async (value: string) => (await fhir.asSystem('test').search('Patient', { identifier: `${MRN}|${value}` })).total;

  beforeEach(async () => {
    storage = await backend.storage();
    events = [];
    policy = () => true;
    fhir = makeStore();
    await fhir.migrate();
  });
  afterAll(() => backend.close());

  describe('conditionalCreate', () => {
    it('creates when nothing matches, returns the match otherwise, and refuses several', async () => {
      const first = await user().conditionalCreate(patient('A1', { gender: 'female' }), { identifier: `${MRN}|A1` });
      expect(first.created).toBe(true);
      const again = await user().conditionalCreate(patient('A1', { gender: 'male' }), `identifier=${encodeURIComponent(`${MRN}|A1`)}`);
      expect([again.created, again.resource.id, again.resource.gender]).toEqual([false, first.resource.id, 'female']);
      expect(await count('A1')).toBe(1);

      await user().create(patient('A1'));
      const err = await fhirError(() => user().conditionalCreate(patient('A1'), { identifier: `${MRN}|A1` }));
      expect([err.status, err.code, err.message]).toEqual([412, 'multiple-matches', 'The condition matches more than one Patient']);
      expect(await count('A1')).toBe(2);
    });

    it('lets only one of several concurrent conditional creates write', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => user().conditionalCreate(patient('RACE'), { identifier: `${MRN}|RACE` })),
      );
      expect(await count('RACE')).toBe(1);
      for (const r of results) {
        if (r.status === 'rejected') expect((r.reason as FhirError).status).toBe(412); // lost the race: retry returns the winner
        else if (!r.value.created) expect(r.value.resource.identifier?.[0]?.value).toBe('RACE');
      }
      expect(results.filter((r) => r.status === 'fulfilled' && r.value.created)).toHaveLength(1);
    });

    it('re-checks the condition when writing: a match created meanwhile makes it 412', async () => {
      let raced = false;
      policy = async (req) => {
        if (req.action === 'create' && !raced) {
          raced = true;
          await fhir.asSystem('race').create(patient('LATE'));
        }
        return true;
      };
      const err = await fhirError(() => user().conditionalCreate(patient('LATE'), { identifier: `${MRN}|LATE` }));
      expect(err.status).toBe(412);
      expect(await count('LATE')).toBe(1);
      // A retry is idempotent: it returns the resource created meanwhile.
      expect((await user().conditionalCreate(patient('LATE'), { identifier: `${MRN}|LATE` })).created).toBe(false);
    });

    it('searches as the caller: a match the caller may not see does not count', async () => {
      await fhir.asSystem('fixture').create(patient('HIDDEN', { active: false }));
      policy = (req) => (req.action === 'search' ? { filter: { active: 'true' } } : true);
      const res = await user().conditionalCreate(patient('HIDDEN', { active: true }), { identifier: `${MRN}|HIDDEN` });
      expect(res.created).toBe(true);
      expect(await count('HIDDEN')).toBe(2);
    });

    it('rejects conditions it cannot use', async () => {
      for (const condition of [{}, '', { _count: 1, identifier: 'x' }, { _sort: 'family' }, { 'general-practitioner.name': 'x' }, { _include: 'Patient:link' }, { family: Array.from({ length: 11 }, (_, i) => `f${i}`) }]) {
        const err = await fhirError(() => user().conditionalCreate(patient('X'), condition as never));
        expect(err.status, JSON.stringify(condition)).toBe(400);
      }
      const unknown = await fhirError(() => user().conditionalCreate(patient('X'), { 'Synthetic-Secret': 'Synthetic-Value' }));
      expect(unknown.message).not.toContain('Synthetic-Value');
    });

    it('audits the condition search and the create, with parameter names only', async () => {
      events = [];
      await user().conditionalCreate(patient('AUD'), { identifier: `${MRN}|AUD` });
      expect(events.map((e) => [e.action, e.outcome, e.params])).toEqual([
        ['search', 'success', ['identifier', '_count']],
        ['create', 'success', ['identifier']],
      ]);
      expect(JSON.stringify(events)).not.toContain('AUD');
    });
  });

  describe('conditionalUpdate', () => {
    it('updates the one match, creates with no match, and refuses several', async () => {
      const created = await user().conditionalUpdate('Patient', { identifier: `${MRN}|U1` }, patient('U1', { active: true }));
      expect(created.created).toBe(true);
      expect(created.resource.id).toMatch(/^[0-9a-f-]{36}$/);
      const updated = await user().conditionalUpdate('Patient', { identifier: `${MRN}|U1` }, patient('U1', { active: false }));
      expect([updated.created, updated.resource.id, updated.resource.meta.versionId, updated.resource.active]).toEqual([false, created.resource.id, '2', false]);

      const withId = await user().conditionalUpdate('Patient', { identifier: `${MRN}|U2` }, patient('U2', { id: 'client-u2' }));
      expect([withId.created, withId.resource.id]).toEqual([true, 'client-u2']);

      await user().create(patient('U1'));
      expect((await fhirError(() => user().conditionalUpdate('Patient', { identifier: `${MRN}|U1` }, patient('U1')))).status).toBe(412);
    });

    it("rejects a body id that isn't the match, and won't overwrite a resource that doesn't match", async () => {
      await user().conditionalUpdate('Patient', { identifier: `${MRN}|U3` }, patient('U3'));
      const mismatch = await fhirError(() => user().conditionalUpdate('Patient', { identifier: `${MRN}|U3` }, patient('U3', { id: 'other' })));
      expect([mismatch.status, mismatch.message]).toEqual([400, 'Resource id does not match the resource the condition matched']);

      await user().update({ resourceType: 'Patient', id: 'taken' });
      const taken = await fhirError(() => user().conditionalUpdate('Patient', { identifier: `${MRN}|NEW` }, patient('NEW', { id: 'taken' })));
      expect(taken.status).toBe(412);
      expect((await user().read('Patient', 'taken')).identifier).toBeUndefined();
    });

    it('honors ifMatch on the matched resource', async () => {
      const { resource } = await user().conditionalUpdate('Patient', { identifier: `${MRN}|U4` }, patient('U4'));
      expect((await fhirError(() => user().conditionalUpdate('Patient', { identifier: `${MRN}|U4` }, patient('U4'), { ifMatch: '9' }))).status).toBe(412);
      expect((await user().conditionalUpdate('Patient', { identifier: `${MRN}|U4` }, patient('U4'), { ifMatch: resource.meta.versionId })).resource.meta.versionId).toBe('2');
    });
  });

  describe('in Bundles', () => {
    const uuid = 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01';
    const obs = { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: uuid } };

    it('resolves a transaction\'s conditional create to the existing resource, and its references with it', async () => {
      const existing = await user().create(patient('B1'));
      const res = await user().transaction({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          { fullUrl: uuid, resource: patient('B1') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${MRN}|B1` } },
          { resource: obs as never, request: { method: 'POST', url: 'Observation' } },
        ],
      });
      expect(res.entry.map((e) => e.response.status)).toEqual(['200 OK', '201 Created']);
      expect(res.entry[0]!.resource!.id).toBe(existing.id);
      expect((res.entry[1]!.resource as unknown as { subject: { reference: string } }).subject.reference).toBe(`Patient/${existing.id}`);
      expect(await count('B1')).toBe(1);
    });

    it('runs conditional PUT and DELETE entries, and rolls everything back when a condition fails', async () => {
      await user().create(patient('B2'));
      await user().create(patient('B3'));
      const res = await user().transaction({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          { resource: patient('B2', { active: true }) as never, request: { method: 'PUT', url: `Patient?identifier=${encodeURIComponent(`${MRN}|B2`)}` } },
          { resource: patient('B4') as never, request: { method: 'PUT', url: `Patient?identifier=${MRN}|B4` } },
          { request: { method: 'DELETE', url: `Patient?identifier=${MRN}|B3` } },
          { request: { method: 'DELETE', url: `Patient?identifier=${MRN}|NONE` } },
        ],
      });
      expect(res.entry.map((e) => e.response.status)).toEqual(['200 OK', '201 Created', '204 No Content', '204 No Content']);
      expect([await count('B2'), await count('B3'), await count('B4')]).toEqual([1, 0, 1]);

      await user().create(patient('B5'));
      await user().create(patient('B5'));
      const err = await fhirError(() =>
        user().transaction({
          resourceType: 'Bundle',
          type: 'transaction',
          entry: [
            { resource: patient('B6') as never, request: { method: 'POST', url: 'Patient' } },
            { resource: patient('B5') as never, request: { method: 'PUT', url: `Patient?identifier=${MRN}|B5` } },
          ],
        }),
      );
      expect([err.status, err.message]).toEqual([412, 'entry[1]: The condition matches more than one Patient']);
      expect(await count('B6')).toBe(0);
    });

    it('rejects two entries with the same condition', async () => {
      const err = await fhirError(() =>
        user().transaction({
          resourceType: 'Bundle',
          type: 'transaction',
          entry: [
            { resource: patient('B7') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${MRN}|B7` } },
            { resource: patient('B7') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${MRN}|B7` } },
          ],
        }),
      );
      expect([err.status, err.message]).toEqual([400, 'entry[1]: Two entries use the same condition']);
    });

    it('runs conditional entries in a batch independently', async () => {
      await user().create(patient('B8'));
      const res = await user().batch({
        resourceType: 'Bundle',
        type: 'batch',
        entry: [
          { resource: patient('B8') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${MRN}|B8` } },
          { resource: patient('B9') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${MRN}|B9` } },
          { resource: patient('B9', { active: true }) as never, request: { method: 'PUT', url: `Patient?identifier=${MRN}|B9` } },
          { request: { method: 'DELETE', url: `Patient?identifier=${MRN}|B8` } },
        ],
      });
      expect(res.entry.map((e) => e.response.status)).toEqual(['200 OK', '201 Created', '200 OK', '204 No Content']);
      expect([await count('B8'), await count('B9')]).toEqual([0, 1]);
    });
  });

  describe('conditionalDelete', () => {
    it('deletes the one match, does nothing without one, and refuses several', async () => {
      expect(await user().conditionalDelete('Patient', { identifier: `${MRN}|D1` })).toEqual({ deleted: false });
      const p = await user().create(patient('D1'));
      expect(await user().conditionalDelete('Patient', { identifier: `${MRN}|D1` })).toEqual({ deleted: true });
      expect((await fhirError(() => user().read('Patient', p.id))).status).toBe(410);

      await user().create(patient('D2'));
      await user().create(patient('D2'));
      expect((await fhirError(() => user().conditionalDelete('Patient', { identifier: `${MRN}|D2` }))).status).toBe(412);
      expect(await count('D2')).toBe(2);
    });
  });
});

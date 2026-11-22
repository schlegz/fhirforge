import { createFhirStore, FhirError, type AuthorizeRequest, type FhirStorage, type StoreAuditEvent } from '@fhirforge/core';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
interface Session {
  role: 'clinician' | 'patient';
  patientId?: string;
}

/** Patients may see and change only their own Patient record and Observations about them. Clinicians may do anything. */
function policy({ ctx, action, resourceType, resource }: AuthorizeRequest<Session>) {
  if (ctx.role === 'clinician') return true;
  if (action === 'search') {
    if (resourceType === 'Patient') return { filter: { _id: ctx.patientId! } };
    return { filter: { patient: ctx.patientId! } };
  }
  if (!resource) return false;
  if (resource.resourceType === 'Patient') return resource.id === ctx.patientId;
  const subject = (resource as { subject?: { reference?: string } }).subject?.reference;
  return subject === `Patient/${ctx.patientId}`;
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

describe.each(backends)('authorize and onAudit on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<Session>[];
  let authorize: (req: AuthorizeRequest<Session>) => unknown = policy;
  const makeStore = () =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: (req: AuthorizeRequest<Session>) => authorize(req) as never,
      onAudit: (e) => {
        events.push(e);
      },
    });
  let fhir: ReturnType<typeof makeStore>;
  let jane: string;
  let john: string;
  let janeObs: string;
  let johnObs: string;
  const asJane = () => fhir.as({ role: 'patient', patientId: jane });
  const clinician = () => fhir.as({ role: 'clinician' });

  beforeAll(async () => {
    storage = await backend.storage();
    events = [];
    fhir = makeStore();
    await fhir.migrate();
    const system = fhir.asSystem('test fixtures');
    jane = (await system.create({ resourceType: 'Patient', name: [{ family: 'Synthetic-Jane' }] })).id;
    john = (await system.create({ resourceType: 'Patient', name: [{ family: 'Synthetic-John' }] })).id;
    janeObs = (await system.create({ resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: `Patient/${jane}` } })).id;
    johnObs = (await system.create({ resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: `Patient/${john}` } })).id;
  });
  beforeEach(() => {
    events = [];
    authorize = policy;
  });
  afterAll(() => backend.close());

  describe('scopes', () => {
    it('refuses unscoped calls when a policy is configured', async () => {
      const err = await fhirError(() => fhir.read('Patient', jane));
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/store\.as\(ctx\)/);
    });

    it('requires authorize at creation and a reason for asSystem', () => {
      expect(() => createFhirStore({ storage, fhir: r4, resources: ['Patient'] } as never)).toThrow(/authorize/);
      expect(() => fhir.asSystem('')).toThrow(/reason/);
    });

    it('lets asSystem bypass the policy and audits it as system with the reason', async () => {
      authorize = () => false;
      await fhir.asSystem('nightly export').read('Patient', john);
      expect(events).toEqual([
        expect.objectContaining({ action: 'read', id: john, outcome: 'success', system: true, reason: 'nightly export', ctx: undefined }),
      ]);
    });
  });

  describe('reads', () => {
    it('hides what the caller may not see as 404, indistinguishable from missing', async () => {
      expect((await asJane().read('Patient', jane)).id).toBe(jane);
      const hidden = await fhirError(() => asJane().read('Patient', john));
      const missing = await fhirError(() => asJane().read('Patient', 'does-not-exist'));
      expect([hidden.status, hidden.code]).toEqual([404, 'not-found']);
      expect(hidden.message.replace(john, 'X')).toBe(missing.message.replace('does-not-exist', 'X'));
      expect((await fhirError(() => asJane().vread('Patient', john, '1'))).status).toBe(404);
      expect((await fhirError(() => asJane().history('Patient', john))).status).toBe(404);
      expect((await fhirError(() => asJane().read('Observation', johnObs))).status).toBe(404);
      expect((await asJane().read('Observation', janeObs)).id).toBe(janeObs);
    });

    it('denies when the policy throws or returns anything but true', async () => {
      for (const decision of [() => { throw new Error('policy bug'); }, () => 'yes', () => 1, () => undefined, () => ({})]) {
        authorize = decision;
        expect((await fhirError(() => fhir.as({ role: 'patient' }).read('Patient', jane))).status).toBe(404);
      }
    });
  });

  describe('writes', () => {
    it('rejects a denied create with 403 and writes nothing', async () => {
      const before = (await clinician().search('Patient', {})).total;
      const err = await fhirError(() => asJane().create({ resourceType: 'Patient', name: [{ family: 'Intruder' }] }));
      expect(err.status).toBe(403);
      expect((await clinician().search('Patient', {})).total).toBe(before);
    });

    it("checks both the stored version and the new content on update", async () => {
      const own = await asJane().read('Patient', jane);
      expect((await asJane().update({ ...own, active: true })).meta.versionId).toBe(String(Number(own.meta.versionId) + 1));

      // Someone else's record: hidden.
      const johns = await clinician().read('Patient', john);
      expect((await fhirError(() => asJane().update({ ...johns, active: false }))).status).toBe(404);

      // Own observation, but moving it to someone else: the new content is denied.
      const obs = await asJane().read('Observation', janeObs);
      const moved = await fhirError(() => asJane().update({ ...obs, subject: { reference: `Patient/${john}` } }));
      expect(moved.status).toBe(403);
      expect((await clinician().read('Observation', janeObs)).subject?.reference).toBe(`Patient/${jane}`);
    });

    it('writes against exactly the version the policy approved (412 if it changed in between)', async () => {
      const obs = await clinician().read('Observation', janeObs);
      let raced = false;
      authorize = async (req) => {
        if (req.action === 'update' && !raced) {
          raced = true; // a concurrent writer changes it while the policy is deciding
          await fhir.asSystem('race').update({ ...obs, status: 'amended' });
        }
        return true;
      };
      expect((await fhirError(() => clinician().update({ ...obs, status: 'cancelled' }))).status).toBe(412);
      expect((await clinician().read('Observation', janeObs)).status).toBe('amended');
    });

    it('does not let update-as-create overwrite a resource created while the policy decided', async () => {
      let raced = false;
      authorize = async (req) => {
        if (req.action === 'update' && !raced) {
          raced = true;
          await fhir.asSystem('race').update({ resourceType: 'Patient', id: 'race-target', name: [{ family: 'First' }] });
        }
        return true;
      };
      const err = await fhirError(() => clinician().update({ resourceType: 'Patient', id: 'race-target', name: [{ family: 'Second' }] }));
      expect(err.status).toBe(412);
      expect((await clinician().read('Patient', 'race-target')).name?.[0]?.family).toBe('First');
    });

    it('hides a denied delete as 404 and keeps the resource', async () => {
      expect((await fhirError(() => asJane().delete('Patient', john))).status).toBe(404);
      expect((await clinician().read('Patient', john)).id).toBe(john);
    });
  });

  describe('search', () => {
    it('applies policy filters, so results and totals stay exact', async () => {
      const obs = await asJane().search('Observation', {});
      expect(obs.resources.map((r) => r.id)).toEqual([janeObs]);
      expect(obs.total).toBe(1);
      const patients = await asJane().search('Patient', {});
      expect(patients.resources.map((r) => r.id)).toEqual([jane]);
      // The filter is ANDed: asking for John's data finds nothing.
      expect((await asJane().search('Observation', { patient: john })).resources).toEqual([]);
    });

    it('post-filters results the policy denies, and then omits the total', async () => {
      // A policy that allows the search but not every result.
      authorize = (req) => req.action === 'search' || req.resource?.id === jane;
      const result = await fhir.as({ role: 'patient', patientId: jane }).search('Patient', {});
      expect(result.resources.map((r) => r.id)).toEqual([jane]);
      expect(result.total).toBeUndefined();
    });

    it('rejects a denied search with 403, and filters may not change paging', async () => {
      authorize = () => false;
      expect((await fhirError(() => fhir.as({ role: 'patient' }).search('Patient', {}))).status).toBe(403);
      authorize = (req) => (req.action === 'search' ? { filter: { _count: 1000 } } : true);
      await expect(fhir.as({ role: 'patient' }).search('Patient', {})).rejects.toThrow(/can't set _count/);
    });
  });

  describe('audit', () => {
    it('records successes, denials and misses with the caller context', async () => {
      const ctx: Session = { role: 'patient', patientId: jane };
      await fhir.as(ctx).read('Patient', jane);
      await fhirError(() => fhir.as(ctx).read('Patient', john));
      await fhirError(() => fhir.as(ctx).create({ resourceType: 'Patient' }));
      expect(events.map((e) => [e.action, e.outcome, e.status, e.ctx])).toEqual([
        ['read', 'success', undefined, ctx],
        ['read', 'not-found', 404, ctx],
        ['create', 'denied', 403, ctx],
      ]);
      expect(events[0]!.versionId).toMatch(/^\d+$/);
      expect(new Date(events[0]!.recorded).toISOString()).toBe(events[0]!.recorded);
    });

    it('records search parameter names and returned ids, never values or content', async () => {
      await clinician().search('Patient', { family: 'synthetic', _count: 10 });
      const [event] = events;
      expect(event).toMatchObject({ action: 'search', params: ['family', '_count'], outcome: 'success' });
      expect(event!.ids!.sort()).toEqual([jane, john].sort());
      const all = JSON.stringify(events);
      expect(all).not.toContain('synthetic');
      expect(all).not.toContain('Synthetic-Jane');
    });

    it('withholds the result when the audit sink fails, unless onAuditError is set', async () => {
      const failing = createFhirStore({
        storage,
        fhir: r4,
        resources: ['Patient'],
        authorize: 'allow-all',
        onAudit: () => {
          throw new Error('audit log down');
        },
      });
      await expect(failing.read('Patient', jane)).rejects.toThrow(/audit failed/);

      const reported: unknown[] = [];
      const tolerant = createFhirStore({
        storage,
        fhir: r4,
        resources: ['Patient'],
        authorize: 'allow-all',
        onAudit: () => {
          throw new Error('audit log down');
        },
        onAuditError: (err) => reported.push(err),
      });
      expect((await tolerant.read('Patient', jane)).id).toBe(jane);
      expect(reported).toHaveLength(1);
    });
  });
});

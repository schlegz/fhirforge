import {
  createFhirStore,
  FhirError,
  MAX_CHAIN_MATCHES,
  MAX_INCLUDED,
  type AuthorizeRequest,
  type AuthorizeResult,
  type BundleInput,
  type FhirStorage,
  type StoreAuditEvent,
} from '@fhirforge/core';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
interface Session {
  hidePatient?: string;
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

describe.each(backends)('chained search and _include on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<Session>[];
  let policy: (req: AuthorizeRequest<Session>) => AuthorizeResult;
  const makeStore = () =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation', 'Practitioner'],
      authorize: (req: AuthorizeRequest<Session>) => policy(req),
      onAudit: (e) => {
        events.push(e);
      },
    });
  let fhir: ReturnType<typeof makeStore>;
  const ids: Record<string, string> = {};
  const name = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;
  const names = (rs: { id: string }[]) => rs.map((r) => name(r.id)).sort();
  /** Hides one patient from reads and searches, the way an app's policy would. */
  const hiding = (patient: string): ((req: AuthorizeRequest<Session>) => AuthorizeResult) => (req) =>
    !(req.resourceType === 'Patient' && req.resource?.id === ids[patient]);
  const caller = () => fhir.as({});

  beforeAll(async () => {
    storage = await backend.storage();
    events = [];
    policy = () => true;
    fhir = makeStore();
    await fhir.migrate();
    const system = fhir.asSystem('fixtures');
    const add = async (key: string, resource: Record<string, unknown>) => {
      ids[key] = (await system.create(resource as never)).id;
    };
    await add('jane', { resourceType: 'Patient', name: [{ family: 'Doe', given: ['Jane'] }], gender: 'female' });
    await add('john', { resourceType: 'Patient', name: [{ family: 'Doering', given: ['John'] }], gender: 'male' });
    await add('ann', { resourceType: 'Patient', name: [{ family: 'Smith', given: ['Ann'] }], gender: 'female' });
    await add('drx', { resourceType: 'Practitioner', name: [{ family: 'Xavier' }] });
    const obs = (subject: string, code: string, performer?: string) => ({
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code }] },
      subject: { reference: `Patient/${ids[subject]}` },
      ...(performer ? { performer: [{ reference: `Practitioner/${ids[performer]}` }] } : {}),
    });
    await add('jane-hr', obs('jane', '8867-4', 'drx'));
    await add('jane-bp', obs('jane', '85354-9'));
    await add('john-hr', obs('john', '8867-4', 'drx'));
    await add('ann-hr', obs('ann', '8867-4'));
  });
  beforeEach(() => {
    events = [];
    policy = () => true;
  });
  afterAll(() => backend.close());

  describe('chaining', () => {
    it('matches through a reference to the target type', async () => {
      expect(names((await caller().search('Observation', { 'subject.name': 'doe' })).resources)).toEqual(['jane-bp', 'jane-hr', 'john-hr']);
      expect(names((await caller().search('Observation', { 'subject:Patient.name:exact': 'Doe' })).resources)).toEqual(['jane-bp', 'jane-hr']);
      expect(names((await caller().search('Observation', { 'subject.gender': 'female', code: '8867-4' })).resources)).toEqual(['ann-hr', 'jane-hr']);
      expect(names((await caller().search('Observation', { 'performer:Practitioner.name': 'xavier' })).resources)).toEqual(['jane-hr', 'john-hr']);
      // Two chains on the same parameter are ANDed.
      expect(names((await caller().search('Observation', { 'subject.name': ['doe', 'jane'] })).resources)).toEqual(['jane-bp', 'jane-hr']);
      expect(await caller().search('Observation', { 'subject.name': 'nobody' })).toEqual({ resources: [], total: 0 });
    });

    it('only matches targets the caller may see, and audits the chained search', async () => {
      policy = hiding('jane');
      expect(names((await caller().search('Observation', { 'subject.name': 'doe' })).resources)).toEqual(['john-hr']);
      expect(events.map((e) => [e.action, e.resourceType, e.params])).toEqual([
        ['search', 'Patient', ['name', '_count']],
        ['search', 'Observation', ['subject.name']],
      ]);
      expect(JSON.stringify(events)).not.toContain('doe');
    });

    it('rejects chains it cannot answer exactly', async () => {
      const cases: [Record<string, string | string[]>, RegExp][] = [
        [{ 'performer.name': 'x' }, /Chained performer needs a target type/],
        [{ 'subject.organization.name': 'x' }, /deeper than one level/],
        [{ 'subject:Group.name': 'x' }, /Group is not managed/],
        [{ 'subject:Medication.code': 'x' }, /can't point to Medication/],
        [{ 'code.name': 'x' }, /not a reference parameter/],
        [{ 'subject._count': '5' }, /can't be used in a chain/],
        [{ 'subject.nonsense': 'x' }, /Unknown search parameter for Patient: nonsense/],
        [{ 'subject.name': ['a', 'b'], 'performer:Practitioner.name': ['c', 'd'] }, /Too many chained parameters/],
      ];
      for (const [params, message] of cases) {
        const err = await fhirError(() => caller().search('Observation', params));
        expect([err.status, err.message], JSON.stringify(params)).toEqual([400, expect.stringMatching(message)]);
      }
    });

    it(`refuses a chain that matches more than ${MAX_CHAIN_MATCHES} targets`, async () => {
      const many = (n: number): BundleInput => ({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: Array.from({ length: n }, () => ({ resource: { resourceType: 'Patient', name: [{ family: 'Broad' }] }, request: { method: 'POST', url: 'Patient' } })),
      });
      await fhir.asSystem('fixtures').transaction(many(100));
      expect((await caller().search('Observation', { 'subject.name': 'broad' })).resources).toEqual([]);
      await fhir.asSystem('fixtures').transaction(many(1));
      const err = await fhirError(() => caller().search('Observation', { 'subject.name': 'broad' }));
      expect(err.message).toMatch(/matches more than 100 Patient resources; narrow it/);
    });

    it("can't be set by a policy filter", async () => {
      policy = (req) => (req.action === 'search' ? { filter: { 'subject.name': 'doe' } } : true);
      await expect(caller().search('Observation', {})).rejects.toThrow(/can't use chains/);
    });
  });

  describe('_include and _revinclude', () => {
    it('includes what the results reference, once each', async () => {
      const res = await caller().search('Observation', { code: '8867-4', _include: 'Observation:subject' });
      expect(names(res.resources)).toEqual(['ann-hr', 'jane-hr', 'john-hr']);
      expect(names(res.included as { id: string }[])).toEqual(['ann', 'jane', 'john']);
      const both = await caller().search('Observation', { code: '8867-4', _include: ['Observation:subject', 'Observation:performer:Practitioner'] });
      expect(names(both.included as { id: string }[])).toEqual(['ann', 'drx', 'jane', 'john']);
      expect((await caller().search('Observation', { code: 'none', _include: 'Observation:subject' })).included).toEqual([]);
    });

    it('includes what references the results', async () => {
      const res = await caller().search('Patient', { family: 'doe', _revinclude: 'Observation:subject' });
      expect(names(res.resources)).toEqual(['jane', 'john']);
      expect(names(res.included as { id: string }[])).toEqual(['jane-bp', 'jane-hr', 'john-hr']);
    });

    it('leaves out included resources the caller may not read, and audits each read', async () => {
      policy = hiding('jane');
      const res = await caller().search('Observation', { code: '8867-4', _include: 'Observation:subject' });
      expect(names(res.resources)).toEqual(['ann-hr', 'jane-hr', 'john-hr']);
      expect(names(res.included as { id: string }[])).toEqual(['ann', 'john']);
      const reads = events.filter((e) => e.action === 'read');
      expect(reads.map((e) => [e.id && name(e.id), e.outcome])).toEqual(
        expect.arrayContaining([
          ['jane', 'not-found'],
          ['john', 'success'],
          ['ann', 'success'],
        ]),
      );
    });

    it('rejects include specs it cannot answer', async () => {
      const cases: [string, Record<string, string | string[]>, number, RegExp][] = [
        ['Observation', { _include: 'Patient:general-practitioner' }, 400, /_include must start with Observation/],
        ['Observation', { _include: 'Observation:code' }, 400, /not a reference parameter/],
        ['Observation', { _include: 'Observation:subject:Group' }, 400, /Group is not managed/],
        ['Observation', { '_include:iterate': 'Observation:subject' }, 400, /:iterate/],
        ['Observation', { _include: '*' }, 400, /=\* is not supported/],
        ['Observation', { _include: 'Observation' }, 400, /Type:parameter/],
        ['Patient', { _revinclude: 'Encounter:subject' }, 400, /Encounter is not managed/],
        ['Patient', { _revinclude: 'Observation:performer:Organization' }, 400, /target type must be Patient/],
        ['Observation', { _include: Array.from({ length: 6 }, () => 'Observation:subject') }, 400, /max 5/],
      ];
      for (const [type, params, status, message] of cases) {
        const err = await fhirError(() => caller().search(type as 'Observation', params));
        expect([err.status, err.message], JSON.stringify(params)).toEqual([status, expect.stringMatching(message)]);
      }
    });

    it(`stops at ${MAX_INCLUDED} included resources and says so`, async () => {
      const p = await fhir.asSystem('fixtures').create({ resourceType: 'Patient', name: [{ family: 'Many' }] });
      const observations = (n: number): BundleInput => ({
        resourceType: 'Bundle',
        type: 'transaction',
        entry: Array.from({ length: n }, () => ({
          resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${p.id}` } } as never,
          request: { method: 'POST', url: 'Observation' },
        })),
      });
      await fhir.asSystem('fixtures').transaction(observations(100));
      const exact = await caller().search('Patient', { _id: p.id, _revinclude: 'Observation:subject' });
      expect([exact.included?.length, exact.includeLimitReached]).toEqual([100, undefined]);
      await fhir.asSystem('fixtures').transaction(observations(1));
      const over = await caller().search('Patient', { _id: p.id, _revinclude: 'Observation:subject' });
      expect([over.included?.length, over.includeLimitReached]).toEqual([100, true]);
    });
  });
});

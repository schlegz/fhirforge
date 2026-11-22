import { readFileSync } from 'node:fs';
import {
  createFhirStore,
  FhirError,
  MAX_BUNDLE_ENTRIES,
  type AuthorizeRequest,
  type BundleInput,
  type FhirStorage,
  type StoreAuditEvent,
} from '@fhirforge/core';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
const example = JSON.parse(
  readFileSync(new URL('../../r4/test/examples/bundle-transaction.json', import.meta.url), 'utf8'),
) as BundleInput;

const tx = (...entry: NonNullable<BundleInput['entry']>): BundleInput => ({ resourceType: 'Bundle', type: 'transaction', entry });
const batch = (...entry: NonNullable<BundleInput['entry']>): BundleInput => ({ resourceType: 'Bundle', type: 'batch', entry });
const patient = (family: string, extra: Record<string, unknown> = {}) => ({ resourceType: 'Patient', name: [{ family }], ...extra });
const obs = (subject: string) => ({ resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: subject } });
const post = (resource: Record<string, unknown>, fullUrl?: string) => ({
  ...(fullUrl ? { fullUrl } : {}),
  resource: resource as never,
  request: { method: 'POST', url: String(resource.resourceType) },
});
const UUID_A = 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01';

async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

describe.each(backends)('Bundles on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<unknown>[];
  const makeStore = (authorize: 'allow-all' | ((req: AuthorizeRequest<unknown>) => unknown) = 'allow-all') =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation', 'MedicationRequest'],
      authorize: authorize as 'allow-all',
      onAudit: (e) => {
        events.push(e);
      },
    });
  let fhir: ReturnType<typeof makeStore>;
  const count = async (type: 'Patient' | 'Observation' | 'MedicationRequest') => (await fhir.search(type, {})).total;

  beforeEach(async () => {
    storage = await backend.storage();
    events = [];
    fhir = makeStore();
    await fhir.migrate();
  });
  afterAll(() => backend.close());

  describe('transaction', () => {
    it('creates every entry and resolves urn:uuid references to the new ids', async () => {
      const res = await fhir.transaction(example);
      expect(res.type).toBe('transaction-response');
      expect(res.entry.map((e) => e.response.status)).toEqual(['201 Created', '201 Created']);
      const [p, m] = res.entry;
      expect(p!.response.location).toMatch(/^Patient\/[0-9a-f-]{36}\/_history\/1$/);
      expect(p!.response.etag).toBe('W/"1"');
      const med = await fhir.read('MedicationRequest', m!.resource!.id!);
      expect(med.subject?.reference).toBe(`Patient/${p!.resource!.id}`);
      expect(example.entry![1]!.resource).toMatchObject({ subject: { reference: 'urn:uuid:61ebe359-bfdc-4613-8bf2-c5e300945f0a' } }); // input untouched
    });

    it('updates, creates with a client id, deletes and reads, returning entries in request order', async () => {
      const existing = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Old' }] });
      const gone = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Gone' }] });
      const res = await fhir.transaction(
        tx(
          { request: { method: 'GET', url: `Patient/${existing.id}` } },
          { resource: { ...existing, name: [{ family: 'New' }] } as never, request: { method: 'PUT', url: `Patient/${existing.id}`, ifMatch: 'W/"1"' } },
          { resource: patient('Client', { id: 'client-1' }) as never, request: { method: 'PUT', url: 'Patient/client-1' } },
          { request: { method: 'DELETE', url: `Patient/${gone.id}` } },
          { request: { method: 'DELETE', url: 'Patient/never-existed' } },
          { request: { method: 'GET', url: 'Patient?family=new' } },
        ),
      );
      expect(res.entry.map((e) => e.response.status)).toEqual(['200 OK', '200 OK', '201 Created', '204 No Content', '204 No Content', '200 OK']);
      // GET entries run after the commit and see the writes.
      expect((res.entry[0]!.resource as { name?: { family?: string }[] }).name?.[0]?.family).toBe('New');
      expect((res.entry[5]!.resource as { total?: number }).total).toBe(1);
      expect((await fhirError(() => fhir.read('Patient', gone.id))).status).toBe(410);
      expect((await fhir.read('Patient', 'client-1')).meta.versionId).toBe('1');
    });

    it('writes nothing when any entry is invalid, and names the entry by index and path only', async () => {
      const err = await fhirError(() =>
        fhir.transaction(tx(post(patient('Doe-1')), post(patient('Doe-2', { birthDate: 'Synthetic-1974' })))),
      );
      expect(err.status).toBe(400);
      expect(err.outcome.issue[0]!.expression).toEqual(['Bundle.entry[1].resource.birthDate']);
      expect(err.message).not.toContain('Synthetic');
      expect(await count('Patient')).toBe(0);
    });

    it('rolls back every write when a version guard fails (412)', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      await fhir.update({ ...p, active: true });
      const err = await fhirError(() =>
        fhir.transaction(
          tx(post(patient('New')), { resource: { ...p, active: false } as never, request: { method: 'PUT', url: `Patient/${p.id}`, ifMatch: '1' } }),
        ),
      );
      expect(err.status).toBe(412);
      expect(await count('Patient')).toBe(1);
      expect((await fhir.read('Patient', p.id)).active).toBe(true);
    });

    it('rolls back when a resource changes between the policy check and the write', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      let raced = false;
      const racing = makeStore(async (req) => {
        if (req.action === 'update' && !raced) {
          raced = true;
          await fhir.update({ ...p, gender: 'other' });
        }
        return true;
      });
      const err = await fhirError(() =>
        racing
          .as({})
          .transaction(tx(post(patient('New')), { resource: { ...p, gender: 'female' } as never, request: { method: 'PUT', url: `Patient/${p.id}` } })),
      );
      expect(err.status).toBe(412);
      expect((await fhir.read('Patient', p.id)).gender).toBe('other');
      expect(await count('Patient')).toBe(1); // the create in the same transaction was rolled back
    });

    it("doesn't deadlock when concurrent transactions touch the same resources in opposite order", async () => {
      const a = await fhir.create({ resourceType: 'Patient', name: [{ family: 'A' }] });
      const b = await fhir.create({ resourceType: 'Patient', name: [{ family: 'B' }] });
      const put = (r: typeof a, family: string) => ({ resource: { ...r, name: [{ family }] } as never, request: { method: 'PUT', url: `Patient/${r.id}` } });
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, n) => fhir.transaction(n % 2 ? tx(put(a, `a${n}`), put(b, `b${n}`)) : tx(put(b, `b${n}`), put(a, `a${n}`)))),
      );
      for (const r of results) if (r.status === 'rejected') expect((r.reason as FhirError).status).toBe(412);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const [ra, rb] = [await fhir.read('Patient', a.id), await fhir.read('Patient', b.id)];
      expect(ra.meta.versionId).toBe(rb.meta.versionId); // both written by the same transactions, or not at all
    });

    it('rejects malformed and unsupported requests without echoing URLs', async () => {
      const cases: [BundleInput, number, RegExp][] = [
        [tx({ resource: patient('x') as never, request: { method: 'PUT', url: 'Patient/a' } }), 400, /entry\[0\]: resource\.id must match/],
        [tx({ request: { method: 'DELETE', url: 'Patient/a' } }, { request: { method: 'DELETE', url: 'Patient/a' } }), 400, /entry\[1\]: Patient\/a appears in more than one entry/],
        [tx(post(obs('urn:uuid:00000000-0000-4000-8000-000000000000'))), 400, /entry\[0\]: a urn:uuid: reference has no matching entry/],
        [tx({ request: { method: 'PATCH', url: 'Patient/a' } }), 400, /entry\[0\]: request\.method PATCH is not supported/],
        [tx({ resource: patient('x') as never, request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=Synthetic-MRN' } }), 400, /conditional operations/],
        [tx({ request: { method: 'DELETE', url: 'Patient?identifier=Synthetic-MRN' } }), 400, /conditional DELETE is not supported/],
        [tx({ request: { method: 'GET', url: 'http://example.org/fhir/Patient/Synthetic-MRN' } }), 400, /relative URL/],
        [tx({ request: { method: 'GET', url: 'Encounter/1' } }), 400, /Encounter is not managed/],
        [{ resourceType: 'Bundle', type: 'batch', entry: [] }, 400, /Bundle\.type must be transaction/],
        [tx(...Array.from({ length: MAX_BUNDLE_ENTRIES + 1 }, () => post(patient('x')))), 400, /at most 100 entries/],
        [tx(...Array.from({ length: 11 }, () => ({ request: { method: 'GET', url: 'Patient?family=x' } }))), 400, /at most 10 search entries/],
      ];
      for (const [bundle, status, message] of cases) {
        const err = await fhirError(() => fhir.transaction(bundle));
        expect([err.status, err.message], JSON.stringify(bundle).slice(0, 120)).toEqual([status, expect.stringMatching(message)]);
        expect(err.message).not.toContain('Synthetic');
      }
      expect(await count('Patient')).toBe(0);
    });

    it('audits each entry and the Bundle, without content', async () => {
      events = [];
      const res = await fhir.transaction(tx(post(patient('Synthetic-A'), UUID_A), post(obs(UUID_A))));
      expect(events.map((e) => [e.action, e.resourceType, e.outcome])).toEqual([
        ['create', 'Patient', 'success'],
        ['create', 'Observation', 'success'],
        ['transaction', 'Bundle', 'success'],
      ]);
      expect(events[0]!.id).toBe(res.entry[0]!.resource!.id);
      expect(events[0]!.versionId).toBe('1');
      expect(events[2]!.entries).toBe(2);

      // A Bundle rejected before any entry is processed (here: validation) gets only the Bundle event.
      events = [];
      await fhirError(() => fhir.transaction(tx(post(patient('Ok')), post(patient('Bad', { gender: 'Synthetic-x' })))));
      expect(events.map((e) => [e.action, e.outcome, e.status])).toEqual([['transaction', 'error', 400]]);
      expect(JSON.stringify(events)).not.toContain('Synthetic');

      // Once entries are processed, each is audited: the failing one with its own outcome, the rest as not written.
      events = [];
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      await fhir.update({ ...p, active: true });
      events = [];
      await fhirError(() =>
        fhir.transaction(tx(post(patient('New')), { resource: p as never, request: { method: 'PUT', url: `Patient/${p.id}`, ifMatch: '1' } })),
      );
      expect(events.map((e) => [e.action, e.outcome, e.status])).toEqual([
        ['create', 'error', 412],
        ['update', 'error', 412],
        ['transaction', 'error', 412],
      ]);
    });
  });

  describe('access control', () => {
    it('checks every entry; one denial fails the whole transaction and writes nothing', async () => {
      const seen: AuthorizeRequest<unknown>[] = [];
      const guarded = makeStore((req) => {
        seen.push(req);
        return req.resourceType !== 'Observation';
      });
      const err = await fhirError(() => guarded.as({}).transaction(tx(post(patient('A'), UUID_A), post(obs(UUID_A)))));
      expect(err.status).toBe(403);
      expect(err.message).toMatch(/^entry\[1\]: /);
      expect(await count('Patient')).toBe(0);
      // The policy saw the Observation with its reference already resolved to the new Patient id.
      const o = seen.find((r) => r.resourceType === 'Observation')!.resource as unknown as { subject: { reference: string } };
      expect(o.subject.reference).toMatch(/^Patient\/[0-9a-f-]{36}$/);
      expect(events.filter((e) => e.action === 'create').map((e) => e.outcome)).toEqual(['error', 'denied']);
    });

    it('hides a denied update or delete of a stored resource as 404', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      // Deny anything that touches the stored version (it has meta); allow new content.
      const guarded = makeStore((req) => !req.resource?.meta);
      const del = await fhirError(() => guarded.as({}).transaction(tx({ request: { method: 'DELETE', url: `Patient/${p.id}` } })));
      expect([del.status, del.message]).toEqual([404, `entry[0]: Patient/${p.id} not found`]);
      const { meta: _meta, ...content } = p;
      const upd = await fhirError(() =>
        guarded.as({}).transaction(tx({ resource: content as never, request: { method: 'PUT', url: `Patient/${p.id}` } })),
      );
      expect(upd.status).toBe(404);
      expect((await fhir.read('Patient', p.id)).meta.versionId).toBe('1');
    });

    it('requires a scope when a policy is configured', async () => {
      const guarded = makeStore(() => true);
      expect((await fhirError(() => guarded.transaction(tx(post(patient('A')))))).status).toBe(403);
      expect((await fhirError(() => guarded.batch(batch(post(patient('A')))))).status).toBe(403);
      expect((await guarded.asSystem('import').transaction(tx(post(patient('A'))))).entry[0]!.response.status).toBe('201 Created');
    });
  });

  describe('batch', () => {
    it('runs entries independently: failures are reported per entry', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
      const res = await fhir.batch(
        batch(
          post(patient('Ok')),
          post(patient('Bad', { birthDate: 'Synthetic-1974' })),
          { request: { method: 'GET', url: 'Patient/missing' } },
          { resource: { ...p, active: true } as never, request: { method: 'PUT', url: `Patient/${p.id}` } },
          { request: { method: 'DELETE', url: `Patient/${p.id}`, ifMatch: '1' } },
          { request: { method: 'PATCH', url: `Patient/${p.id}` } },
        ),
      );
      expect(res.type).toBe('batch-response');
      expect(res.entry.map((e) => e.response.status)).toEqual([
        '201 Created',
        '400 Bad Request',
        '404 Not Found',
        '200 OK',
        '412 Precondition Failed',
        '400 Bad Request',
      ]);
      expect(res.entry[1]!.response.outcome!.issue[0]!.expression).toEqual(['Patient.birthDate']);
      expect(res.entry[1]!.response.outcome!.issue[0]!.diagnostics).not.toContain('Synthetic');
      expect(res.entry[2]!.response.outcome!.issue[0]!.diagnostics).toMatch(/^entry\[2\]: /);
      expect(await count('Patient')).toBe(2);
      expect((await fhir.read('Patient', p.id)).active).toBe(true);
    });

    it("rejects entries that reference each other (that's what transactions are for)", async () => {
      const res = await fhir.batch(batch(post(patient('A'), UUID_A), post(obs(UUID_A))));
      expect(res.entry.map((e) => e.response.status)).toEqual(['201 Created', '400 Bad Request']);
      expect(res.entry[1]!.response.outcome!.issue[0]!.diagnostics).toMatch(/use a transaction/);
    });

    it('rejects hostile nesting in an entry as invalid, without overflowing the stack', async () => {
      let ext: Record<string, unknown> = { url: 'u', valueString: 'leaf' };
      for (let i = 0; i < 50_000; i++) ext = { url: 'u', extension: [ext] };
      const res = await fhir.batch(batch(post(patient('Deep', { extension: [ext] }))));
      expect(res.entry[0]!.response.status).toBe('400 Bad Request');
      expect(res.entry[0]!.response.outcome!.issue[0]!.diagnostics).toMatch(/nested too deeply/);
    });

    it('audits each operation and the Bundle', async () => {
      events = [];
      await fhir.batch(batch(post(patient('A')), { request: { method: 'GET', url: 'Patient/missing' } }));
      expect(events.map((e) => [e.action, e.outcome])).toEqual([
        ['create', 'success'],
        ['read', 'not-found'],
        ['batch', 'success'],
      ]);
      expect(events[2]!.entries).toBe(2);
    });
  });
});

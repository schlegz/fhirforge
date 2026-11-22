import { createFhirStore, type AuthorizeRequest, type FhirStorage, type StoreAuditEvent } from '@fhirforge/core';
import { createServer } from 'node:http';
import { createFhirHandler, toNodeHandler, type NodeRequestLike } from '@fhirforge/http';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
interface Session {
  user: string;
}

const ORIGIN = 'https://app.example.org';

describe.each(backends)('HTTP handler on $name', (backend) => {
  let storage: FhirStorage;
  let events: StoreAuditEvent<Session>[];
  let errors: unknown[];
  let policy: (req: AuthorizeRequest<Session>) => boolean;
  const makeStore = () =>
    createFhirStore({
      storage,
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: (req: AuthorizeRequest<Session>) => policy(req),
      onAudit: (e) => {
        events.push(e);
      },
      search: { policy: { 'Patient.birthdate': 'none' } },
    });
  let store: ReturnType<typeof makeStore>;
  let handler: ReturnType<typeof createFhirHandler>;

  /** Sends a request as the synthetic user (or anonymously with `auth: false`). */
  const send = async (method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { ...(init.auth === false ? {} : { authorization: 'Bearer test-user' }), ...init.headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      headers['content-type'] ??= 'application/fhir+json';
    }
    const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, body }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : undefined };
  };

  beforeEach(async () => {
    storage = await backend.storage();
    events = [];
    errors = [];
    policy = () => true;
    store = makeStore();
    await store.migrate();
    handler = createFhirHandler({
      store,
      basePath: '/fhir',
      context: (req) => (req.headers.get('authorization') === 'Bearer test-user' ? { user: 'u1' } : undefined),
      onError: (err) => errors.push(err),
    });
  });
  afterAll(() => backend.close());

  it('creates, reads, updates, deletes and keeps history over REST', async () => {
    const created = await send('POST', '/fhir/Patient', { body: { resourceType: 'Patient', name: [{ family: 'Doe' }] } });
    expect(created.status).toBe(201);
    const id = created.json!.id as string;
    expect(created.headers.get('location')).toBe(`${ORIGIN}/fhir/Patient/${id}/_history/1`);
    expect(created.headers.get('etag')).toBe('W/"1"');
    expect(created.headers.get('content-type')).toBe('application/fhir+json; charset=utf-8');
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(new Date(created.headers.get('last-modified')!).getTime()).not.toBeNaN();

    const read = await send('GET', `/fhir/Patient/${id}`);
    expect([read.status, read.json!.name[0].family]).toEqual([200, 'Doe']);

    const stale = await send('PUT', `/fhir/Patient/${id}`, { body: { ...read.json, active: true }, headers: { 'if-match': 'W/"9"' } });
    expect(stale.status).toBe(412);
    const updated = await send('PUT', `/fhir/Patient/${id}`, { body: { ...read.json, active: true }, headers: { 'if-match': 'W/"1"' } });
    expect([updated.status, updated.headers.get('etag')]).toEqual([200, 'W/"2"']);

    const asCreate = await send('PUT', '/fhir/Patient/client-1', { body: { resourceType: 'Patient', id: 'client-1' } });
    expect([asCreate.status, asCreate.headers.get('location')]).toEqual([201, `${ORIGIN}/fhir/Patient/client-1/_history/1`]);

    expect((await send('GET', `/fhir/Patient/${id}/_history/1`)).json!.active).toBeUndefined();
    expect((await send('DELETE', `/fhir/Patient/${id}`, { headers: { 'if-match': '1' } })).status).toBe(412);
    expect((await send('DELETE', `/fhir/Patient/${id}`)).status).toBe(204);
    expect((await send('GET', `/fhir/Patient/${id}`)).status).toBe(410);

    const history = await send('GET', `/fhir/Patient/${id}/_history`);
    expect(history.json!.type).toBe('history');
    expect(history.json!.entry.map((e: any) => [e.request.method, e.response.status])).toEqual([
      ['DELETE', '204 No Content'],
      ['PUT', '200 OK'],
      ['POST', '201 Created'],
    ]);
  });

  it('searches with searchset Bundles, absolute fullUrls and next links (GET and POST _search)', async () => {
    for (const family of ['Doe', 'Doe', 'Doe']) await send('POST', '/fhir/Patient', { body: { resourceType: 'Patient', name: [{ family }] } });
    const page = await send('GET', '/fhir/Patient?family=doe&_count=2');
    expect(page.status).toBe(200);
    expect(page.json!.type).toBe('searchset');
    expect(page.json!.total).toBe(3);
    expect(page.json!.entry).toHaveLength(2);
    expect(page.json!.entry[0].fullUrl).toMatch(new RegExp(`^${ORIGIN}/fhir/Patient/[0-9a-f-]{36}$`));
    const next = page.json!.link.find((l: any) => l.relation === 'next').url as string;
    expect(next).toBe(`${ORIGIN}/fhir/Patient?family=doe&_count=2&_offset=2`);
    expect((await send('GET', next.slice(ORIGIN.length))).json!.entry).toHaveLength(1);

    const form = await send('POST', '/fhir/Patient/_search', {
      body: 'family=doe&_count=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect([form.status, form.json!.entry.length]).toEqual([200, 1]);

    // Errors never repeat search values (parameter names that look like names may appear, by design).
    const bad = await send('GET', '/fhir/Patient?_lastUpdated=Synthetic-Secret');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toContain('Synthetic');
  });

  it('returns _include results as include entries, and advertises includes in /metadata', async () => {
    const p = await send('POST', '/fhir/Patient', { body: { resourceType: 'Patient', name: [{ family: 'Doe' }] } });
    await send('POST', '/fhir/Observation', {
      body: { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: `Patient/${p.json!.id}` } },
    });
    const res = await send('GET', '/fhir/Observation?subject.name=doe&_include=Observation:subject');
    expect(res.json!.entry.map((e: any) => [e.resource.resourceType, e.search.mode])).toEqual([
      ['Observation', 'match'],
      ['Patient', 'include'],
    ]);
    expect(res.json!.entry[1].fullUrl).toBe(`${ORIGIN}/fhir/Patient/${p.json!.id}`);
    const meta = await send('GET', '/fhir/metadata', { auth: false });
    const patient = meta.json!.rest[0].resource.find((r: any) => r.type === 'Patient');
    expect(patient.searchRevInclude).toContain('Observation:subject');
    expect(patient.searchRevInclude).not.toContain('Observation:specimen'); // can't point to a Patient
  });

  it('runs transaction and batch Bundles posted to the base URL', async () => {
    const res = await send('POST', '/fhir', {
      body: {
        resourceType: 'Bundle',
        type: 'transaction',
        entry: [
          { fullUrl: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01', resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
          {
            resource: { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01' } },
            request: { method: 'POST', url: 'Observation' },
          },
        ],
      },
    });
    expect([res.status, res.json!.type]).toEqual([200, 'transaction-response']);
    expect(res.json!.entry[1].resource.subject.reference).toBe(`Patient/${res.json!.entry[0].resource.id}`);
    const batch = await send('POST', '/fhir/', { body: { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'GET', url: 'Patient/missing' } }] } });
    expect(batch.json!.entry[0].response.status).toBe('404 Not Found');
    expect((await send('POST', '/fhir', { body: { resourceType: 'Bundle', type: 'collection' } })).status).toBe(400);
  });

  it('requires authentication for data, but serves /metadata publicly', async () => {
    const anon = await send('GET', '/fhir/Patient', { auth: false });
    expect([anon.status, anon.json!.issue[0].code, anon.headers.get('www-authenticate')]).toEqual([401, 'login', 'Bearer']);
    expect(events).toEqual([]); // never reached the store

    const meta = await send('GET', '/fhir/metadata', { auth: false });
    expect(meta.status).toBe(200);
    expect(meta.json!.resourceType).toBe('CapabilityStatement');
    expect(meta.json!.fhirVersion).toBe('4.0.1');
    const patient = meta.json!.rest[0].resource.find((r: any) => r.type === 'Patient');
    const names = patient.searchParam.map((p: any) => p.name);
    expect(names).toContain('family');
    expect(names).not.toContain('birthdate'); // search policy "none" isn't advertised
    expect(meta.json!.rest[0].interaction).toEqual([{ code: 'transaction' }, { code: 'batch' }]);
  });

  it('runs every request through the policy and audit with the caller context', async () => {
    const created = await send('POST', '/fhir/Patient', { body: { resourceType: 'Patient' } });
    policy = (req) => req.action !== 'read';
    events = [];
    const denied = await send('GET', `/fhir/Patient/${created.json!.id}`);
    expect(denied.status).toBe(404);
    expect(events.map((e) => [e.action, e.outcome, e.ctx])).toEqual([['read', 'not-found', { user: 'u1' }]]);
  });

  it('answers bad requests with OperationOutcomes that never echo the body', async () => {
    const cases: [string, string, { body?: unknown; headers?: Record<string, string> }, number, string][] = [
      ['POST', '/fhir/Patient', { body: '{"resourceType":"Patient","name":[{"family":"Synthetic-Secret"', headers: {} }, 400, 'invalid'],
      ['POST', '/fhir/Patient', { body: { resourceType: 'Patient' }, headers: { 'content-type': 'text/plain' } }, 415, 'not-supported'],
      ['POST', '/fhir/Patient', { body: { resourceType: 'Observation' } }, 400, 'invalid'],
      ['POST', '/fhir/Patient', { body: { resourceType: 'Patient', birthDate: 'Synthetic-Secret' } }, 400, 'invalid'],
      ['PUT', '/fhir/Patient/a', { body: { resourceType: 'Patient', id: 'b' } }, 400, 'invalid'],
      ['PATCH', '/fhir/Patient/a', {}, 405, 'not-supported'],
      ['GET', '/fhir/Encounter/a', {}, 400, 'not-supported'],
      ['GET', '/fhir/Patient/a/_history/1/extra', {}, 404, 'not-found'],
      ['GET', '/other/Patient', {}, 404, 'not-found'],
      ['GET', '/fhir/Patient?_format=xml', {}, 406, 'not-supported'],
      ['GET', '/fhir/_history', {}, 400, 'not-supported'],
      ['GET', '/fhir/Patient/%E0%A4%A', {}, 400, 'invalid'],
    ];
    for (const [method, path, init, status, code] of cases) {
      const res = await send(method, path, init);
      expect([res.status, res.json!.resourceType, res.json!.issue[0].code], `${method} ${path}`).toEqual([status, 'OperationOutcome', code]);
      expect(JSON.stringify(res.json)).not.toContain('Synthetic');
    }
    expect((await send('PATCH', '/fhir/Patient/a')).headers.get('allow')).toBe('GET, PUT, DELETE');
  });

  it('refuses bodies over the limit without reading them all', async () => {
    const small = createFhirHandler({ store, basePath: '/fhir', context: () => ({ user: 'u1' }), maxBodyBytes: 1000 });
    const body = JSON.stringify({ resourceType: 'Patient', name: [{ family: 'x'.repeat(5000) }] });
    const declared = await small(new Request(`${ORIGIN}/fhir/Patient`, { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body }));
    expect(declared.status).toBe(413);
    // A streamed body with no Content-Length is cut off at the limit too.
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(600)));
      },
    });
    const streamed = await small(
      new Request(`${ORIGIN}/fhir/Patient`, { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: stream, duplex: 'half' } as RequestInit),
    );
    expect(streamed.status).toBe(413);
  });

  it('hides unexpected errors behind a generic 500 and hands them to onError', async () => {
    const broken = createFhirHandler({
      store,
      basePath: '/fhir',
      context: () => {
        throw new Error('Synthetic-Secret driver failure');
      },
      onError: (err) => errors.push(err),
    });
    const res = await broken(new Request(`${ORIGIN}/fhir/Patient`));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('Synthetic');
    expect(JSON.parse(text).issue[0]).toEqual({ severity: 'error', code: 'exception', diagnostics: 'Internal server error' });
    expect(errors).toHaveLength(1);
  });

  describe('toNodeHandler (Express, node:http)', () => {
    it('serves a real node:http server, streaming the request body', async () => {
      const server = createServer(toNodeHandler(createFhirHandler({ store, basePath: '/fhir', context: () => ({ user: 'u1' }) })));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      try {
        const base = `http://127.0.0.1:${port}/fhir`;
        const created = await fetch(`${base}/Patient`, {
          method: 'POST',
          headers: { 'content-type': 'application/fhir+json' },
          body: JSON.stringify({ resourceType: 'Patient', name: [{ family: 'Doe' }] }),
        });
        expect(created.status).toBe(201);
        expect(created.headers.get('location')).toMatch(new RegExp(`^${base}/Patient/[0-9a-f-]{36}/_history/1$`));
        expect(created.headers.get('cache-control')).toBe('no-store');
        const page = (await (await fetch(`${base}/Patient?family=doe`)).json()) as { total: number };
        expect(page.total).toBe(1);
        const tooBig = await fetch(`${base}/Patient`, {
          method: 'POST',
          headers: { 'content-type': 'application/fhir+json' },
          body: 'x'.repeat(11 * 1024 * 1024),
        });
        expect(tooBig.status).toBe(413);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('works under an Express mount path and with a body parser that already ran', async () => {
      const node = toNodeHandler(createFhirHandler({ store, basePath: '/fhir', context: () => ({ user: 'u1' }) }));
      const response = { statusCode: 0, headers: {} as Record<string, string>, body: undefined as Uint8Array | undefined };
      const res = {
        get statusCode() {
          return response.statusCode;
        },
        set statusCode(v: number) {
          response.statusCode = v;
        },
        setHeader: (name: string, value: string) => (response.headers[name] = value),
        end: (chunk?: Uint8Array) => (response.body = chunk),
      };
      // Express under app.use('/fhir', ...): req.url loses the mount path, req.originalUrl keeps it.
      const req: NodeRequestLike = {
        method: 'POST',
        url: '/Patient',
        originalUrl: '/fhir/Patient',
        headers: { host: 'app.example.org', 'content-type': 'application/fhir+json', 'content-length': '999' },
        body: { resourceType: 'Patient', name: [{ family: 'Parsed' }] },
        readableEnded: true,
        async *[Symbol.asyncIterator]() {},
      };
      await node(req, res);
      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toMatch(/^http:\/\/app\.example\.org\/fhir\/Patient\//);
      expect(JSON.parse(new TextDecoder().decode(response.body)).name[0].family).toBe('Parsed');
    });
  });

  it('uses the configured public base URL for links', async () => {
    const proxied = createFhirHandler({ store, basePath: '/fhir', baseUrl: 'https://api.example.org/r4/', context: () => ({ user: 'u1' }) });
    const res = await proxied(
      new Request('http://internal:3000/fhir/Patient', { method: 'POST', headers: { 'content-type': 'application/fhir+json' }, body: '{"resourceType":"Patient"}' }),
    );
    expect(res.headers.get('location')).toMatch(/^https:\/\/api\.example\.org\/r4\/Patient\/[0-9a-f-]{36}\/_history\/1$/);
  });
});

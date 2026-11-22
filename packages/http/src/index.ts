import {
  FhirError,
  type AnyResource,
  type BundleInput,
  type FhirDataOperations,
  type FhirStore,
  type HistoryEntry,
  type SearchParams,
  type Stored,
} from '@fhirforge/core';

export interface FhirHandlerOptions<M, Ctx> {
  /** The store to serve. Every request runs as `store.as(ctx)`. */
  store: FhirStore<M, Ctx>;
  /**
   * The path the handler is mounted at, e.g. `/fhir` for `app/fhir/[[...path]]/route.ts`.
   * Requests outside it get 404.
   */
  basePath: string;
  /**
   * Returns the caller context for a request, from your own authentication
   * (session, token). Return undefined for an unauthenticated request: it gets
   * 401 and never reaches the store. There is no default context.
   * Not called for `GET /metadata`, which is public and contains no data.
   */
  context: (request: Request) => Ctx | undefined | Promise<Ctx | undefined>;
  /**
   * Public base URL used in `Location`, `fullUrl` and paging links, e.g.
   * `https://api.example.org/fhir`. Default: the request's origin plus `basePath`.
   * Set it when running behind a proxy that changes the host.
   */
  baseUrl?: string;
  /** Largest request body accepted, in bytes. Larger bodies get 413. Default 10 MB. */
  maxBodyBytes?: number;
  /**
   * Called with errors that aren't `FhirError`s (bugs, database outages, audit
   * failures) before a generic 500 is returned. The response never includes
   * the error. A driver error's message can contain request values, so treat
   * it as PHI if you log it.
   */
  onError?: (error: unknown, request: Request) => void;
}

/** A fetch-style handler: Next.js App Router route handlers, Hono, Bun, Deno, ... */
export type FhirHandler = (request: Request) => Promise<Response>;

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const INSTANCE_INTERACTIONS = ['read', 'vread', 'update', 'delete', 'history-instance', 'create', 'search-type'];

/**
 * Serves the FHIR REST API for a store. In Next.js (App Router), in
 * `app/fhir/[[...path]]/route.ts`:
 *
 * ```ts
 * const handler = createFhirHandler({ store, basePath: '/fhir', context: (req) => sessionFrom(req) });
 * export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
 * ```
 */
export function createFhirHandler<M, Ctx>(options: FhirHandlerOptions<M, Ctx>): FhirHandler {
  const store = options.store as unknown as FhirStore<Record<string, AnyResource>, Ctx>;
  if (!store || typeof store.as !== 'function') throw new Error('createFhirHandler: `store` is required');
  if (typeof options.context !== 'function') {
    throw new Error('createFhirHandler: `context` is required (return the caller context from your auth)');
  }
  const basePath = normalizeBase(options.basePath);
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const started = new Date().toISOString();

  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) throw notFound();
      const segments = url.pathname
        .slice(basePath.length)
        .split('/')
        .filter((s) => s !== '')
        .map(decodeSegment);
      const base = (options.baseUrl ?? `${url.origin}${basePath}`).replace(/\/+$/, '');
      checkFormat(url.searchParams);
      const method = request.method.toUpperCase();

      if (segments.length === 1 && segments[0] === 'metadata') {
        allow(method, ['GET']);
        return json(200, capabilityStatement(store, base, started), { 'Cache-Control': 'no-cache' });
      }

      const ctx = await options.context(request);
      if (ctx === undefined) throw new FhirError(401, 'login', 'Authentication required');
      const ops = store.as(ctx);
      const body = () => readJson(request, maxBody);
      const [type, id, history, versionId, ...rest] = segments;

      if (rest.length > 0) throw notFound();
      if (type === undefined) {
        allow(method, ['POST']);
        return json(200, await runBundle(ops, await body()));
      }
      if (type.startsWith('_')) throw FhirError.notSupported('System-level operations are not supported');

      if (id === undefined) {
        allow(method, ['GET', 'POST']);
        if (method === 'GET') return json(200, await search(ops, base, type, searchParams(url.searchParams)));
        const resource = await body();
        if (resource.resourceType !== type) throw FhirError.invalid('resourceType does not match the URL');
        const created = await ops.create(resource as never);
        return resourceResponse(201, created, base);
      }
      if (id === '_search') {
        allow(method, ['POST']);
        const params = searchParams(url.searchParams, await readForm(request, maxBody));
        return json(200, await search(ops, base, type, params));
      }
      if (id === '_history') throw FhirError.notSupported('Type-level history is not supported');

      if (history === undefined) {
        allow(method, ['GET', 'PUT', 'DELETE']);
        if (method === 'GET') return resourceResponse(200, await ops.read(type, id), base);
        const ifMatch = request.headers.get('if-match') ?? undefined;
        if (method === 'DELETE') {
          await ops.delete(type, id, { ifMatch });
          return empty(204);
        }
        const resource = await body();
        if (resource.resourceType !== type) throw FhirError.invalid('resourceType does not match the URL');
        if (resource.id !== id) throw FhirError.invalid('Resource id does not match the URL');
        const updated = await ops.update(resource as never, { ifMatch });
        // Update-as-create of a new id is version 1. (Re-creating a deleted resource reports 200.)
        return resourceResponse(updated.meta.versionId === '1' ? 201 : 200, updated, base);
      }
      if (history !== '_history') throw notFound();
      allow(method, ['GET']);
      if (versionId === undefined) return json(200, historyBundle(type, id, await ops.history(type, id), base));
      return resourceResponse(200, await ops.vread(type, id, versionId), base, false);
    } catch (err) {
      if (err instanceof FhirError) {
        const headers: Record<string, string> = err instanceof MethodNotAllowed ? { Allow: err.allowed.join(', ') } : {};
        if (err.status === 401) headers['WWW-Authenticate'] = 'Bearer';
        return json(err.status, err.outcome, headers);
      }
      try {
        options.onError?.(err, request);
      } catch {
        // An error handler that throws must not change the response.
      }
      return json(500, {
        resourceType: 'OperationOutcome',
        issue: [{ severity: 'error', code: 'exception', diagnostics: 'Internal server error' }],
      });
    }
  };
}

// ---- routing helpers ----

class MethodNotAllowed extends FhirError {
  constructor(readonly allowed: readonly string[]) {
    super(405, 'not-supported', 'Method not allowed');
  }
}

function allow(method: string, allowed: readonly string[]) {
  if (!allowed.includes(method)) throw new MethodNotAllowed(allowed);
}

const notFound = () => new FhirError(404, 'not-found', 'Unknown path');

function normalizeBase(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('createFhirHandler: `basePath` must start with "/"');
  return path.replace(/\/+$/, '');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw FhirError.invalid('Malformed URL');
  }
}

/** Only JSON is supported; `_format=xml` is refused rather than answered in JSON. */
function checkFormat(params: URLSearchParams) {
  const format = params.get('_format');
  if (format !== null && !/^(json|application\/(fhir\+)?json)$/.test(format)) {
    throw new FhirError(406, 'not-supported', 'Only JSON is supported (_format=json)');
  }
}

/** Query (and form) parameters as store search parameters; repeated names become arrays. */
function searchParams(...sources: URLSearchParams[]): SearchParams {
  const out: Record<string, string | string[]> = {};
  for (const source of sources) {
    for (const [name, value] of source) {
      if (name === '_format' || name === '_pretty') continue;
      const prev = out[name];
      out[name] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
    }
  }
  return out;
}

// ---- request bodies ----

/** Reads the body as text, refusing more than `max` bytes without buffering past the limit. */
async function readText(request: Request, max: number): Promise<string> {
  const tooLarge = () => new FhirError(413, 'too-costly', `Request body is larger than ${max} bytes`);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    if (err instanceof FhirError) throw err;
    throw FhirError.invalid('Request body is not valid UTF-8');
  }
}

async function readJson(request: Request, max: number): Promise<AnyResource> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/fhir+json' && type !== 'application/json') {
    throw new FhirError(415, 'not-supported', 'Content-Type must be application/fhir+json');
  }
  const text = await readText(request, max);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw FhirError.invalid('Request body is not valid JSON'); // never echo the body
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || typeof (parsed as AnyResource).resourceType !== 'string') {
    throw FhirError.invalid('Request body must be a FHIR resource');
  }
  return parsed as AnyResource;
}

async function readForm(request: Request, max: number): Promise<URLSearchParams> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new FhirError(415, 'not-supported', 'Content-Type must be application/x-www-form-urlencoded');
  }
  return new URLSearchParams(await readText(request, max));
}

// ---- operations ----

async function runBundle(ops: FhirDataOperations<Record<string, AnyResource>>, resource: AnyResource) {
  if (resource.resourceType !== 'Bundle') throw FhirError.invalid('POST to the base URL takes a Bundle');
  const bundle = resource as unknown as BundleInput;
  if (bundle.type === 'transaction') return ops.transaction(bundle);
  if (bundle.type === 'batch') return ops.batch(bundle);
  throw FhirError.invalid('Bundle.type must be transaction or batch');
}

async function search(ops: FhirDataOperations<Record<string, AnyResource>>, base: string, type: string, params: SearchParams) {
  const page = await ops.search(type, params);
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    ...(page.total !== undefined ? { total: page.total } : {}),
    link: [
      { relation: 'self', url: `${base}/${type}${query(params)}` },
      ...(page.next ? [{ relation: 'next', url: `${base}/${type}${query(page.next)}` }] : []),
    ],
    entry: page.resources.map((resource) => ({
      fullUrl: `${base}/${type}/${resource.id}`,
      resource,
      search: { mode: 'match' },
    })),
  };
}

function query(params: Record<string, string | number | boolean | readonly (string | number)[] | undefined>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function historyBundle(type: string, id: string, versions: HistoryEntry<AnyResource>[], base: string) {
  return {
    resourceType: 'Bundle',
    type: 'history',
    total: versions.length,
    entry: versions.map((v) => ({
      fullUrl: `${base}/${type}/${id}`,
      ...(v.resource ? { resource: v.resource } : {}),
      request: v.deleted
        ? { method: 'DELETE', url: `${type}/${id}` }
        : v.versionId === '1'
          ? { method: 'POST', url: type }
          : { method: 'PUT', url: `${type}/${id}` },
      response: {
        status: v.deleted ? '204 No Content' : v.versionId === '1' ? '201 Created' : '200 OK',
        etag: `W/"${v.versionId}"`,
        lastModified: v.lastUpdated,
      },
    })),
  };
}

function capabilityStatement(store: FhirStore<Record<string, AnyResource>, unknown>, base: string, date: string) {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date,
    kind: 'instance',
    software: { name: 'fhirforge' },
    implementation: { description: 'fhirforge', url: base },
    fhirVersion: store.fhirVersion,
    format: ['application/fhir+json'],
    rest: [
      {
        mode: 'server',
        resource: store.resourceTypes.map((type) => ({
          type,
          interaction: INSTANCE_INTERACTIONS.map((code) => ({ code })),
          versioning: 'versioned',
          readHistory: true,
          updateCreate: true,
          conditionalCreate: false,
          conditionalUpdate: false,
          conditionalDelete: 'not-supported',
          searchParam: store.searchParameters(type).map((p) => ({ name: p.code, type: p.type })),
        })),
        interaction: [{ code: 'transaction' }, { code: 'batch' }],
      },
    ],
  };
}

// ---- responses ----

/** Every response: FHIR JSON, never cached (it can contain PHI), never content-sniffed. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': FHIR_JSON, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

function resourceResponse(status: number, resource: Stored<AnyResource>, base: string, location = true): Response {
  const { versionId, lastUpdated } = resource.meta;
  return json(status, resource, {
    ETag: `W/"${versionId}"`,
    'Last-Modified': new Date(lastUpdated).toUTCString(),
    ...(location && status === 201
      ? { Location: `${base}/${resource.resourceType}/${resource.id}/_history/${versionId}` }
      : {}),
  });
}

export { toNodeHandler, type NodeHandler, type NodeRequestLike, type NodeResponseLike } from './node.js';

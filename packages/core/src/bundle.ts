import { FhirError, type OperationOutcomeLike } from './errors.js';
import type { SearchParams } from './search/query.js';
import type { StoredVersion } from './storage.js';
import type { AnyResource } from './types.js';
import { MAX_DEPTH } from './validation/validate.js';

/** Most entries a transaction or batch Bundle may have. */
export const MAX_BUNDLE_ENTRIES = 100;
/** Most search (GET `Type?...`) entries per Bundle, so one request can't run many searches. */
export const MAX_BUNDLE_SEARCHES = 10;

/** A transaction or batch Bundle, as the store accepts it. An R4 `Bundle` is assignable to it. */
export interface BundleInput {
  resourceType: 'Bundle';
  type: string;
  entry?: readonly BundleEntryInput[];
}

export interface BundleEntryInput {
  fullUrl?: string;
  resource?: AnyResource;
  request?: {
    method: string;
    url: string;
    ifMatch?: string;
    ifNoneMatch?: string;
    ifModifiedSince?: string;
    ifNoneExist?: string;
  };
}

/** A `transaction-response` or `batch-response` Bundle, one entry per request entry, in request order. */
export interface BundleResponse {
  resourceType: 'Bundle';
  type: 'transaction-response' | 'batch-response';
  entry: BundleResponseEntry[];
}

export interface BundleResponseEntry {
  /** The stored resource (writes, reads) or a `searchset` Bundle (searches). */
  resource?: AnyResource;
  response: {
    /** HTTP status line, e.g. `201 Created`. */
    status: string;
    /** `Type/id/_history/version` for writes. */
    location?: string;
    /** `W/"version"`. */
    etag?: string;
    lastModified?: string;
    /** For a failed batch entry: why. */
    outcome?: OperationOutcomeLike;
  };
}

/** What one entry's `request` asks for. */
export type EntryRequest =
  | { method: 'POST'; resourceType: string }
  | { method: 'PUT'; resourceType: string; id: string }
  | { method: 'DELETE'; resourceType: string; id: string }
  | { method: 'GET'; kind: 'read'; resourceType: string; id: string }
  | { method: 'GET'; kind: 'vread'; resourceType: string; id: string; versionId: string }
  | { method: 'GET'; kind: 'search'; resourceType: string; params: SearchParams };

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export const statusLine = (status: number) => `${status} ${STATUS_TEXT[status] ?? ''}`.trim();

/** Adds the entry index to an error's message; the message never contains the entry's URL or content. */
export function atEntry(index: number, err: FhirError): FhirError {
  return new FhirError(err.status, err.code, `entry[${index}]: ${err.message}`, err.issues);
}

const TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const VERSION = /^[1-9]\d{0,17}$/;

/**
 * Parses an entry's `request`. Only relative URLs (`Patient`, `Patient/1`,
 * `Patient/1/_history/2`, `Patient?name=doe`) and the methods fhirforge
 * supports are accepted; everything else is a 400 that never repeats the URL.
 */
export function parseEntryRequest(
  request: BundleEntryInput['request'],
  checkType: (type: string) => string,
  checkId: (id: string) => string,
): EntryRequest {
  if (!request || typeof request.url !== 'string' || typeof request.method !== 'string') {
    throw FhirError.invalid('request with method and url is required');
  }
  for (const header of ['ifNoneExist', 'ifNoneMatch', 'ifModifiedSince'] as const) {
    if (request[header] !== undefined) throw FhirError.notSupported(`request.${header} (conditional operations) is not supported`);
  }
  const { method, url } = request;
  if (request.ifMatch !== undefined && method !== 'PUT' && method !== 'DELETE') {
    throw FhirError.invalid('request.ifMatch is only allowed on PUT and DELETE');
  }
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? undefined : url.slice(q + 1);
  const parts = path.split('/');
  if (!parts[0] || !TYPE.test(parts[0])) throw FhirError.invalid('request.url must start with a resource type (relative URL)');
  const resourceType = checkType(parts[0]);

  if (method === 'GET') {
    if (query !== undefined) {
      if (parts.length !== 1) throw FhirError.notSupported('request.url form is not supported');
      return { method, kind: 'search', resourceType, params: parseQuery(query) };
    }
    if (parts.length === 2) return { method, kind: 'read', resourceType, id: checkId(parts[1]!) };
    if (parts.length === 4 && parts[2] === '_history' && VERSION.test(parts[3]!)) {
      return { method, kind: 'vread', resourceType, id: checkId(parts[1]!), versionId: parts[3]! };
    }
    throw FhirError.notSupported('request.url form is not supported');
  }
  if (query !== undefined) throw FhirError.notSupported(`conditional ${safeMethod(method)} is not supported`);
  if (method === 'POST') {
    if (parts.length !== 1) throw FhirError.invalid('POST request.url must be the resource type');
    return { method, resourceType };
  }
  if (method === 'PUT' || method === 'DELETE') {
    if (parts.length !== 2) throw FhirError.invalid(`${method} request.url must be Type/id`);
    return { method, resourceType, id: checkId(parts[1]!) };
  }
  throw FhirError.notSupported(`request.method ${safeMethod(method)} is not supported`);
}

const safeMethod = (m: string) => (/^[A-Z]{1,10}$/.test(m) ? m : '(invalid)');

/** Parses `a=1&b=2&a=3` into search parameters (repeated names become arrays). */
function parseQuery(query: string): SearchParams {
  const out: Record<string, string | string[]> = {};
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const name = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = decode(eq === -1 ? '' : pair.slice(eq + 1));
    const prev = out[name];
    out[name] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    throw FhirError.invalid('request.url has malformed percent-encoding');
  }
}

/**
 * Returns a copy of `value` with every `reference` that is a key of `targets`
 * (a `urn:uuid:` fullUrl) replaced by its `Type/id`. A `urn:uuid:` reference
 * with no matching entry throws. The input is validated, so depth is bounded.
 */
export function resolveReferences<T>(value: T, targets: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v)) {
      if (key === 'reference' && typeof child === 'string' && child.startsWith('urn:uuid:')) {
        const target = targets.get(child);
        if (!target) throw FhirError.invalid('a urn:uuid: reference has no matching entry fullUrl in this Bundle');
        out[key] = target;
      } else {
        out[key] = walk(child);
      }
    }
    return out;
  };
  return walk(value) as T;
}

/**
 * True when `value` contains a `reference` to one of `fullUrls`. Runs on
 * unvalidated batch entries, so it stops descending past `MAX_DEPTH` (anything
 * that deep fails validation afterwards anyway).
 */
export function referencesAny(value: unknown, fullUrls: ReadonlySet<string>, depth = 0): boolean {
  if (depth > MAX_DEPTH * 2) return false; // arrays and objects each add a level
  if (Array.isArray(value)) return value.some((v) => referencesAny(v, fullUrls, depth + 1));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) =>
    key === 'reference' && typeof child === 'string' ? fullUrls.has(child) : referencesAny(child, fullUrls, depth + 1),
  );
}

/** The response entry for a successful write. */
export function writeResponse(version: StoredVersion, status: 200 | 201): BundleResponseEntry {
  const resource = version.resource!;
  return {
    resource,
    response: {
      status: statusLine(status),
      location: `${resource.resourceType}/${resource.id}/_history/${version.versionId}`,
      etag: `W/"${version.versionId}"`,
      lastModified: version.lastUpdated,
    },
  };
}

/** The response entry for a failed batch entry. Errors that aren't FhirErrors never get here (they fail the batch). */
export function errorResponse(err: FhirError): BundleResponseEntry {
  return { response: { status: statusLine(err.status), outcome: err.outcome } };
}

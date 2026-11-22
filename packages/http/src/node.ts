import type { FhirHandler } from './index.js';

/**
 * The parts of a Node request (`http.IncomingMessage`, Express `req`) the
 * adapter uses. Structural, so there's no dependency on Node or Express types.
 */
export interface NodeRequestLike extends AsyncIterable<Uint8Array | string> {
  method?: string;
  /** Path and query. Express rewrites it under a mount path, so `originalUrl` is preferred. */
  url?: string;
  /** Express: the full path, including the mount path. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** The connection; a TLS socket has `encrypted: true`. */
  socket?: unknown;
  /** Set by Express body parsers that already read the stream. */
  body?: unknown;
  /** True once the body stream has been fully read (e.g. by a body parser). */
  readableEnded?: boolean;
}

/** The parts of a Node response (`http.ServerResponse`, Express `res`) the adapter uses. */
export interface NodeResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: Uint8Array): unknown;
}

export type NodeHandler = (req: NodeRequestLike, res: NodeResponseLike, next?: (err?: unknown) => void) => Promise<void>;

/**
 * Adapts the fetch-style handler to Node's `(req, res)`: Express, Connect,
 * `node:http`, and frameworks that expose the raw request and response.
 *
 * ```ts
 * app.use('/fhir', toNodeHandler(createFhirHandler({ store, basePath: '/fhir', baseUrl, context })));
 * ```
 *
 * Mount it before body parsers, or let them skip FHIR requests: the handler
 * reads the body itself, with its size limit. If a parser already read it,
 * the parsed `req.body` is used instead.
 *
 * Without `baseUrl`, links are built from the `Host` header, which the client
 * controls: set `baseUrl` in production.
 */
export function toNodeHandler(handler: FhirHandler): NodeHandler {
  return async (req, res, next) => {
    let response: Response;
    try {
      response = await handler(toRequest(req));
    } catch (err) {
      // The handler itself never throws; this is a request that couldn't be converted.
      if (next) return next(err);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/fhir+json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        new TextEncoder().encode(
          JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Malformed request' }] }),
        ),
      );
      return;
    }
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      res.setHeader(name, value);
    });
    const body = new Uint8Array(await response.arrayBuffer());
    res.end(body.byteLength ? body : undefined);
  };
}

function toRequest(req: NodeRequestLike): Request {
  const method = (req.method ?? 'GET').toUpperCase();
  const host = first(req.headers.host) ?? 'localhost';
  const url = new URL(req.originalUrl ?? req.url ?? '/', `${(req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'}://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  if (method === 'GET' || method === 'HEAD') return new Request(url, { method, headers });

  const parsed = req.readableEnded ? req.body : undefined;
  if (parsed !== undefined) {
    // A body parser got there first. Re-encode what it produced; the handler applies its own checks.
    const body =
      typeof parsed === 'string' ? parsed : parsed instanceof Uint8Array ? new Uint8Array(parsed) : JSON.stringify(parsed);
    headers.delete('content-length');
    return new Request(url, { method, headers, body });
  }
  const iterator = req[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  // `duplex: 'half'` is required by Node's fetch for streamed request bodies.
  return new Request(url, { method, headers, body: stream, duplex: 'half' } as RequestInit);
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

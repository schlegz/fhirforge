# @fhirforge/http

The FHIR REST API for a fhirforge store. `createFhirHandler` returns a fetch-style handler, `(request: Request) => Promise<Response>`, for anything built on web-standard Request/Response: Next.js App Router, Hono, Bun, Deno, Remix. `toNodeHandler` adapts it to Node's `(req, res)` for Express, Connect and `node:http`. There is no dependency on any framework.

Next.js, in `app/fhir/[[...path]]/route.ts`:

```ts
import { createFhirHandler } from '@fhirforge/http';

const handler = createFhirHandler({
  store, // from createFhirStore
  basePath: '/fhir',
  context: async (request) => sessionFrom(request), // your auth; undefined → 401
});

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

Express (mount it before body parsers, or the parsed `req.body` is used):

```ts
import { createFhirHandler, toNodeHandler } from '@fhirforge/http';

app.use('/fhir', toNodeHandler(createFhirHandler({
  store,
  basePath: '/fhir',
  baseUrl: 'https://api.example.org/fhir', // links; without it they come from the client's Host header
  context: async (request) => sessionFromHeaders(request.headers),
})));
```

Every request runs as `store.as(ctx)`, so your `authorize` policy, validation and `onAudit` apply exactly as in code. Requests without a context get 401 and never reach the store. `GET /metadata` is public.

| Request | Store call | Response |
| --- | --- | --- |
| `GET /metadata` | | CapabilityStatement from the configured types and search parameters |
| `POST /` (Bundle) | `transaction` / `batch` | `transaction-response` / `batch-response` |
| `GET /Type?params`, `POST /Type/_search` (form) | `search` | `searchset` Bundle with `self` / `next` links |
| `POST /Type` | `create` | 201, `Location`, `ETag`, `Last-Modified` |
| `GET /Type/id` | `read` | 200, `ETag`, `Last-Modified` |
| `PUT /Type/id` (`If-Match`) | `update` | 200, or 201 when it created the resource |
| `DELETE /Type/id` (`If-Match`) | `delete` | 204 |
| `GET /Type/id/_history`, `GET /Type/id/_history/v` | `history`, `vread` | `history` Bundle, resource |

Options: `baseUrl` (the public URL for links when behind a proxy), `maxBodyBytes` (default 10 MB, larger bodies get 413) and `onError` (receives unexpected errors; the response is a generic 500).

Responses are `application/fhir+json` with `Cache-Control: no-store`. Errors are OperationOutcomes without stack traces, SQL or driver messages. JSON only: `_format=xml` gets 406. CORS and rate limiting are up to your app.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

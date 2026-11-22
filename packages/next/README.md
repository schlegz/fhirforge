# @fhirforge/next

The FHIR REST API for a fhirforge store, as a fetch-style route handler: `(request: Request) => Promise<Response>`. It uses only the web-standard `Request` and `Response`, so it works in Next.js App Router route handlers and in any framework built on them (Hono, Bun, Deno, Remix, ...). There is no dependency on Next.js.

```ts
// app/fhir/[[...path]]/route.ts
import { createFhirHandler } from '@fhirforge/next';
import { store } from '@/lib/fhir'; // createFhirStore({ ... })
import { sessionFrom } from '@/lib/auth';

const handler = createFhirHandler({
  store,
  basePath: '/fhir',
  context: async (request) => sessionFrom(request), // your auth; undefined → 401
});

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
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

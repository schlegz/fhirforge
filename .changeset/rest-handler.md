---
"@fhirforge/core": minor
"@fhirforge/http": minor
---

New package `@fhirforge/http`: the FHIR REST API for a store. `createFhirHandler` is a fetch-style handler for Next.js App Router, Hono, Bun and Deno, and `toNodeHandler` adapts it for Express and `node:http`. Every request runs as `store.as(ctx)` with a context from your auth (401 without one). It handles search with `searchset` Bundles and paging links, transaction and batch Bundles at the base URL, `ETag` / `If-Match` / `Location`, and a public `/metadata` CapabilityStatement. Responses use `Cache-Control: no-store`, request bodies have a size limit, and unexpected errors become a generic 500. Core: new `store.searchParameters(type)` method, and new issue codes `login` and `too-costly`.

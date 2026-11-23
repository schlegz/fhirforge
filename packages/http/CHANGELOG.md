# @fhirforge/http

## 0.7.0

### Patch Changes

- Updated dependencies [4ec7914]
  - @fhirforge/core@0.7.0

## 0.6.0

### Minor Changes

- 08c1715: Chained search and `_include` / `_revinclude`. `search('Observation', { 'subject.name': 'doe' })` runs the chain as its own search on the target type, through `authorize` and `onAudit`, so it only matches resources the caller may see. Its matches become a reference filter. `_include=Observation:subject` reads each referenced resource, and `_revinclude=Observation:subject` searches for the referencing ones; each is checked by the policy and audited, and resources the caller may not read are left out. Results carry `included` and `includeLimitReached`. Limits: one chain level, 3 chained values, 100 chain matches, 5 include parameters, 100 included resources. The REST handler returns includes as `search.mode: 'include'` entries and lists `searchInclude` / `searchRevInclude` in `/metadata`. `store.searchParameters(type)` now also returns each reference parameter's `targets`.

### Patch Changes

- Updated dependencies [fe0a353]
- Updated dependencies [08c1715]
  - @fhirforge/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [fcc6565]
  - @fhirforge/core@0.5.0

## 0.4.0

### Minor Changes

- 8854a6e: New package `@fhirforge/http`: the FHIR REST API for a store. `createFhirHandler` is a fetch-style handler for Next.js App Router, Hono, Bun and Deno, and `toNodeHandler` adapts it for Express and `node:http`. Every request runs as `store.as(ctx)` with a context from your auth (401 without one). It handles search with `searchset` Bundles and paging links, transaction and batch Bundles at the base URL, `ETag` / `If-Match` / `Location`, and a public `/metadata` CapabilityStatement. Responses use `Cache-Control: no-store`, request bodies have a size limit, and unexpected errors become a generic 500. Core: new `store.searchParameters(type)` method, and new issue codes `login` and `too-costly`.

### Patch Changes

- Updated dependencies [8854a6e]
  - @fhirforge/core@0.4.0

# @fhirforge/core

## 0.4.0

### Minor Changes

- 8854a6e: New package `@fhirforge/http`: the FHIR REST API for a store. `createFhirHandler` is a fetch-style handler for Next.js App Router, Hono, Bun and Deno, and `toNodeHandler` adapts it for Express and `node:http`. Every request runs as `store.as(ctx)` with a context from your auth (401 without one). It handles search with `searchset` Bundles and paging links, transaction and batch Bundles at the base URL, `ETag` / `If-Match` / `Location`, and a public `/metadata` CapabilityStatement. Responses use `Cache-Control: no-store`, request bodies have a size limit, and unexpected errors become a generic 500. Core: new `store.searchParameters(type)` method, and new issue codes `login` and `too-costly`.

## 0.3.0

### Minor Changes

- ee3db20: Bundle transactions and batches: `store.transaction(bundle)` commits every entry or none (with `urn:uuid:` references between entries resolved), and `store.batch(bundle)` runs entries independently with a status per entry. Every entry is validated, checked by `authorize`, pinned to the approved version and audited, like a single operation; the Bundle gets its own `transaction` / `batch` audit event. Limits: 100 entries, 10 search entries. `delete` now accepts `{ ifMatch }`. Breaking for custom storage adapters: `FhirStorage` has a new required `writeAll` method (implemented by `@fhirforge/pg` and `@fhirforge/pglite`). `StoreAction` has two new values, and `AuthorizeRequest.action` is the new `AuthorizeAction` type, which excludes them.

## 0.2.0

### Minor Changes

- 095b2cc: Runtime validation: `create` and `update` now validate every resource against the base FHIR spec (unknown elements, cardinality, types, choice elements, required code bindings, primitive formats, contained resources) before the access policy runs, and reject invalid ones with a 400 `FhirError` whose OperationOutcome has one issue per problem, with the element path in `expression` and never the value. The rules are compiled from the StructureDefinitions by `@fhirforge/codegen` and ship as `validation` in `@fhirforge/r4`. Breaking: `createFhirStore` now requires `validation` in the version package, and writes that were accepted before may now fail with 400.

## 0.1.0

### Minor Changes

- ab2171d: First public release: strict FHIR R4 types, a typed FHIR store with create, read, update, delete, history and search on Postgres and PGlite, required access control (`authorize`) and audit (`onAudit`) hooks, and TLS enforcement for remote Postgres connections.

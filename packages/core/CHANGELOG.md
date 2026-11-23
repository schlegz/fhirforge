# @fhirforge/core

## 0.8.0

### Minor Changes

- 51fec06: Conditional create, update and delete: `conditionalCreate(resource, condition)`, `conditionalUpdate(type, condition, resource)` and `conditionalDelete(type, condition)`, plus Bundle entries with `ifNoneExist` or a `Type?…` URL, and REST `If-None-Exist`, `PUT /Type?…` and `DELETE /Type?…`. The REST handler previously ignored `If-None-Exist` and created a duplicate; it now honors it. The condition is searched as the caller (policy and audit). The write re-checks it under an advisory lock in its transaction and fails with 412 if it changed, so concurrent conditional writes with the same condition can't create duplicates. Several matches is a 412. `/metadata` advertises conditional support. For custom storage adapters: writes can carry a `condition` (`WriteCondition`) that must be re-checked under a lock in the write transaction.

## 0.7.0

### Minor Changes

- 4ec7914: New `expunge(type, id, { reason })`: permanently removes a resource, with every version and every search index row, in one transaction. It works on deleted resources too, and the id can be reused afterwards. It's off unless enabled with `createFhirStore({ expunge: {} })`. `expunge: { storage }` runs it on a second storage for the same schema (a role with `DELETE`), so the everyday runtime role never needs `DELETE` on resource data. A reason is required and recorded in the audit event (`expungeReason`) and in a new `expunge_reason` audit-table column (migration `audit:2`). The policy decides on it with the new action `expunge` (denied looks like missing, 404). It's pinned like other writes (412 on a concurrent change or a mismatched `ifMatch`) and audited, and audit rows about the resource are kept. It isn't exposed by the REST handler. Breaking for custom storage adapters: `FhirStorage.expunge` is new and required. `StoreAction` / `AuthorizeAction` gain `expunge`.

## 0.6.0

### Minor Changes

- fe0a353: New `onPolicyError(error, request)` option: called when `authorize` throws or rejects, so policy bugs don't go unnoticed. The request is still denied exactly as before, and errors thrown by the hook are ignored.
- 08c1715: Chained search and `_include` / `_revinclude`. `search('Observation', { 'subject.name': 'doe' })` runs the chain as its own search on the target type, through `authorize` and `onAudit`, so it only matches resources the caller may see. Its matches become a reference filter. `_include=Observation:subject` reads each referenced resource, and `_revinclude=Observation:subject` searches for the referencing ones; each is checked by the policy and audited, and resources the caller may not read are left out. Results carry `included` and `includeLimitReached`. Limits: one chain level, 3 chained values, 100 chain matches, 5 include parameters, 100 included resources. The REST handler returns includes as `search.mode: 'include'` entries and lists `searchInclude` / `searchRevInclude` in `/metadata`. `store.searchParameters(type)` now also returns each reference parameter's `targets`.

## 0.5.0

### Minor Changes

- fcc6565: Built-in audit table: `createFhirStore({ audit: { table: true, actor: (ctx) => ctx.userId } })` records every operation in an append-only `fhir."_audit"` table. Creates, updates, deletes and transaction Bundles write their audit rows in the same database transaction as the data, so a committed change always has its record. Reads, denials and failures are recorded too. Rows carry the same fields as `onAudit` events (no content, search values or error messages). Triggers refuse UPDATE, DELETE and TRUNCATE, and the runtime role needs only INSERT on the table. `migrationSql` takes `{ audit: true }`. Every `StoreAuditEvent` now has an `operationId`, shared by a Bundle's entries. Breaking for custom storage adapters: `FhirStorage` has a new required `recordAudit`, `migrate` takes `{ audit }`, and `create` / `update` / `delete` / `writeAll` receive `audit` rows to insert in their transaction.

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

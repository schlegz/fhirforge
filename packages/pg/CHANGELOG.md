# @fhirforge/pg

## 0.5.0

### Minor Changes

- fcc6565: Built-in audit table: `createFhirStore({ audit: { table: true, actor: (ctx) => ctx.userId } })` records every operation in an append-only `fhir."_audit"` table. Creates, updates, deletes and transaction Bundles write their audit rows in the same database transaction as the data, so a committed change always has its record. Reads, denials and failures are recorded too. Rows carry the same fields as `onAudit` events (no content, search values or error messages). Triggers refuse UPDATE, DELETE and TRUNCATE, and the runtime role needs only INSERT on the table. `migrationSql` takes `{ audit: true }`. Every `StoreAuditEvent` now has an `operationId`, shared by a Bundle's entries. Breaking for custom storage adapters: `FhirStorage` has a new required `recordAudit`, `migrate` takes `{ audit }`, and `create` / `update` / `delete` / `writeAll` receive `audit` rows to insert in their transaction.

### Patch Changes

- Updated dependencies [fcc6565]
  - @fhirforge/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [8854a6e]
  - @fhirforge/core@0.4.0

## 0.3.0

### Minor Changes

- ee3db20: Bundle transactions and batches: `store.transaction(bundle)` commits every entry or none (with `urn:uuid:` references between entries resolved), and `store.batch(bundle)` runs entries independently with a status per entry. Every entry is validated, checked by `authorize`, pinned to the approved version and audited, like a single operation; the Bundle gets its own `transaction` / `batch` audit event. Limits: 100 entries, 10 search entries. `delete` now accepts `{ ifMatch }`. Breaking for custom storage adapters: `FhirStorage` has a new required `writeAll` method (implemented by `@fhirforge/pg` and `@fhirforge/pglite`). `StoreAction` has two new values, and `AuthorizeRequest.action` is the new `AuthorizeAction` type, which excludes them.

### Patch Changes

- Updated dependencies [ee3db20]
  - @fhirforge/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [095b2cc]
  - @fhirforge/core@0.2.0

## 0.1.0

### Minor Changes

- ab2171d: First public release: strict FHIR R4 types, a typed FHIR store with create, read, update, delete, history and search on Postgres and PGlite, required access control (`authorize`) and audit (`onAudit`) hooks, and TLS enforcement for remote Postgres connections.

### Patch Changes

- Updated dependencies [ab2171d]
  - @fhirforge/core@0.1.0

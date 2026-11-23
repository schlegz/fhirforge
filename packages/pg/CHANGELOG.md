# @fhirforge/pg

## 0.8.0

### Minor Changes

- 51fec06: Conditional create, update and delete: `conditionalCreate(resource, condition)`, `conditionalUpdate(type, condition, resource)` and `conditionalDelete(type, condition)`, plus Bundle entries with `ifNoneExist` or a `Type?…` URL, and REST `If-None-Exist`, `PUT /Type?…` and `DELETE /Type?…`. The REST handler previously ignored `If-None-Exist` and created a duplicate; it now honors it. The condition is searched as the caller (policy and audit). The write re-checks it under an advisory lock in its transaction and fails with 412 if it changed, so concurrent conditional writes with the same condition can't create duplicates. Several matches is a 412. `/metadata` advertises conditional support. For custom storage adapters: writes can carry a `condition` (`WriteCondition`) that must be re-checked under a lock in the write transaction.

### Patch Changes

- Updated dependencies [51fec06]
  - @fhirforge/core@0.8.0

## 0.7.0

### Minor Changes

- 4ec7914: New `expunge(type, id, { reason })`: permanently removes a resource, with every version and every search index row, in one transaction. It works on deleted resources too, and the id can be reused afterwards. It's off unless enabled with `createFhirStore({ expunge: {} })`. `expunge: { storage }` runs it on a second storage for the same schema (a role with `DELETE`), so the everyday runtime role never needs `DELETE` on resource data. A reason is required and recorded in the audit event (`expungeReason`) and in a new `expunge_reason` audit-table column (migration `audit:2`). The policy decides on it with the new action `expunge` (denied looks like missing, 404). It's pinned like other writes (412 on a concurrent change or a mismatched `ifMatch`) and audited, and audit rows about the resource are kept. It isn't exposed by the REST handler. Breaking for custom storage adapters: `FhirStorage.expunge` is new and required. `StoreAction` / `AuthorizeAction` gain `expunge`.

### Patch Changes

- Updated dependencies [4ec7914]
  - @fhirforge/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [fe0a353]
- Updated dependencies [08c1715]
  - @fhirforge/core@0.6.0

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

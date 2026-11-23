# @fhirforge/pg

## 0.11.0

### Minor Changes

- e190bcd: Encryption: `encryption.requireEncrypted: true` makes a plaintext body an error on read, so someone with write access to the database can't substitute plaintext for a ciphertext. `reencrypt()` still converts plaintext rows in strict mode. New `store.removeUnusedDataKeys()` deletes data keys older than 48 hours that no row in the schema references. It checks every table with encrypted bodies, so keys used by other stores are kept, and it needs `DELETE` on `_data_keys`. `dataKeyMaxAgeMs` is now capped at 24 hours. For custom storage adapters: a new `removeDataKeys` method.

### Patch Changes

- Updated dependencies [e190bcd]
  - @fhirforge/core@0.11.0

## 0.10.0

### Minor Changes

- 39ea3fa: The `blind` search policy: a `blind` parameter is indexed as a keyed hash (HMAC-SHA-256) of its normalized value, in a new `<Type>_blind` table, instead of a readable copy. It stays searchable by exact match: string by the whole value (case- and accent-insensitive), token by `code`, `system|code` or `|code`, date at its stored precision. Everything else on a blind parameter (prefix matching, `:contains`, `:exact`, date prefixes, `:not`, `:missing`, `_sort`) is a 400. It needs `encryption.blindIndexKey` (a separate secret with an id stored on each row) and works for string, token and date parameters. After rotating the key, run `reindex()`. New migration `resource:<Type>:4` (the blind table). The runtime role needs `SELECT, INSERT, UPDATE, DELETE` on it, like the other index tables. For custom adapters: `IndexRow` has a `blind` kind, search conditions have a `blind` kind, and `Indexer` may return a promise.

### Patch Changes

- Updated dependencies [39ea3fa]
  - @fhirforge/core@0.10.0

## 0.9.0

### Minor Changes

- 9a5ff6a: Encryption at rest for resource bodies: `createFhirStore({ encryption: { keys } })`, where `keys` is your KMS as a `KeyProvider` (`wrap` / `unwrap`).
  - Every body, current and history, is envelope-encrypted with AES-256-GCM, a random nonce and data keys wrapped by your master key. The ciphertext is bound to its row, so a body copied to another resource or version won't decrypt.
  - Data keys are reused for a bounded window (5 minutes or 100,000 encryptions) and cached for reads, so KMS calls stay off the write path and out of transactions.
  - Existing plaintext rows stay readable. `store.reencrypt()` encrypts them, and `reencrypt({ olderThan })` rotates to new data keys.
  - Search index rows are not encrypted yet (use the `none` policy; `blind` is next).
  - New migrations: `resource:<Type>:3` (nullable `enc` / `dek_id` columns) and `crypto:1` (`_data_keys`, only with encryption). The runtime role needs `SELECT, INSERT` on `_data_keys`.
  - Breaking for custom storage adapters: new `dataKeys` and `reencrypt` methods, `WriteOptions.seal`, `StoredVersion.sealed`, `reindex(type, index, { open })` and `migrate(types, { encryption })`.

### Patch Changes

- Updated dependencies [9a5ff6a]
  - @fhirforge/core@0.9.0

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

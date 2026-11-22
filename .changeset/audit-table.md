---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

Built-in audit table: `createFhirStore({ audit: { table: true, actor: (ctx) => ctx.userId } })` records every operation in an append-only `fhir."_audit"` table. Creates, updates, deletes and transaction Bundles write their audit rows in the same database transaction as the data, so a committed change always has its record. Reads, denials and failures are recorded too. Rows carry the same fields as `onAudit` events (no content, search values or error messages). Triggers refuse UPDATE, DELETE and TRUNCATE, and the runtime role needs only INSERT on the table. `migrationSql` takes `{ audit: true }`. Every `StoreAuditEvent` now has an `operationId`, shared by a Bundle's entries. Breaking for custom storage adapters: `FhirStorage` has a new required `recordAudit`, `migrate` takes `{ audit }`, and `create` / `update` / `delete` / `writeAll` receive `audit` rows to insert in their transaction.

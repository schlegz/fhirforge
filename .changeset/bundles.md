---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

Bundle transactions and batches: `store.transaction(bundle)` commits every entry or none (with `urn:uuid:` references between entries resolved), and `store.batch(bundle)` runs entries independently with a status per entry. Every entry is validated, checked by `authorize`, pinned to the approved version and audited, like a single operation; the Bundle gets its own `transaction` / `batch` audit event. Limits: 100 entries, 10 search entries. `delete` now accepts `{ ifMatch }`. Breaking for custom storage adapters: `FhirStorage` has a new required `writeAll` method (implemented by `@fhirforge/pg` and `@fhirforge/pglite`). `StoreAction` has two new values, and `AuthorizeRequest.action` is the new `AuthorizeAction` type, which excludes them.

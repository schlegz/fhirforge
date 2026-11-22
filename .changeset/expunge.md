---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

New `expunge(type, id, { reason })`: permanently removes a resource, with every version and every search index row, in one transaction. It works on deleted resources too, and the id can be reused afterwards. It's off unless enabled with `createFhirStore({ expunge: {} })`. `expunge: { storage }` runs it on a second storage for the same schema (a role with `DELETE`), so the everyday runtime role never needs `DELETE` on resource data. A reason is required and recorded in the audit event (`expungeReason`) and in a new `expunge_reason` audit-table column (migration `audit:2`). The policy decides on it with the new action `expunge` (denied looks like missing, 404). It's pinned like other writes (412 on a concurrent change or a mismatched `ifMatch`) and audited, and audit rows about the resource are kept. It isn't exposed by the REST handler. Breaking for custom storage adapters: `FhirStorage.expunge` is new and required. `StoreAction` / `AuthorizeAction` gain `expunge`.

---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

New `expunge(type, id)`: permanently removes a resource, with every version and every search index row, in one transaction. It works on deleted resources too, and the id can be reused afterwards. The policy decides on it with the new action `expunge` (denied looks like missing, 404). It's pinned like other writes (412 if the resource changed after the policy check, or `ifMatch` doesn't match) and audited. Audit rows about the resource are kept. It isn't exposed by the REST handler. The runtime database role needs `DELETE` on the resource and history tables to use it. Breaking for custom storage adapters: `FhirStorage.expunge` is new and required. `StoreAction` / `AuthorizeAction` gain `expunge`.

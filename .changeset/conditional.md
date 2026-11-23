---
"@fhirforge/core": minor
"@fhirforge/pg": minor
"@fhirforge/http": minor
---

Conditional create, update and delete: `conditionalCreate(resource, condition)`, `conditionalUpdate(type, condition, resource)` and `conditionalDelete(type, condition)`, plus Bundle entries with `ifNoneExist` or a `Type?…` URL, and REST `If-None-Exist`, `PUT /Type?…` and `DELETE /Type?…`. The REST handler previously ignored `If-None-Exist` and created a duplicate; it now honors it. The condition is searched as the caller (policy and audit). The write re-checks it under an advisory lock in its transaction and fails with 412 if it changed, so concurrent conditional writes with the same condition can't create duplicates. Several matches is a 412. `/metadata` advertises conditional support. For custom storage adapters: writes can carry a `condition` (`WriteCondition`) that must be re-checked under a lock in the write transaction.

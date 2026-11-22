---
"@fhirforge/core": minor
---

New `onPolicyError(error, request)` option: called when `authorize` throws or rejects, so policy bugs don't go unnoticed. The request is still denied exactly as before, and errors thrown by the hook are ignored.

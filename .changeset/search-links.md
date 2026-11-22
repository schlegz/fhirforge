---
"@fhirforge/core": minor
"@fhirforge/http": minor
---

Chained search and `_include` / `_revinclude`. `search('Observation', { 'subject.name': 'doe' })` runs the chain as its own search on the target type, through `authorize` and `onAudit`, so it only matches resources the caller may see. Its matches become a reference filter. `_include=Observation:subject` reads each referenced resource, and `_revinclude=Observation:subject` searches for the referencing ones; each is checked by the policy and audited, and resources the caller may not read are left out. Results carry `included` and `includeLimitReached`. Limits: one chain level, 3 chained values, 100 chain matches, 5 include parameters, 100 included resources. The REST handler returns includes as `search.mode: 'include'` entries and lists `searchInclude` / `searchRevInclude` in `/metadata`. `store.searchParameters(type)` now also returns each reference parameter's `targets`.

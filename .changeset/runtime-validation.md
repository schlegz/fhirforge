---
"@fhirforge/core": minor
"@fhirforge/codegen": minor
"@fhirforge/r4": minor
---

Runtime validation: `create` and `update` now validate every resource against the base FHIR spec (unknown elements, cardinality, types, choice elements, required code bindings, primitive formats, contained resources) before the access policy runs, and reject invalid ones with a 400 `FhirError` whose OperationOutcome has one issue per problem, with the element path in `expression` and never the value. The rules are compiled from the StructureDefinitions by `@fhirforge/codegen` and ship as `validation` in `@fhirforge/r4`. Breaking: `createFhirStore` now requires `validation` in the version package, and writes that were accepted before may now fail with 400.

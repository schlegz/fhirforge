# @fhirforge/codegen

Build-time generator for strict FHIR TypeScript types, compiled search parameters and validation rules.

```bash
fhirforge-codegen --package hl7.fhir.r4.core@4.0.1 --out src/generated
```

Generates required code bindings as literal unions, exclusive choice types (`value[x]`), generic `Reference<T>`, a `ResourceTypeMap`, and search parameters compiled from their FHIRPath expressions into plain path data. Apps normally use the published output, `@fhirforge/r4`.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

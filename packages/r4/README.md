# @fhirforge/r4

Strict TypeScript types for FHIR R4 (4.0.1), generated from the official definitions, plus R4's compiled search parameters and validation rules for `@fhirforge/core`.

```ts
import type { Patient, Observation } from '@fhirforge/r4'; // types only: nothing bundled
import { r4 } from '@fhirforge/r4'; // the version descriptor for createFhirStore (includes search and validation data)
```

Required codes are literal unions (`gender: 'M'` doesn't compile), choice types allow one variant, and `Reference<Patient | Group>` checks the reference string and `type`.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

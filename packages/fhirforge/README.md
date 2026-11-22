# fhirforge

Embeddable FHIR storage for Node and TypeScript: typed create, read, update, delete, history and FHIR search on your own Postgres, with required access control and audit hooks.

This package is the common setup in one install: it re-exports `@fhirforge/core`, `@fhirforge/pg` and `@fhirforge/r4`. For tests and local development, add `@fhirforge/pglite`.

```ts
import { createFhirStore, postgresStorage, r4 } from 'fhirforge';

const fhir = createFhirStore({
  storage: postgresStorage(pool),
  fhir: r4,
  resources: ['Patient', 'Observation'],
  authorize: myPolicy, // or 'allow-all'
});
```

See the [repository](https://github.com/schlegz/fhirforge) for the full documentation. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

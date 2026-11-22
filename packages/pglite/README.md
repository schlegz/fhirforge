# @fhirforge/pglite

In-process [PGlite](https://pglite.dev) storage for fhirforge: real Postgres with no server or Docker, for tests and local development.

```ts
import { PGlite } from '@electric-sql/pglite';
import { pgliteStorage } from '@fhirforge/pglite';

const storage = pgliteStorage(new PGlite());
```

PGlite is single-connection: use `@fhirforge/pg` with a real Postgres in production.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

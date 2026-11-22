# @fhirforge/core

The fhirforge store: typed create, read, update, delete, history and FHIR search, with runtime validation of every write, required access control (`authorize`) and audit (`onAudit`) hooks. Version-neutral and storage-neutral: pass a version package (`@fhirforge/r4`) and a storage adapter (`@fhirforge/pg`, `@fhirforge/pglite`).

```ts
import { createFhirStore } from '@fhirforge/core';
import { postgresStorage } from '@fhirforge/pg';
import { r4 } from '@fhirforge/r4';

const fhir = createFhirStore({
  storage: postgresStorage(pool),
  fhir: r4,
  resources: ['Patient', 'Observation'],
  authorize: myPolicy, // or 'allow-all'
  onAudit: (event) => auditLog.write(event),
});
await fhir.migrate();
const patient = await fhir.as(session).read('Patient', id);
```

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

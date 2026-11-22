// The README quick start, kept compiling by `pnpm test:types`.
import { PGlite } from '@electric-sql/pglite';
import { createFhirStore } from '@fhirforge/core';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';

export async function quickStart(): Promise<void> {
  const fhir = createFhirStore({
    storage: pgliteStorage(new PGlite()),
    fhir: r4,
    resources: ['Patient', 'Observation'],
  });
  await fhir.migrate();

  const patient = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
  const same = await fhir.read('Patient', patient.id);
  await fhir.update({ ...same, active: true }, { ifMatch: same.meta.versionId });
  await fhir.delete('Patient', patient.id);
  await fhir.history('Patient', patient.id);
}

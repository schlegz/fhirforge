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

  const page = await fhir.search('Patient', { family: 'doe', birthdate: 'ge1970', _sort: '-birthdate', _count: 20 });
  void page.resources;
}

export function searchPolicy(storage: Parameters<typeof createFhirStore>[0]['storage']): void {
  createFhirStore({ storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'none' } } });
}

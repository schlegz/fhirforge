// The README quick start, kept compiling by `pnpm test:types`.
import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, type AuthorizeRequest } from '@fhirforge/core';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4, type Observation } from '@fhirforge/r4';

export async function quickStart(): Promise<void> {
  const fhir = createFhirStore({
    storage: pgliteStorage(new PGlite()),
    authorize: 'allow-all',
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

export function searchPolicy(storage: Parameters<typeof createFhirStore>[0]['storage'], authorize: 'allow-all'): void {
  createFhirStore({ storage, authorize, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'none' } } });
}

// README "Access control and audit" example.
interface Session {
  role: 'clinician' | 'patient';
  patientId?: string;
}
declare const auditLog: { write(event: unknown): void };
declare const session: Session;

export async function accessControl(storage: Parameters<typeof createFhirStore>[0]['storage'], id: string): Promise<void> {
  const fhir = createFhirStore({
    storage,
    fhir: r4,
    resources: ['Patient', 'Observation'],
    authorize: ({ ctx, action, resourceType, resource }: AuthorizeRequest<Session>) => {
      if (ctx.role === 'clinician') return true;
      if (action === 'search') {
      // ANDed into the caller's query. (Patient has no `patient` parameter, so filter by _id.)
      return { filter: resourceType === 'Patient' ? { _id: ctx.patientId } : { patient: ctx.patientId } };
    }
      return resource?.resourceType === 'Patient'
        ? resource.id === ctx.patientId
        : (resource as Observation | undefined)?.subject?.reference === `Patient/${ctx.patientId}`;
    },
    onAudit: (event) => auditLog.write(event),
  });

  await fhir.as(session).read('Patient', id);
  await fhir.asSystem('nightly export').search('Patient', {});
}

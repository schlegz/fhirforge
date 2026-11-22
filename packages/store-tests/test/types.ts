// Type-level tests for the store API, checked by `pnpm test:types`. Lines with a
// ts-expect-error directive must fail to compile, or the build fails.
import { createFhirStore, type FhirStorage, type Stored } from '@fhirforge/core';
import { r4, type Observation, type Patient } from '@fhirforge/r4';
import { expectTypeOf } from 'expect-type';

declare const storage: FhirStorage;
const fhir = createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient', 'Observation'] });

export async function typed(): Promise<void> {
  // read() returns the version package's type for that resource.
  expectTypeOf(await fhir.read('Patient', '1')).toEqualTypeOf<Stored<Patient>>();
  expectTypeOf(await fhir.read('Observation', '1')).toEqualTypeOf<Stored<Observation>>();

  // Stored<T> guarantees id and server meta.
  const p = await fhir.read('Patient', '1');
  expectTypeOf(p.id).toEqualTypeOf<string>();
  expectTypeOf(p.meta.versionId).toEqualTypeOf<string>();

  // create() infers the resource type from resourceType.
  const created = await fhir.create({ resourceType: 'Patient', gender: 'female' });
  expectTypeOf(created).toEqualTypeOf<Stored<Patient>>();

  // The generated types still apply to input.
  // @ts-expect-error not an AdministrativeGender code
  await fhir.create({ resourceType: 'Patient', gender: 'F' });

  // Only the configured resource types are accepted.
  // @ts-expect-error Encounter is not in `resources`
  await fhir.read('Encounter', '1');
  // @ts-expect-error Encounter is not in `resources`
  await fhir.create({ resourceType: 'Encounter', status: 'planned', class: { code: 'AMB' } });

  // update() needs an id.
  // @ts-expect-error id is required for update
  await fhir.update({ resourceType: 'Patient' });

  // search() returns the stored resource type.
  const found = await fhir.search('Patient', { family: 'doe', _count: 10 });
  expectTypeOf(found.resources).toEqualTypeOf<Stored<Patient>[]>();
  expectTypeOf(found.total).toEqualTypeOf<number | undefined>();

  // Search policy keys are checked against the configured resource types.
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'none' } } });
  // @ts-expect-error Observation is not configured
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Observation.code': 'none' } } });
  // @ts-expect-error not a policy
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'hidden' } } });

  // authorize is required: a policy or the explicit 'allow-all'.
  // @ts-expect-error authorize missing
  createFhirStore({ storage, fhir: r4, resources: ['Patient'] });

  // The policy's ctx type flows to as().
  interface Session {
    userId: string;
    patientId?: string;
  }
  const guarded = createFhirStore({
    storage,
    fhir: r4,
    resources: ['Patient'],
    authorize: ({ ctx }: { ctx: Session }) => ctx.userId !== '',
  });
  await guarded.as({ userId: 'u1' }).read('Patient', '1');
  // @ts-expect-error ctx must be a Session
  guarded.as({ user: 'u1' });

  // resources must be real resource types of the version.
  // @ts-expect-error Patiant is not an R4 resource type
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patiant'] });
}

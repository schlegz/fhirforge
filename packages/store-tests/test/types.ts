// Type-level tests for the store API, checked by `pnpm test:types`. Lines with a
// ts-expect-error directive must fail to compile, or the build fails.
import { createFhirStore, type FhirStorage, type Stored } from '@fhirforge/core';
import { r4, type Observation, type Patient } from '@fhirforge/r4';
import { expectTypeOf } from 'expect-type';

declare const storage: FhirStorage;
const fhir = createFhirStore({ storage, fhir: r4, resources: ['Patient', 'Observation'] });

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

  // resources must be real resource types of the version.
  // @ts-expect-error Patiant is not an R4 resource type
  createFhirStore({ storage, fhir: r4, resources: ['Patiant'] });
}

// Type-level tests, checked by `pnpm test:types` (tsc). Each line marked with a
// ts-expect-error directive must fail to compile, or the build fails.
import { expectTypeOf } from 'expect-type';
import type { HumanName, Patient, Reference, ResourceTypeMap } from '../../src/index.js';

// A valid patient compiles.
const patient: Patient = {
  resourceType: 'Patient',
  id: 'example',
  active: true,
  name: [{ use: 'official', family: 'Chalmers', given: ['Peter', 'James'] }],
  gender: 'male',
  birthDate: '1974-12-25',
  _birthDate: { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/patient-birthTime', valueDateTime: '1974-12-25T14:35:45-05:00' }] },
  deceasedBoolean: false,
  managingOrganization: { reference: 'Organization/1' },
  generalPractitioner: [{ reference: 'Practitioner/dr-who' }],
};
void patient;

// resourceType is a required literal.
// @ts-expect-error resourceType missing
const noType: Patient = { id: 'x' };
void noType;
// @ts-expect-error wrong resourceType
const wrongType: Patient = { resourceType: 'Observation' };
void wrongType;

// Required code bindings are string literal unions.
expectTypeOf<NonNullable<Patient['gender']>>().toEqualTypeOf<'male' | 'female' | 'other' | 'unknown'>();
// @ts-expect-error not in AdministrativeGender
const badGender: Patient = { resourceType: 'Patient', gender: 'M' };
void badGender;
// @ts-expect-error HumanName.use is a required binding too
const badUse: HumanName = { use: 'nickname-ish' };
void badUse;

// Choice types: only one deceased[x] at a time.
// @ts-expect-error deceasedBoolean and deceasedDateTime together
const twoDeceased: Patient = { resourceType: 'Patient', deceasedBoolean: true, deceasedDateTime: '2020-01-01' };
void twoDeceased;

// References are narrowed to their allowed targets.
// @ts-expect-error managingOrganization must point at an Organization
const wrongTarget: Patient = { resourceType: 'Patient', managingOrganization: { reference: 'Patient/123' } };
void wrongTarget;
const absolute: Reference<ResourceTypeMap['Organization']> = { reference: 'https://example.org/fhir/Organization/1', type: 'Organization' };
void absolute;
const contained: Reference<ResourceTypeMap['Organization']> = { reference: '#org1' };
void contained;
// @ts-expect-error type must match the target
const wrongRefType: Reference<ResourceTypeMap['Organization']> = { type: 'Patient' };
void wrongRefType;
// An untyped Reference accepts any string.
const anyRef: Reference = { reference: 'Whatever/1', type: 'http://example.org/logical-model' };
void anyRef;

// Backbone elements get their own named types.
expectTypeOf<NonNullable<Patient['contact']>[number]['gender']>().toEqualTypeOf<'male' | 'female' | 'other' | 'unknown' | undefined>();

// The resource map links names to types.
expectTypeOf<ResourceTypeMap['Patient']>().toEqualTypeOf<Patient>();

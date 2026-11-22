import { expectTypeOf } from 'expect-type';
import type { Bundle, Observation, ObservationComponent, Resource, ResourceType } from '../../src/index.js';

const bp: Observation = {
  resourceType: 'Observation',
  status: 'final',
  category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
  code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
  subject: { reference: 'Patient/example' },
  effectiveDateTime: '2026-11-22T10:00:00-08:00',
  component: [
    {
      code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] },
      valueQuantity: { value: 120, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
    },
    {
      code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] },
      valueQuantity: { value: 80, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
    },
  ],
};
void bp;

// status is required and bound to ObservationStatus.
// @ts-expect-error status missing
const noStatus: Observation = { resourceType: 'Observation', code: {} };
void noStatus;
// @ts-expect-error not an ObservationStatus code
const badStatus: Observation = { resourceType: 'Observation', status: 'done', code: {} };
void badStatus;

// value[x]: one variant at most, in the resource and in its components.
// @ts-expect-error two value[x] variants
const twoValues: Observation = { resourceType: 'Observation', status: 'final', code: {}, valueString: 'x', valueBoolean: true };
void twoValues;
// @ts-expect-error two value[x] variants in a component
const badComponent: ObservationComponent = { code: {}, valueInteger: 1, valueString: 'one' };
void badComponent;
// @ts-expect-error effective[x] variants are exclusive too
const twoEffective: Observation = { resourceType: 'Observation', status: 'final', code: {}, effectiveDateTime: '2026-01-01', effectiveInstant: '2026-01-01T00:00:00Z' };
void twoEffective;

// subject accepts its four targets and nothing else.
const groupSubject: Observation = { resourceType: 'Observation', status: 'final', code: {}, subject: { reference: 'Group/g1' } };
void groupSubject;
// @ts-expect-error Practitioner is not an allowed subject
const badSubject: Observation = { resourceType: 'Observation', status: 'final', code: {}, subject: { reference: 'Practitioner/p1' } };
void badSubject;

// contentReference: component.referenceRange reuses ObservationReferenceRange.
expectTypeOf<NonNullable<ObservationComponent['referenceRange']>>().toEqualTypeOf<NonNullable<Observation['referenceRange']>>();

// Bundles hold any resource; narrowing on resourceType works.
const bundle: Bundle = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: bp }] };
const first: Resource | undefined = bundle.entry?.[0]?.resource;
if (first?.resourceType === 'Observation') {
  expectTypeOf(first).toEqualTypeOf<Observation>();
}
expectTypeOf<'Patient'>().toMatchTypeOf<ResourceType>();

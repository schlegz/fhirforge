import type { FhirVersionPackage } from '@fhirforge/core';
import type { ResourceTypeMap } from './generated/resource-map.js';

export type * from './generated/index.js';

/**
 * Describes FHIR R4 to the store. Pass it to `createFhirStore({ fhir: r4 })`;
 * the store takes its resource types from `ResourceTypeMap`.
 *
 * Pre-compiled runtime definitions (search parameters, validation rules,
 * required value sets) will be added here as `core` needs them.
 */
export const r4: FhirVersionPackage<ResourceTypeMap> = {
  fhirVersion: '4.0.1',
};

export type R4 = typeof r4;

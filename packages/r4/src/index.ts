import type { FhirVersionPackage } from '@fhirforge/core';
import type { ResourceTypeMap } from './generated/resource-map.js';
import { searchParameters } from './generated/search-parameters.js';

export type * from './generated/index.js';

/**
 * Describes FHIR R4 to the store. Pass it to `createFhirStore({ fhir: r4 })`;
 * the store takes its resource types from `ResourceTypeMap`.
 *
 * It carries the compiled search parameters (runtime data). Frontend code
 * that only needs the types should use `import type` so this data isn't bundled.
 */
export const r4: FhirVersionPackage<ResourceTypeMap> = {
  fhirVersion: '4.0.1',
  searchParameters,
};

export { searchParameters, unsupportedSearchParameters } from './generated/search-parameters.js';

export type R4 = typeof r4;

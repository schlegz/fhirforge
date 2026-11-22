/**
 * The unscoped `fhirforge` package: one install for the common setup.
 *
 * ```ts
 * import { createFhirStore, postgresStorage, r4 } from 'fhirforge';
 * const fhir = createFhirStore({ storage: postgresStorage(pool), fhir: r4, resources: ['Patient'] });
 * ```
 *
 * For tests and local development, add `@fhirforge/pglite`.
 */
export * from '@fhirforge/core';
export * from '@fhirforge/pg';
export * from '@fhirforge/r4';

/**
 * The unscoped `fhirforge` package: one install for the common setup.
 * For now it re-exports the R4 types; `createFhirStore` and the Postgres
 * adapter will be added here as `@fhirforge/core` and `@fhirforge/pg` land.
 */
export * from '@fhirforge/r4';

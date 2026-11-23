# @fhirforge/r4

## 0.9.0

### Patch Changes

- Updated dependencies [9a5ff6a]
  - @fhirforge/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [51fec06]
  - @fhirforge/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [4ec7914]
  - @fhirforge/core@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [fe0a353]
- Updated dependencies [08c1715]
  - @fhirforge/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [fcc6565]
  - @fhirforge/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [8854a6e]
  - @fhirforge/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [ee3db20]
  - @fhirforge/core@0.3.0

## 0.2.0

### Minor Changes

- 095b2cc: Runtime validation: `create` and `update` now validate every resource against the base FHIR spec (unknown elements, cardinality, types, choice elements, required code bindings, primitive formats, contained resources) before the access policy runs, and reject invalid ones with a 400 `FhirError` whose OperationOutcome has one issue per problem, with the element path in `expression` and never the value. The rules are compiled from the StructureDefinitions by `@fhirforge/codegen` and ship as `validation` in `@fhirforge/r4`. Breaking: `createFhirStore` now requires `validation` in the version package, and writes that were accepted before may now fail with 400.

### Patch Changes

- Updated dependencies [095b2cc]
  - @fhirforge/core@0.2.0

## 0.1.0

### Minor Changes

- ab2171d: First public release: strict FHIR R4 types, a typed FHIR store with create, read, update, delete, history and search on Postgres and PGlite, required access control (`authorize`) and audit (`onAudit`) hooks, and TLS enforcement for remote Postgres connections.

### Patch Changes

- Updated dependencies [ab2171d]
  - @fhirforge/core@0.1.0

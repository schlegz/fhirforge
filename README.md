# fhirforge

Embeddable FHIR storage for Node and TypeScript. Add it to any app to store, search and manage FHIR resources in your own Postgres database. It's a library, not a server: your app keeps control of the connection, transactions, auth and HTTP.

> **Status:** early development. The definitions loader and the R4 type generator work; the store (`@fhirforge/core`), Postgres adapter and search are next.

## Packages

| Package | What it is |
| --- | --- |
| `@fhirforge/definitions` | Build-time. Loads official FHIR packages (e.g. `hl7.fhir.r4.core@4.0.1`) from packages.fhir.org into the standard `~/.fhir/packages` cache, indexes StructureDefinitions, ValueSets, CodeSystems and SearchParameters, and builds element trees. |
| `@fhirforge/codegen` | Build-time. Generates strict TypeScript types for a FHIR version (`fhirforge-codegen` CLI). |
| `@fhirforge/r4` | Generated FHIR R4 types: 146 resources, 41 datatypes, 20 primitives, `ResourceTypeMap`. Safe to import in frontend code. |
| `fhirforge` | One install for the common setup. Re-exports `@fhirforge/r4` for now. |

Planned: `@fhirforge/core`, `@fhirforge/pg`, `@fhirforge/pglite`, `@fhirforge/next`, `@fhirforge/express`.

## Why the types are stricter than usual

```ts
import type { Observation, Patient } from '@fhirforge/r4';

const p: Patient = {
  resourceType: 'Patient',
  gender: 'M',                                  // ✗ must be 'male' | 'female' | 'other' | 'unknown'
  deceasedBoolean: true,
  deceasedDateTime: '2020-01-01',               // ✗ only one deceased[x] at a time
  managingOrganization: { reference: 'Patient/1' }, // ✗ must reference an Organization
};
```

- **Required code bindings** become string literal unions, expanded from the value sets in the spec package.
- **Choice types** (`value[x]`) allow exactly one variant. Types with several large choice elements (only `ElementDefinition` in R4) fall back to plain optional fields, because the full cross product is too big for TypeScript.
- **References are generic.** `Reference<Patient | Group>` checks `reference` (`Patient/123`, absolute URLs, `#contained`, `urn:uuid:`) and `type`.
- **Primitive extensions** (`_birthDate`) and backbone element types (`PatientContact`) are included; `contentReference` elements reuse the referenced type.

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm test          # build, unit tests, type tests, example type-check
pnpm gen:r4        # regenerate packages/r4/src/generated from hl7.fhir.r4.core@4.0.1
```

The generated output is committed. A test fails if it drifts from what the generator produces, so regenerate and commit both together.

To run without network access, point the loader at a local folder of FHIR definitions (an extracted package or the spec's definition bundles):

```bash
FHIRFORGE_R4_SOURCE=/path/to/definitions pnpm test
node packages/codegen/dist/cli.js --source /path/to/definitions --out packages/r4/src/generated
```

To type-check the full set of official examples, extract `hl7.fhir.r4.examples` and run:

```bash
pnpm test:examples ~/.fhir/packages/hl7.fhir.r4.examples#4.0.1/package
```

Releases use [Changesets](https://github.com/changesets/changesets); all `@fhirforge/*` packages are versioned together.

## License

Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7. The FHIR specification content these types are generated from is published under CC0.

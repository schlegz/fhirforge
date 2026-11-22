# fhirforge

Embeddable FHIR storage for Node and TypeScript. Add it to any app to store, search and manage FHIR resources in your own Postgres database. It's a library, not a server: your app keeps control of the connection, transactions, auth and HTTP.

> **Status:** early development. Typed create, read, update, delete and history work on Postgres and PGlite. Search, transactions (Bundles), auth hooks and HTTP adapters are next.

## Quick start

```ts
import { PGlite } from '@electric-sql/pglite';
import { createFhirStore } from '@fhirforge/core';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';

const fhir = createFhirStore({
  storage: pgliteStorage(new PGlite()), // or postgresStorage(pool) from @fhirforge/pg
  fhir: r4,
  resources: ['Patient', 'Observation'],
});
await fhir.migrate(); // creates the "fhir" schema and tables; safe on every startup

const patient = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
const same = await fhir.read('Patient', patient.id); // typed as R4 Patient
await fhir.update({ ...same, active: true }, { ifMatch: same.meta.versionId }); // 412 if someone else updated it
await fhir.delete('Patient', patient.id); // read now throws 410; history is kept
const versions = await fhir.history('Patient', patient.id); // newest first
```

Errors are `FhirError`s with an HTTP `status` and a FHIR `outcome` (OperationOutcome): 400 invalid or unsupported, 404 not found, 410 deleted, 412 version conflict.

### Storage layout

Everything lives in its own schema (`fhir` by default, configurable), never mixed with your app's tables:

- `fhir."Patient"`: the current version of each resource as JSONB
- `fhir."Patient_history"`: every version, including delete markers
- `fhir."_migrations"`: applied migration ids

`migrate()` takes a Postgres advisory lock, so several instances starting at once are safe. To run migrations with your own tool instead, `migrationSql(['Patient', 'Observation'])` from `@fhirforge/pg` returns the same schema as plain, idempotent SQL.

## Packages

| Package | What it is |
| --- | --- |
| `@fhirforge/definitions` | Build-time. Loads official FHIR packages (e.g. `hl7.fhir.r4.core@4.0.1`) from packages.fhir.org into the standard `~/.fhir/packages` cache, indexes StructureDefinitions, ValueSets, CodeSystems and SearchParameters, and builds element trees. |
| `@fhirforge/codegen` | Build-time. Generates strict TypeScript types for a FHIR version (`fhirforge-codegen` CLI). |
| `@fhirforge/r4` | Generated FHIR R4 types: 146 resources, 41 datatypes, 20 primitives, `ResourceTypeMap`. Safe to import in frontend code. |
| `@fhirforge/core` | `createFhirStore`: version-neutral, typed from the version package you pass in. No I/O of its own. |
| `@fhirforge/pg` | Postgres storage: takes a `pg` Pool (or any `Database`), with migrations and optimistic locking. |
| `@fhirforge/pglite` | In-process [PGlite](https://pglite.dev) storage: real Postgres with no server, for tests and local development. |
| `fhirforge` | One install for the common setup: re-exports `core`, `pg` and `r4`. |

Planned: search, Bundle transactions, `authorize` / `onAudit` hooks, `@fhirforge/next`, `@fhirforge/express`.

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

## Security

fhirforge is built for apps that store PHI, but it can't make an app HIPAA or SOC 2 compliant on its own. What it does today:

- All SQL uses bind parameters; table and schema names are allow-listed.
- Tables live in their own schema, and the runtime store never changes the schema (only `migrate()` does), so it can run under a role with data-only privileges.
- Writes are atomic and race-free: each update or delete locks the row and writes the current version and its history in one transaction.
- Errors (`FhirError`) report the resource type, id and version, never field values. The library doesn't log resource content.

What your app needs to provide: database encryption at rest (e.g. KMS-backed disks), TLS to the database, access control and audit logging. Planned in fhirforge: TLS enforcement, `authorize` and `onAudit` hooks, field-level encryption, per-parameter search index policies and expunge. [CLAUDE.md](CLAUDE.md) has the full requirements contributors follow.

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm test          # build, unit + store tests (PGlite), type tests, example type-check
pnpm gen:r4        # regenerate packages/r4/src/generated from hl7.fhir.r4.core@4.0.1
```

To also run the store tests against a real Postgres (CI does this):

```bash
FHIRFORGE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test
```

Each run uses throwaway schemas and drops them afterwards.

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

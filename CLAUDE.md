# CLAUDE.md

Guidance for Claude (and humans) working in this repository. Read it before changing code. If something here is out of date, fix this file in the same change.

## What this is

fhirforge is an embeddable FHIR storage library for Node and TypeScript. Apps add it to store, search and manage FHIR resources in their own Postgres database. It is a library, not a server: the host app owns the database connection, transactions, auth and HTTP. Users store PHI (protected health information) with it, so the security rules below are requirements, not suggestions.

## Repository map

```
fhirforge/
├── packages/
│   ├── definitions/   @fhirforge/definitions  Build-time. Loads FHIR packages (registry → ~/.fhir/packages cache, or a local folder),
│   │                                          indexes StructureDefinitions, ValueSets, CodeSystems, SearchParameters; element trees.
│   ├── codegen/       @fhirforge/codegen      Build-time. Generates TypeScript types for a FHIR version. CLI: fhirforge-codegen.
│   ├── core/          @fhirforge/core         createFhirStore, FhirError, the FhirStorage contract. Version-neutral. No I/O.
│   ├── r4/            @fhirforge/r4           Generated R4 types (src/generated/, committed) + the `r4` version descriptor.
│   │   ├── scripts/check-examples.ts          Type-checks FHIR JSON examples against the generated types.
│   │   └── test/{types,examples}/             Type-level tests and example JSON.
│   ├── pg/            @fhirforge/pg           Postgres storage: schema, migrations, optimistic locking. Takes a pg Pool or a Database.
│   ├── pglite/        @fhirforge/pglite       In-process PGlite storage (wraps @fhirforge/pg) for tests and local development.
│   ├── fhirforge/     fhirforge (unscoped)    Re-exports core, pg and r4: one install for the common setup.
│   └── store-tests/   (private)               Integration tests for the store on PGlite and, if configured, real Postgres.
├── .changeset/                                Changesets config; all @fhirforge/* packages are versioned together.
├── .github/workflows/ci.yml                   CI: Postgres 18 service, FHIR package cache, `pnpm test`.
├── tsconfig.base.json                         Shared compiler options (strict, NodeNext, verbatimModuleSyntax, composite).
├── tsconfig.json                              Type-checks tests and scripts that aren't part of a package build.
├── vitest.config.ts                           Runs packages/*/test/**/*.test.ts.
└── README.md                                  Public documentation. Must match the code (see "Keeping README.md in sync").
```

Dependency direction (never add an arrow the other way):

```
definitions ← codegen            (build-time only; nothing at runtime depends on these)
core ← r4 (type-only) ← fhirforge
core ← pg ← pglite
core, pg ← fhirforge
store-tests → everything (private, never published)
```

## Commands

```bash
pnpm install
pnpm build                 # tsc -b over every package, in dependency order
pnpm test                  # build, Vitest (definitions, codegen, store-tests), type tests, example check
pnpm test:types            # type-level tests only (ts-expect-error / expect-type)
pnpm test:examples [dir]   # type-check FHIR JSON examples (default: packages/r4/test/examples)
pnpm gen:r4                # regenerate packages/r4/src/generated from hl7.fhir.r4.core@4.0.1
pnpm changeset             # record a change for the next release
```

Environment variables:

- `FHIRFORGE_R4_SOURCE=<dir>`: load R4 definitions from a local folder instead of packages.fhir.org (offline runs).
- `FHIRFORGE_TEST_DATABASE_URL=postgres://…`: also run store-tests against a real Postgres. Each run creates throwaway `fhir_test_*` schemas and drops them.

Before finishing any change, run `pnpm test`. If you changed `pg` or `core`, also run it with `FHIRFORGE_TEST_DATABASE_URL` set when a Postgres is available: PGlite is single-connection and hides concurrency and locking bugs.

## Toolchain and conventions

- Node ≥ 26 (`.nvmrc`), pnpm 12 (`packageManager`), TypeScript 7, Vitest 5. ESM only (`"type": "module"`).
- `moduleResolution: NodeNext` and `verbatimModuleSyntax`: relative imports end in `.js`; type-only imports use `import type`.
- Each package builds `src/` → `dist/` with project references. Adding a package means: `package.json`, `tsconfig.json` with `references`, the root `build` script, and README.md.
- `core` has no runtime dependencies and no I/O, and must not need `@types/node` or the DOM lib. Anything that talks to a database lives in an adapter package.
- `@fhirforge/r4` must stay safe to import in frontend code: types plus a tiny descriptor, nothing that pulls in Node or database code.
- Adapters take minimal structural interfaces (`PgPoolLike`, `PGliteLike`), not driver types, so drivers stay peer dependencies.
- Errors the store reports on purpose are `FhirError` (HTTP `status` + FHIR `outcome`). Anything else is a bug or infrastructure failure.

### Generated code

- `packages/r4/src/generated/` is generated by `pnpm gen:r4`. Never edit it by hand; change `packages/codegen` and regenerate.
- The output is committed. `packages/codegen/test/generate.test.ts` fails if it drifts from the generator, so commit generator changes and regenerated output together.
- Generate from the official registry package (`hl7.fhir.r4.core`), not third-party copies of the spec: they can contain vendor additions (one added `SubscriptionStatus` to R4).

### Migrations

- Migrations live in `packages/pg/src/migrations.ts` and are append-only. Never edit or reorder one that has shipped; add a new id (`resource:Patient:2`).
- Every statement must be idempotent (`IF NOT EXISTS`), because `migrationSql()` emits them for external tools.
- `migrate()` runs in one transaction under `pg_advisory_xact_lock`. Keep all DDL inside it.
- The runtime store never runs DDL. Only `migrate()` does.

### Tests

- Unit tests: `packages/<pkg>/test/*.test.ts`. Store behavior: `packages/store-tests/test/store.test.ts`, which runs every case on each backend in `backends.ts`.
- Type tests: files under `test/types/` (r4) and `packages/store-tests/test/types.ts`. A line with a ts-expect-error directive must fail to compile; don't write that directive's name in ordinary comments (it is parsed).
- New store behavior needs a test in `store.test.ts`. New type guarantees need a type test.
- Test data must be synthetic. See the security section.

## Keeping README.md in sync

README.md is the public contract. Treat it as part of the code: a change that makes README.md wrong is incomplete.

Update README.md in the same change when you:

| You changed | Update in README.md |
| --- | --- |
| Added, removed or renamed a package | The **Packages** table, the "Planned" line, and the dependency notes |
| Changed a public API (`createFhirStore`, store methods, storage factories, options) | **Quick start** and any example using it. The quick start is mirrored in `packages/store-tests/test/readme.ts`, which must compile: update both together |
| Changed errors or status codes | The error list under **Quick start** |
| Changed tables, schema names or migration behavior | **Storage layout** |
| Regenerated types and the counts changed | The resource / datatype / primitive counts in the **Packages** table |
| Changed what the types enforce (bindings, choice types, references) | **Why the types are stricter than usual** |
| Added or changed a script, env var or toolchain version | **Development** |
| Shipped a planned feature | The **Status** line and remove it from "Planned" |
| Changed security behavior (logging, encryption, TLS, audit, authorization) | Security notes in README.md, and this file |

Before finishing, reread the README sections touched by your change and check every code sample against the current API. Don't document features that don't exist yet as if they do; mark them as planned.

Also keep this file current: if you add a package, script, convention or security control, update the repository map, commands or rules here.

## Security and HIPAA requirements

fhirforge cannot make an app HIPAA or SOC 2 compliant by itself, but it must never be the weak point. Its defaults must support the controls auditors check: access control, audit logging, encryption, integrity, transmission security and retention. Every change that touches resource data, SQL, errors, logging, dependencies or I/O must follow these rules.

### Current status of security controls

Know what exists before you rely on it. Update this table when that changes.

| Control | Status |
| --- | --- |
| Parameterized SQL and identifier allow-listing (`pg/src/sql.ts`) | In place |
| Separate `fhir.*` schema, append-only idempotent migrations | In place |
| Serialized migrations (advisory lock); no DDL at runtime | In place |
| Optimistic locking (`ifMatch`, row lock in update and delete) | In place |
| Errors without resource content (`FhirError` messages carry type + id only) | In place |
| Resource history kept on update and delete | In place |
| TLS required for non-local connections | Planned: must be added to `postgresStorage` |
| `authorize(ctx, action, resource)` hook and `store.as(ctx)` | Planned |
| `onAudit` hook and append-only audit table | Planned |
| Field-level encryption (`encryptor` hook, envelope encryption, key ID per row) | Planned |
| Per-search-parameter index policy (plaintext / blind / not indexed) | Planned with search |
| Expunge (remove all versions and index rows) | Planned |
| Multi-tenancy with Postgres row-level security | Planned (optional) |

### 1. PHI never leaves through side channels

Resource content, identifiers, names, birth dates, addresses, phone numbers, emails, free text, attachments and query parameters can all be PHI.

- **No logging of PHI.** Library code must not call `console.*` or write to any logger with resource content, search parameters, SQL parameters or request bodies. Build-time tools (codegen CLI) may print counts and paths only.
- **Errors carry no PHI.** `FhirError` messages may include the resource type, id and version, never field values. When wrapping a driver error, pass it as `cause` and write a new message; don't interpolate the driver message, which can echo values. Never put SQL parameters in an error.
- **Ids can be PHI.** Server-assigned ids are random UUIDs. Client-assigned ids (update-as-create) might be MRNs or other identifiers. Treat ids as sensitive in anything that leaves the process, and recommend in docs that apps don't use real-world identifiers as ids.
- **No PHI in telemetry.** When tracing (e.g. OpenTelemetry) is added, spans may record resource type, operation, duration and status, never ids of client-assigned resources, content or parameters.
- **No stack traces or internals in outcomes.** OperationOutcome `diagnostics` returned to clients (HTTP adapters, later) must not include stack traces, SQL or driver messages.

### 2. SQL safety

- Every value goes in as a bind parameter (`$1`, `$2`). Never build SQL by concatenating values, including ids, versions, search values and sort keys.
- Identifiers (schema, table, index names) go through `ident()` / `tablesFor()` / `checkSchemaName()` / `checkResourceType()`, which allow-list the characters. Don't loosen those patterns. Never take an identifier from request data without mapping it through a fixed allow-list (e.g. the configured resource types).
- Validate input shape before it reaches SQL (e.g. `vread` rejects non-numeric versions), so malformed input becomes a 400/404, not a database error.
- New search code: compile FHIR search parameters into parameterized SQL from the definitions. A search value must never become SQL text, and modifiers, chains and sort fields must come from allow-lists derived from SearchParameter definitions.

### 3. Database roles and schema

- All tables live in the configured schema (`fhir` by default) and never touch the app's tables.
- Migrations need a privileged role. The runtime store must work with a role that has only `SELECT`, `INSERT`, `UPDATE` on fhirforge tables (and `DELETE` only where expunge requires it). Don't add runtime code that needs DDL or superuser rights. Document required grants when adding tables.
- When the audit table is added, the runtime role gets `INSERT` only on it: no `UPDATE` or `DELETE`.

### 4. Transmission security

- Production connections must use TLS. When adding TLS enforcement to `postgresStorage`, refuse a non-TLS connection to a non-local host unless the app explicitly opts out (e.g. `allowInsecure: true` for local development), and document the opt-out as development-only.
- Don't add network calls at runtime. The only network access in this repo is the build-time FHIR package download in `definitions/src/fetch.ts`, over HTTPS to the configured registry.

### 5. Encryption

- **At rest:** fhirforge relies on database/disk encryption (e.g. RDS or Cloud SQL with KMS keys) and documents it as a requirement. Don't implement custom disk-level crypto.
- **Field-level (planned design):** an optional `encryptor` hook encrypts resource bodies in the app before they reach the database, using envelope encryption with a key ID stored on each row so keys can rotate. Keys never go to the database: don't use `pgcrypto` with keys in SQL.
- Use vetted primitives only: Node's `crypto` (AES-256-GCM with a random 96-bit nonce per encryption) or a well-known library. Never invent a cipher mode, reuse nonces, or use ECB, unauthenticated CBC, MD5 or SHA-1 for security purposes.
- **Search indexes hold readable copies of PHI.** Each search parameter gets a policy: `plaintext` (full search), `blind` (HMAC of the normalized value with a separate key; exact match only) or `none`. Decided: `Patient.name` and `Patient.birthdate` default to `plaintext`, with `blind` available per parameter. Blind indexes support only exact match: document which searches stop working. Don't add order-preserving encryption.

### 6. Integrity, history and retention

- Every write is atomic: the current row and its history row are written in one transaction. Keep it that way for new write paths (Bundles, search index rows, audit rows).
- History keeps PHI after update and delete. When adding expunge, it must remove every version, every search index row and every derived copy for that resource, in one transaction, and be its own explicitly named operation (never a side effect of `delete`).
- Optimistic locking must stay race-free: read-then-write paths lock the row (`FOR UPDATE`) inside the transaction.

### 7. Access control and audit (planned; requirements for when they're built)

- Every store operation will go through `store.as(ctx)` and an app-supplied `authorize(ctx, action, resourceType, resource?)` policy. Default-deny: if a policy is configured and doesn't allow the action, throw a 403 `FhirError` with code `forbidden`. Searches must filter results by the policy, not just check the query.
- The `onAudit` hook receives who (from ctx), what action, which resource type and id, when, and the outcome. It records ids and actions, never resource content. Audit failures must not be silently dropped: make the behavior explicit (fail the operation or call an error hook).
- Bypassing authorization (e.g. for migrations or system jobs) must be explicit and visible in code (`store.asSystem()` or similar), never a default.

### 8. Test data and fixtures

- Only synthetic data. Never commit real patient data, real names with real identifiers, or exports from production systems, even "anonymized" ones. Use obviously fake values (`Doe`, `example.org`, `urn:oid:1.2.36…` test OIDs).
- Don't paste real PHI into issues, test names, snapshots, commit messages or this repository's docs.

### 9. Dependencies and supply chain

- Keep runtime dependencies minimal: `core` has none; adapters depend on `core` and use drivers as peer dependencies. Justify every new runtime dependency in the change description.
- Commit `pnpm-lock.yaml` and install with `--frozen-lockfile` in CI. Only allow install scripts that are needed (`allowBuilds` in `pnpm-workspace.yaml`).
- `definitions/src/fetch.ts` extracts tarballs with `tar`. Keep its safe defaults: never set `preservePaths`, and extract only into the cache folder. Downloads go to a temp file and are moved into the cache only after a complete extract.
- Don't add code that executes content from FHIR packages or user data (no `eval`, `new Function`, dynamic `import()` of data paths).

### 10. Secrets

- No credentials, connection strings with passwords, keys or tokens in code, tests, fixtures or docs. Tests read `FHIRFORGE_TEST_DATABASE_URL` from the environment; CI's throwaway Postgres password is the only exception.
- Encryption and HMAC keys (when added) come from the app (e.g. a KMS client), never from fhirforge config files or defaults. There is no default key.

## Security review checklist

Run this on every change before finishing. If any answer is "no" or "not sure", fix the code or flag it explicitly in your summary.

1. **Data flow:** list every place the change reads or writes resource data, ids, search values or SQL. For each, confirm PHI doesn't reach logs, errors, telemetry or outcomes.
2. **SQL:** every value is a bind parameter; every identifier passes the allow-list helpers; no string-built SQL from input.
3. **Errors:** new `FhirError`s carry type, id and version only; wrapped driver errors use `cause`; no driver message, parameter or stack in the message.
4. **Transactions:** multi-row writes (current + history + indexes + audit) happen in one transaction; read-then-write paths lock the row.
5. **Privileges:** the runtime path needs no DDL and no new grants, or the required grants are documented.
6. **Migrations:** new migrations are appended, idempotent, inside `migrate()`'s transaction; no shipped migration was edited.
7. **Crypto (if touched):** vetted primitives, random nonces, authenticated encryption, keys supplied by the app, key ID stored with ciphertext.
8. **Indexes (if touched):** each new searchable field has an explicit plaintext / blind / none policy, and the default is documented.
9. **Authorization and audit (once built):** the new operation goes through `authorize` and `onAudit`; no silent bypass.
10. **Dependencies:** no new runtime dependency without justification; lockfile updated; no new install scripts allowed without reason.
11. **Tests:** synthetic data only; a test covers the security-relevant behavior (e.g. an error message contains no field values; a stale `ifMatch` fails).
12. **Docs:** README.md and this file reflect the change, including the security status table.

### How to bring code into line

When you find code that breaks these rules, fix it the same way every time:

- **A log or error includes PHI:** replace the value with the resource type and id (or remove it), keep the original error as `cause`, and add a test asserting the message doesn't contain the field value.
- **String-built SQL:** convert values to bind parameters; route identifiers through `ident()` / `tablesFor()`; add a test with a hostile value (e.g. `'); DROP TABLE x; --`) proving it's stored literally or rejected.
- **A write path outside a transaction:** move all statements for one logical write into `database.transaction`, lock the current row first if the write depends on it, and add a concurrent test in `store-tests` (it runs on real Postgres in CI).
- **A runtime DDL statement:** move it into a new migration in `migrations.ts`.
- **A feature that stores a new copy of PHI** (index, cache, audit detail): add it to the expunge requirements above, give it a policy, and document it in README.md's storage layout.
- **A missing planned control that the change depends on** (e.g. you're adding an HTTP adapter and `authorize` doesn't exist yet): don't ship a weaker version quietly. Stop and say what's missing, or implement the control first.

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
│   │   ├── src/fhirpath.ts                    Parser for the FHIRPath subset used by search expressions (rejects the rest).
│   │   ├── src/search.ts                      Compiles SearchParameters into path steps → generated search-parameters.ts.
│   │   └── src/validation.ts                  Compiles StructureDefinitions into element rules → generated validation.ts.
│   ├── core/          @fhirforge/core         createFhirStore, FhirError, the FhirStorage contract. Version-neutral. No I/O.
│   │   ├── src/store.ts                       Scopes (as / asSystem), authorization checks, audit, data operations,
│   │   │                                      write planning (planCreate / planUpdate / planDelete), transaction / batch.
│   │   ├── src/bundle.ts                      Bundle request parsing, urn:uuid reference resolution, response entries, limits.
│   │   ├── src/access.ts                      authorize / onAudit types: AuthorizeRequest, StoreAuditEvent, StoreAction.
│   │   ├── src/search/                        Index extraction (index-rows.ts), query parsing (query.ts), value
│   │   │                                      normalization (values.ts), compiled-parameter types (types.ts).
│   │   └── src/validation/                    Runtime validator (validate.ts) walking the compiled rules (types.ts),
│   │                                          fixed primitive format checks (primitives.ts).
│   ├── r4/            @fhirforge/r4           Generated R4 types, search-parameters.ts and validation.ts (src/generated/,
│   │                                          committed) + the `r4` descriptor, which carries the search and validation data.
│   │   ├── scripts/check-examples.ts          Type-checks FHIR JSON examples and runs runtime validation on them.
│   │   └── test/{types,examples}/             Type-level tests and example JSON.
│   ├── pg/            @fhirforge/pg           Postgres storage: schema, migrations, optimistic locking. Takes a pg Pool or a Database.
│   │   ├── src/search.ts                      Search SQL builder and index row writes (bind parameters only).
│   │   └── src/transport.ts                   TLS enforcement for pg Pools.
│   ├── pglite/        @fhirforge/pglite       In-process PGlite storage (wraps @fhirforge/pg) for tests and local development.
│   ├── http/          @fhirforge/http         FHIR REST handler: fetch-style (Next.js, Hono, Bun, Deno) + toNodeHandler (Express, node:http):
│   │                                          routing, bodies (size limit), headers, searchset/history Bundles, /metadata.
│   ├── fhirforge/     fhirforge (unscoped)    Re-exports core, pg and r4: one install for the common setup.
│   └── store-tests/   (private)               Integration tests on PGlite and, if configured, real Postgres:
│                                              store.test.ts (CRUD, history, validation on write), search.test.ts,
│                                              bundle.test.ts (transaction / batch, rollback, races, deadlock),
│                                              http.test.ts (REST handler over real Request objects),
│                                              audit.test.ts (audit table, atomicity, append-only, runtime-role grants),
│                                              validation.test.ts (each rule type), access.test.ts
│                                              (authorize / onAudit, races), transport.test.ts,
│                                              types.ts (type-level API tests), readme.ts (README quick start).
├── .changeset/                                Changesets config; all @fhirforge/* packages are versioned together.
├── .github/workflows/ci.yml                   CI: Postgres 18 service, FHIR package cache, `pnpm test`.
├── .github/workflows/release.yml              Release: "Version packages" PR, then npm publish via trusted publishing.
├── docs/roadmap.md                            What's done, what's next (in order), open decisions. Start here for new work.
├── docs/design/                               Design docs for upcoming work (drafts until reviewed), e.g. bundles.md.
├── scripts/publish.mjs                        Packs (pnpm) and publishes (npm) unpublished versions, with safety checks;
│                                              safe to re-run (publish-errors.mjs recognizes duplicate-version refusals).
├── tsconfig.base.json                         Shared compiler options (strict, NodeNext, verbatimModuleSyntax, composite).
├── tsconfig.json                              Type-checks tests and scripts that aren't part of a package build.
├── vitest.config.ts                           Runs packages/*/test/**/*.test.ts and scripts/**/*.test.mjs.
└── README.md                                  Public documentation. Must match the code (see "Keeping README.md in sync").
```

Dependency direction (never add an arrow the other way):

```
definitions ← codegen            (build-time only; nothing at runtime depends on these)
core ← r4 (type-only) ← fhirforge
core ← pg ← pglite
core ← http                      (REST; web-standard Request/Response + a structural Node req/res adapter, no framework dependency)
core, pg ← fhirforge
store-tests → everything (private, never published)
```

## Commands

```bash
pnpm install
pnpm build                 # tsc -b over every package, in dependency order
pnpm test                  # build, Vitest (definitions, codegen, core, store-tests), type tests, example check
pnpm test:types            # type-level tests only (ts-expect-error / expect-type)
pnpm test:examples [--no-types] [dir]  # type-check and validate FHIR JSON examples (default: packages/r4/test/examples)
pnpm gen:r4                # regenerate packages/r4/src/generated from hl7.fhir.r4.core@4.0.1
pnpm changeset             # record a change for the next release
pnpm release:check         # build and run every publish check without publishing
```

Releases (see README.md > Releasing) run from `.github/workflows/release.yml` via `changesets/action`; `scripts/publish.mjs` does the publishing. Don't publish from a laptop except the documented first release.

Environment variables:

- `FHIRFORGE_R4_SOURCE=<dir>`: load R4 definitions from a local folder instead of packages.fhir.org (offline runs).
- `FHIRFORGE_TEST_DATABASE_URL=postgres://…`: also run store-tests against a real Postgres. Each run creates throwaway `fhir_test_*` schemas and drops them.

Before finishing any change, run `pnpm test`. If you changed `pg` or `core`, also run it with `FHIRFORGE_TEST_DATABASE_URL` set when a Postgres is available: PGlite is single-connection and hides concurrency and locking bugs.

## Toolchain and conventions

- Node ≥ 26 (`.nvmrc`), pnpm 12 (`packageManager`), TypeScript 7, Vitest 5. ESM only (`"type": "module"`).
- `moduleResolution: NodeNext` and `verbatimModuleSyntax`: relative imports end in `.js`; type-only imports use `import type`.
- Each package builds `src/` → `dist/` with project references. Adding a package means: `package.json`, `tsconfig.json` with `references`, the root `build` script, and README.md.
- `core` has no runtime dependencies and no I/O, and must not need `@types/node` or the DOM lib. Anything that talks to a database lives in an adapter package.
- `@fhirforge/r4` must stay safe to import in frontend code: types, plus the `r4` descriptor and its generated search and validation data (plain JSON-like objects). Nothing that pulls in Node or database code. Frontends should `import type` so that data isn't bundled.
- Search is compiled, not interpreted: SearchParameter FHIRPath expressions become path data at build time (`codegen/src/search.ts`), and the runtime only walks that data (`core/src/search/index-rows.ts`). Never add a runtime FHIRPath evaluator, `eval` or `new Function`. An expression outside the subset must be reported in `unsupportedSearchParameters`, never approximated.
- Validation is compiled the same way: `codegen/src/validation.ts` turns StructureDefinitions into element rules, and `core/src/validation/validate.ts` walks them. Primitive formats are fixed, linear-time patterns in `core/src/validation/primitives.ts`; never build a `RegExp` from definition data (spec regexes can backtrack badly). Look up rules through `Map`s, never by indexing plain objects with input keys (`constructor`, `__proto__`). A required binding the validator can't check goes into `unvalidatedBindings`, never guessed.
- `createFhirStore` validates every `create` and `update` (no opt-out), before the policy check and before any storage call, and requires `validation` in the version package. Every new write path (Bundle entries, patch results) must validate the same way.
- Adapters take minimal structural interfaces (`PgPoolLike`, `PGliteLike`), not driver types, so drivers stay peer dependencies.
- Errors the store reports on purpose are `FhirError` (HTTP `status` + FHIR `outcome`). Anything else is a bug or infrastructure failure.

### Generated code

- `packages/r4/src/generated/` (types, `search-parameters.ts` and `validation.ts`) is generated by `pnpm gen:r4`. Never edit it by hand; change `packages/codegen` and regenerate.
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
| Added, removed or renamed a package | The **Packages** table, the "Planned" line, the dependency notes, the package's own README.md, and `ORDER` in `scripts/publish.mjs` |
| Changed the release process or workflow | **Releasing** |
| Changed a public API (`createFhirStore`, store methods, storage factories, options) | **Quick start** and any example using it. The quick start is mirrored in `packages/store-tests/test/readme.ts`, which must compile: update both together |
| Changed errors or status codes | The error list under **Quick start** |
| Changed tables, schema names, migration behavior or required database privileges | **Storage layout** |
| Changed validation: rules checked, what's not checked, error shape | **Validation** (under Quick start) |
| Changed search: parameter types, modifiers, prefixes, `_sort` / `_count`, policies, or what's unsupported | **Search** (its table and the "Not supported yet" list) |
| Regenerated types and the counts changed | The resource / datatype / primitive counts in the **Packages** table |
| Changed what the types enforce (bindings, choice types, references) | **Why the types are stricter than usual** |
| Added or changed a script, env var or toolchain version | **Development** |
| Shipped a planned feature | The **Status** line and remove it from "Planned" |
| Changed security behavior (logging, encryption, TLS, audit, authorization) | Security notes in README.md, and this file |

Before finishing, reread the README sections touched by your change and check every code sample against the current API. Don't document features that don't exist yet as if they do; mark them as planned.

Also keep this file current: if you add a package, script, convention or security control, update the repository map, commands or rules here.

Keep `docs/roadmap.md` current too: when you finish a roadmap item, move it to **Done**; when you find new work or make a decision listed under **Open decisions**, record it there.

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
| Errors without resource content (`FhirError` messages carry type, id, version or parameter name only) | In place |
| Resource history kept on update and delete | In place |
| TLS required for non-local `pg` Pool connections (`pg/src/transport.ts`, `allowInsecure` opt-out) | In place |
| Errors never echo search values, invalid ids or invalid type names | In place (tested in `search.test.ts`) |
| Search index rows written in the write transaction; removed by FK cascade with the resource | In place |
| Search limits: `_count` ≤ 1000, ≤ 100 values per parameter, ≤ 50 clauses, `_offset` ≤ 100000 | In place |
| REST handler (`@fhirforge/http`, fetch-style and `toNodeHandler`): caller context required (401), generic 500s, `Cache-Control: no-store`, body limit (413), JSON only | In place (tested in `http.test.ts`) |
| Bundle transactions: all writes in one database transaction (`writeAll`, rows locked in a fixed order); every entry validated, authorized, pinned and audited; ≤ 100 entries, ≤ 10 searches | In place (tested in `bundle.test.ts`) |
| `authorize` policy (required; `'allow-all'` is the explicit opt-out), `store.as(ctx)`, `store.asSystem(reason)` | In place |
| Denied reads/updates/deletes indistinguishable from missing (404); writes pinned to the approved version (412 on change) | In place (tested, including races) |
| `onAudit` hook: every data operation, including denials and failures, without content or search values | In place |
| Runtime validation of every write against the base spec (paths-only issues, ≤ 100 issues, nesting depth ≤ 64, linear-time primitive checks) | In place (tested in `validation.test.ts`, `store.test.ts`, `access.test.ts`) |
| Built-in append-only audit table (`audit: { table: true, actor }`): rows written in the write's transaction; INSERT-only for the runtime role; triggers refuse UPDATE / DELETE / TRUNCATE | In place (tested in `audit.test.ts`, including a restricted role on Postgres) |
| Field-level encryption (`encryptor` hook, envelope encryption, key ID per row) | Planned |
| Per-search-parameter index policy | Partly: `plaintext` and `none` in place; `blind` planned (rejected at `createFhirStore`) |
| Expunge (remove all versions and index rows) | Planned |
| Multi-tenancy with Postgres row-level security | Planned (optional) |

### 1. PHI never leaves through side channels

Resource content, identifiers, names, birth dates, addresses, phone numbers, emails, free text, attachments and query parameters can all be PHI.

- **No logging of PHI.** Library code must not call `console.*` or write to any logger with resource content, search parameters, SQL parameters or request bodies. Build-time tools (codegen CLI) may print counts and paths only.
- **Errors carry no PHI.** `FhirError` messages may include the resource type, id, version and search parameter name, never field values or search values. Validation issues carry the element path and a fixed reason only; element names from the input appear only if they match a strict name pattern (`SAFE_NAME` in `core/src/validation/validate.ts`). Names from the request go into messages only if they match a strict name pattern (see `safeName` in `core/src/search/query.ts`); otherwise use a placeholder. When wrapping a driver error, pass it as `cause` and write a new message; don't interpolate the driver message, which can echo values. Never put SQL parameters in an error.
- **Bundle errors** add the entry index (`entry[3]: …`) and never echo `request.url` or `fullUrl` (they can contain identifiers).
- **Ids can be PHI.** Server-assigned ids are random UUIDs. Client-assigned ids (update-as-create) might be MRNs or other identifiers. Treat ids as sensitive in anything that leaves the process, and recommend in docs that apps don't use real-world identifiers as ids.
- **No PHI in telemetry.** When tracing (e.g. OpenTelemetry) is added, spans may record resource type, operation, duration and status, never ids of client-assigned resources, content or parameters.
- **No stack traces or internals in outcomes.** OperationOutcome `diagnostics` returned to clients must not include stack traces, SQL or driver messages. In `@fhirforge/http`, only `FhirError`s become their own outcome; everything else is a fixed "Internal server error" 500, and the error goes to the app's `onError`, never into the response or a log.
- **HTTP adapters** (`@fhirforge/http`: `createFhirHandler`, and `toNodeHandler` for Node's req/res): every data request needs a context from the app's `context` function (no default; 401 without it, before the store is touched). Responses carry `Cache-Control: no-store`. Bodies are read with a byte limit (`maxBodyBytes`) and never echoed in errors. Only `/metadata` is public; don't add other public routes. New framework support goes into `@fhirforge/http` as a thin adapter around `createFhirHandler` (like `toNodeHandler`), with structural types for the framework's objects, never a framework dependency.

### 2. SQL safety

- Every value goes in as a bind parameter (`$1`, `$2`). Never build SQL by concatenating values, including ids, versions, search values and sort keys.
- Identifiers (schema, table, index names) go through `ident()` / `tablesFor()` / `checkSchemaName()` / `checkResourceType()`, which allow-list the characters. Don't loosen those patterns. Never take an identifier from request data without mapping it through a fixed allow-list (e.g. the configured resource types).
- Validate input shape before it reaches SQL (e.g. `vread` rejects non-numeric versions), so malformed input becomes a 400/404, not a database error.
- Search SQL is built in `pg/src/search.ts` through the `Sql.bind()` helper only. A search value must never become SQL text. Parameter codes, modifiers, prefixes and sort keys are validated in `core/src/search/query.ts` against the compiled definitions and fixed allow-lists before they reach the adapter; keep it that way for new features (chaining, `_include`, composite).
- Escape LIKE wildcards (`likeEscape`) for any pattern built from a search value, and bind range parameters lazily (only when the SQL uses them): Postgres rejects bind parameters it can't type.
- Keep the request limits (`MAX_COUNT`, `MAX_VALUES`, `MAX_CLAUSES`, `MAX_OFFSET`, `MAX_BUNDLE_ENTRIES`, `MAX_BUNDLE_SEARCHES`) in place; new search features (chains, includes) need their own limits so one request can't make the database do unbounded work.

### 3. Database roles and schema

- All tables live in the configured schema (`fhir` by default) and never touch the app's tables.
- Migrations need a privileged role. The runtime store must work with a role that has only `SELECT`, `INSERT`, `UPDATE` on fhirforge tables, plus `DELETE` on the search index tables (index rows are replaced on every write) and, later, wherever expunge requires it. Don't add runtime code that needs DDL or superuser rights. Document required grants when adding tables.
- The runtime role gets `INSERT` only on `_audit`: no `SELECT`, `UPDATE` or `DELETE`. Never use `RETURNING` on audit inserts or read the table at runtime (it would need `SELECT`). `audit.test.ts` checks the documented grants with a restricted role on Postgres; update both together.

### 4. Transmission security

- Production connections must use TLS. `postgresStorage` refuses a `pg` Pool that connects to a non-local host without `ssl` or `sslmode=require` / `verify-ca` / `verify-full` (`sslmode=prefer` doesn't count: it can fall back to plaintext). `allowInsecure: true` is the development-only opt-out. Don't weaken the check, and never include the connection string in its error (it can hold a password).
- Don't add network calls at runtime. The only network access in this repo is the build-time FHIR package download in `definitions/src/fetch.ts`, over HTTPS to the configured registry.

### 5. Encryption

- **At rest:** fhirforge relies on database/disk encryption (e.g. RDS or Cloud SQL with KMS keys) and documents it as a requirement. Don't implement custom disk-level crypto.
- **Field-level (planned design):** an optional `encryptor` hook encrypts resource bodies in the app before they reach the database, using envelope encryption with a key ID stored on each row so keys can rotate. Keys never go to the database: don't use `pgcrypto` with keys in SQL.
- Use vetted primitives only: Node's `crypto` (AES-256-GCM with a random 96-bit nonce per encryption) or a well-known library. Never invent a cipher mode, reuse nonces, or use ECB, unauthenticated CBC, MD5 or SHA-1 for security purposes.
- **Search indexes hold readable copies of PHI.** Each search parameter gets a policy (`createFhirStore({ search: { policy } })`, keyed `ResourceType.code`): `plaintext` (full search), `blind` (HMAC of the normalized value with a separate key; exact match only) or `none`. Decided: `Patient.name` and `Patient.birthdate` default to `plaintext`, with `blind` available per parameter. Blind indexes support only exact match: document which searches stop working. Don't add order-preserving encryption.

### 6. Integrity, history and retention

- Every write is atomic: the current row, its history row and its search index rows are written in one transaction. With the audit table on, the operation's audit rows are written in that same transaction (`WriteOptions.audit`); keep it that way for new write paths. A Bundle transaction goes through `FhirStorage.writeAll`, which applies all its writes in one database transaction and locks rows in a fixed code-unit order (resource type, then id) so concurrent transactions can't deadlock; never sort with `localeCompare` there. `reindex` rewrites one resource per transaction with the row locked, so it never overwrites a concurrent write.
- Index tables reference the resource row with `ON DELETE CASCADE`. Any new derived table holding resource data must do the same (or be covered by expunge explicitly).
- History keeps PHI after update and delete. When adding expunge, it must remove every version, every search index row and every derived copy for that resource, in one transaction, and be its own explicitly named operation (never a side effect of `delete`).
- Optimistic locking must stay race-free: read-then-write paths lock the row (`FOR UPDATE`) inside the transaction.

### 7. Access control and audit

How it works now (`core/src/store.ts`, `core/src/access.ts`); keep these properties when changing it:

- `authorize` is required at `createFhirStore`: a policy function or the literal `'allow-all'`. Never add an implicit default.
- With a policy, data operations go through `store.as(ctx)`. Calling them on the store directly throws 403. `store.asSystem(reason)` bypasses the policy, needs a non-empty reason and is audited as `system: true`. Don't add other bypasses.
- Only `true` (or, for `search`, `{ filter }`) allows. Anything else, including a thrown error, denies.
- The policy sees the content: the new resource for `create`; the stored resource for `read`, `vread`, `history` and `delete`; both stored and new for `update`. Check after loading, before returning or writing.
- Denied `read`, `vread`, `history`, `update` (of a stored resource) and `delete` throw the same 404 as a missing resource. Denied `create`, `search`, and update with denied new content throw 403. Don't leak existence in error messages.
- Writes after a policy check are pinned: `update` passes `ifMatch` (the approved version) or `ifNoneExist`, and `delete` passes `ifMatch`, so a concurrent change fails with 412. Every write path builds its write with `planCreate` / `planUpdate` / `planDelete` in `store.ts` (Bundles do too); a new one (patch) must as well.
- Bundles: the policy and `onAudit` run outside the database transaction (plan first, then one `writeAll`), never inside it. The Bundle itself isn't authorized; each entry is, with `urn:uuid:` references already resolved. Each entry is audited as its own event, plus one `transaction` / `batch` event with the entry count; a Bundle rejected before any entry is processed (shape, validation, limits) gets only the Bundle event. In a batch, only `FhirError`s become an entry's response; anything else (including audit failures) fails the batch.
- Search: the policy's `filter` is ANDed into the query (it can't set `_count`, `_offset` or `_sort`), and every result is checked again as a `read`. If any result is removed, `total` is omitted.
- `onAudit` gets one `StoreAuditEvent` per data operation (success, denied, not-found, error): `ctx`, system and reason, action, resource type, id, version, outcome, status, and for searches the parameter names and returned ids. Never add resource content, search values or error messages to events.
- If `onAudit` throws, the operation fails and the result is withheld (writes have already committed), unless the app passes `onAuditError`. Don't swallow audit errors anywhere else.
- The audit table (`audit: { table: true, actor }`): successful writes pass their rows to the storage write (`withRows` in `audited`, `pendingRows` for Bundles), so data and audit commit together; reads and failures go through `storage.recordAudit`. Table failures are never swallowed (`onAuditError` doesn't apply to them). Rows hold the event's fields plus `actor` from the app's mapping: never store `ctx`, content, search values or error messages. A Bundle's entries share the Bundle's `operationId`. fhirforge never deletes audit rows, and expunge (later) must not either.
- `migrate()` and `reindex()` are maintenance operations on the store and are not audited. Don't expose resource data through them.
- New data operations (`_include`, chained search, new HTTP adapters) must go through the same scope, policy and audit path. An `_include`d or chained resource is a read of that resource and needs its own check.

### 8. Test data and fixtures

- Only synthetic data. Never commit real patient data, real names with real identifiers, or exports from production systems, even "anonymized" ones. Use obviously fake values (`Doe`, `example.org`, `urn:oid:1.2.36…` test OIDs).
- Don't paste real PHI into issues, test names, snapshots, commit messages or this repository's docs.

### 9. Dependencies and supply chain

- Keep runtime dependencies minimal: `core` has none; adapters depend on `core` and use drivers as peer dependencies. Justify every new runtime dependency in the change description.
- Commit `pnpm-lock.yaml` and install with `--frozen-lockfile` in CI. Only allow install scripts that are needed (`allowBuilds` in `pnpm-workspace.yaml`).
- **Publishing:** packages are published only from `release.yml` using npm trusted publishing (OIDC) with provenance. Never add an npm token (`NPM_TOKEN`, `NODE_AUTH_TOKEN`) to the repository or workflows; it would also disable OIDC. Keep the workflow's permissions minimal (`contents`, `pull-requests`, `id-token` on the release job only) and keep `pnpm test` before publish.
- **What ships:** each package's `files` is `["dist"]`, plus README.md and LICENSE. `scripts/publish.mjs` rejects anything else in a tarball and any leftover `workspace:` version: don't loosen those checks. Every published package needs its own README.md and LICENSE.
- **Versions:** all published packages are in one Changesets `fixed` group. Add new published packages to `ORDER` in `scripts/publish.mjs` (dependency order) and to the README's packages table.
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
8. **Search and indexes (if touched):** new values reach SQL only through `bind()`; new parameters, modifiers or sort keys are validated against allow-lists; request limits cover the new feature; each new searchable field honors the plaintext / none policy, and the default is documented; new derived data cascades with the resource.
9. **Validation:** a new write path validates the resource (`createValidator` rules) before the policy check; new validation rules are compiled data, report paths only, and stay bounded (depth, issue count, linear-time checks).
10. **Authorization and audit:** the new operation runs inside a scope, calls the policy with the content it touches, pins writes to the approved version, hides denied reads as 404, and emits one audit event without content or values; no new bypass.
11. **Dependencies:** no new runtime dependency without justification; lockfile updated; no new install scripts allowed without reason.
12. **Tests:** synthetic data only; a test covers the security-relevant behavior (e.g. an error message contains no field values; a stale `ifMatch` fails).
13. **Docs:** README.md and this file reflect the change, including the security status table.

### How to bring code into line

When you find code that breaks these rules, fix it the same way every time:

- **A log or error includes PHI:** replace the value with the resource type and id (or remove it), keep the original error as `cause`, and add a test asserting the message doesn't contain the field value.
- **String-built SQL:** convert values to bind parameters; route identifiers through `ident()` / `tablesFor()`; add a test with a hostile value (e.g. `'); DROP TABLE x; --`) proving it's stored literally or rejected.
- **A write path outside a transaction:** move all statements for one logical write into `database.transaction`, lock the current row first if the write depends on it, and add a concurrent test in `store-tests` (it runs on real Postgres in CI).
- **A runtime DDL statement:** move it into a new migration in `migrations.ts`.
- **A feature that stores a new copy of PHI** (index, cache, audit detail): add it to the expunge requirements above, give it a policy, and document it in README.md's storage layout.
- **A data path that skips the policy** (e.g. a helper that calls `storage` directly): route it through `operations(scope)` in `store.ts`, add a denied-access test in `access.test.ts` (including that the denied result isn't returned or audited as success).
- **A missing planned control that the change depends on** (e.g. you're adding a feature that needs the built-in audit table): don't ship a weaker version quietly. Stop and say what's missing, or implement the control first.

# Roadmap

What's built, what's next and in what order, and the decisions still open. Keep this current: when you finish an item, move it to **Done** and update README.md and CLAUDE.md in the same change (CLAUDE.md, "Keeping README.md in sync"). Claude: read CLAUDE.md first; its security rules apply to everything below.

_Last updated: 2026-11-22, after the 0.2.0 release from CI._

## Done

- **0.1.0 published** to npm, all seven packages (`@fhirforge/definitions`, `codegen`, `core`, `r4`, `pg`, `pglite`, unscoped `fhirforge`). `fhirforge@1.0.0` (name placeholder) is deprecated and `latest` points to 0.1.0.
- **Types:** strict R4 types generated from `hl7.fhir.r4.core@4.0.1` (146 resources), with literal code bindings, exclusive choice types and generic `Reference<T>`.
- **Store:** create, read, vread, update (with `ifMatch`), delete and history on Postgres and PGlite; migrations under an advisory lock.
- **Search:** SearchParameters compiled at build time; string, token, date, reference, quantity, number and uri; prefixes, common modifiers, `_sort`, `_count`, `_offset`; per-parameter `plaintext` / `none` policy.
- **Security:** TLS enforcement for remote `pg` Pools; required `authorize` policy with `as(ctx)` / `asSystem(reason)`; `onAudit`; denied reads hidden as 404; writes pinned to the approved version; errors never echo values.
- **Runtime validation** (roadmap item 2): rules compiled from the StructureDefinitions into `@fhirforge/r4`'s `validation`, walked by `core/src/validation/`. Checks unknown elements, cardinality, types, choice elements, required `code` bindings, primitive formats and contained resources. `create` / `update` validate before the policy check; 400 with one path-only issue per problem. All 5,293 valid R4 spec examples pass; the 16 that break the base spec are rejected (`pnpm test:examples --no-types <examples package>`).
- **Release pipeline:** Changesets, `scripts/publish.mjs` with tarball checks, `release.yml` for trusted publishing.
- **Releases from CI** (roadmap item 1): 0.2.0 (runtime validation) went out from `release.yml` on 2026-11-22 via trusted publishing, with a provenance attestation on every package. It took four attempts of the release job; what went wrong is under **Release notes for maintainers** below.

## Next, in order

### 1. Bundle transactions and batches

Design draft for review: [design/bundles.md](design/bundles.md).

- `transaction`: all entries in one database transaction, all-or-nothing; resolve `urn:uuid:` `fullUrl` references between entries (see `packages/r4/test/examples/bundle-transaction.json`); return a `transaction-response` Bundle.
- `batch`: entries independent, each with its own status.
- Every entry goes through validation (`createValidator`, before the policy), `authorize`, the version guard (`ifMatch` / `ifNoneExist`) and `onAudit`, exactly like single operations (CLAUDE.md §7).
- Needs storage support for running several writes in one transaction (extend the `FhirStorage` contract).
- Limits: maximum entries per Bundle.

### 2. HTTP adapter: `@fhirforge/next` (then `@fhirforge/express`)

- A Next.js route handler mapping FHIR REST (`GET/POST/PUT/DELETE /[type]/[id]`, `_history`, search, Bundles at the base URL) to `store.as(ctx)`.
- The app supplies `ctx` from its own auth; there is no default context.
- Responses: FHIR JSON, `ETag` / `Last-Modified`, `If-Match` → `ifMatch`, `Location` on create; errors as OperationOutcome without stack traces or driver messages.
- Search results as `searchset` Bundles with `self` / `next` links.
- `/metadata` CapabilityStatement generated from the configured resources and compiled search parameters.

### 3. Search: chaining and `_include` / `_revinclude`

- `subject:Patient.name=doe`, `_include=Observation:subject`, `_revinclude=Observation:patient`.
- Each included or chained resource is a read and goes through `authorize` (CLAUDE.md §7); limits on chain depth and include count.

## Later

- **Built-in audit table:** an append-only `fhir._audit` table (insert-only for the runtime role) as a ready-made `onAudit` sink, written in the same transaction as writes.
- **Expunge:** remove every version, index row and derived copy of a resource in one transaction (CLAUDE.md §6).
- **Blind indexes:** the `blind` search policy (HMAC with an app-supplied key, exact match only).
- **Field-level encryption:** `encryptor` hook, envelope encryption, key ID per row (CLAUDE.md §5).
- **Profiles:** generated US Core types and profile validation.
- **Validation gaps:** invariants (FHIRPath constraints; would need a compiled subset like search, never a runtime evaluator), reference target types (the TS types already check them), required bindings on `Coding` / `CodeableConcept` (needs system + code expansions), and value sets that can't be expanded offline (mimetypes, currencies). `unvalidatedBindings` in `@fhirforge/r4` lists the bindings.
- **Full examples type-check:** 32 of 5,309 official R4 examples fail `pnpm test:examples` type-checking, because the types are stricter than the base spec (reference targets, a primitive's value required next to its `_extension`). Decide whether to relax the types or keep a known-failures list like the runtime check.
- **More FHIR versions:** `@fhirforge/r5` from `hl7.fhir.r5.core`.
- **Search gaps:** composite parameters, `:text`, `:above` / `:below`, the `ap` prefix, `_total`, and the expressions listed in `unsupportedSearchParameters`.
- **Optional multi-tenancy** with Postgres row-level security.

## Release notes for maintainers

Learned from the 0.2.0 release (run 45072636883, four attempts):

- **Trusted publisher not configured → 404** on the first `npm publish` ("could not be found or you do not have permission"), even though the log says "using npm trusted publishing". Every package needs its own trusted publisher entry.
- **Trusted publisher that doesn't allow direct publish → 403** "OIDC permission denied for this action". `scripts/publish.mjs` runs a plain `npm publish`, so each entry must allow publishing, not only staged publishing. Configure all seven packages before re-running: the script stops at the first failure, which leaves a partly published version.
- **New versions take minutes to show up.** npm accepted a version (`+ @fhirforge/r4@0.2.0`) that the registry didn't serve for several minutes. The script's "already on npm" check uses `npm view`, which misses them, so a re-run inside that window publishes the same version again. `scripts/publish.mjs` now treats npm's duplicate-version refusal (`publish-errors.mjs`) as already published, so re-running the failed job (`gh run rerun <run-id> --failed`) right away is safe.
- Still unverified: `changesets/action@v1` in `release.yml` was not checked against the action's current major version.

## Open decisions

- **Policy errors:** an `authorize` function that throws is treated as a denial and isn't reported anywhere. Safe, but it hides policy bugs. Consider an `onPolicyError` hook or reporting it in the audit event (without the error message, which could contain PHI).
- **Validation strictness (decided 2026-11-22):** validation is always on, with no opt-out; an opt-out can be added later without a breaking change, removing one can't. Extensions are open: any `url` is accepted, but each must be a well-formed Extension. Stored data isn't re-validated on read. Revisit if apps need to import legacy data that doesn't conform (an `asSystem` import mode would be the place, audited).
- **Denied `create` / `search`** return 403 while denied reads return 404. Revisit if some apps need 404 everywhere.
- **Audit failures on writes:** if `onAudit` throws after a write committed, the caller gets an error for a write that happened. The built-in audit table (same transaction) would remove that gap.

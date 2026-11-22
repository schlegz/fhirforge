# Roadmap

What's built, what's next and in what order, and the decisions still open. Keep this current: when you finish an item, move it to **Done** and update README.md and CLAUDE.md in the same change (CLAUDE.md, "Keeping README.md in sync"). Claude: read CLAUDE.md first; its security rules apply to everything below.

_Last updated: 2026-11-22, after runtime validation._

## Done

- **0.1.0 published** to npm, all seven packages (`@fhirforge/definitions`, `codegen`, `core`, `r4`, `pg`, `pglite`, unscoped `fhirforge`). `fhirforge@1.0.0` (name placeholder) is deprecated and `latest` points to 0.1.0.
- **Types:** strict R4 types generated from `hl7.fhir.r4.core@4.0.1` (146 resources), with literal code bindings, exclusive choice types and generic `Reference<T>`.
- **Store:** create, read, vread, update (with `ifMatch`), delete and history on Postgres and PGlite; migrations under an advisory lock.
- **Search:** SearchParameters compiled at build time; string, token, date, reference, quantity, number and uri; prefixes, common modifiers, `_sort`, `_count`, `_offset`; per-parameter `plaintext` / `none` policy.
- **Security:** TLS enforcement for remote `pg` Pools; required `authorize` policy with `as(ctx)` / `asSystem(reason)`; `onAudit`; denied reads hidden as 404; writes pinned to the approved version; errors never echo values.
- **Runtime validation** (roadmap item 2): rules compiled from the StructureDefinitions into `@fhirforge/r4`'s `validation`, walked by `core/src/validation/`. Checks unknown elements, cardinality, types, choice elements, required `code` bindings, primitive formats and contained resources. `create` / `update` validate before the policy check; 400 with one path-only issue per problem. All 5,293 valid R4 spec examples pass; the 16 that break the base spec are rejected (`pnpm test:examples --no-types <examples package>`).
- **Release pipeline:** Changesets, `scripts/publish.mjs` with tarball checks, `release.yml` for trusted publishing.

## Next, in order

### 1. Finish the release pipeline (small, do first)

0.1.0 went out from a laptop (no provenance attestation), as planned for the first release. To move releases to CI:

- On npmjs.com, for each of the seven packages: **Settings → Trusted publishing → GitHub Actions**, repository `schlegz/fhirforge`, workflow `release.yml`. If the account uses staged publishing, allow staged publish there too.
- Ship a small patch (e.g. a docs fix) through the full flow: `pnpm changeset` → merge to `main` → merge the "Version packages" PR.
- Done when: the patch is on npm from GitHub Actions, and `npm view @fhirforge/core@<version> dist.attestations` shows a provenance attestation.
- Unverified: `changesets/action@v1` in `release.yml` was not checked against the action's current major version.

### 2. Bundle transactions and batches

- `transaction`: all entries in one database transaction, all-or-nothing; resolve `urn:uuid:` `fullUrl` references between entries (see `packages/r4/test/examples/bundle-transaction.json`); return a `transaction-response` Bundle.
- `batch`: entries independent, each with its own status.
- Every entry goes through validation (`createValidator`, before the policy), `authorize`, the version guard (`ifMatch` / `ifNoneExist`) and `onAudit`, exactly like single operations (CLAUDE.md §7).
- Needs storage support for running several writes in one transaction (extend the `FhirStorage` contract).
- Limits: maximum entries per Bundle.

### 3. HTTP adapter: `@fhirforge/next` (then `@fhirforge/express`)

- A Next.js route handler mapping FHIR REST (`GET/POST/PUT/DELETE /[type]/[id]`, `_history`, search, Bundles at the base URL) to `store.as(ctx)`.
- The app supplies `ctx` from its own auth; there is no default context.
- Responses: FHIR JSON, `ETag` / `Last-Modified`, `If-Match` → `ifMatch`, `Location` on create; errors as OperationOutcome without stack traces or driver messages.
- Search results as `searchset` Bundles with `self` / `next` links.
- `/metadata` CapabilityStatement generated from the configured resources and compiled search parameters.

### 4. Search: chaining and `_include` / `_revinclude`

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

## Open decisions

- **Policy errors:** an `authorize` function that throws is treated as a denial and isn't reported anywhere. Safe, but it hides policy bugs. Consider an `onPolicyError` hook or reporting it in the audit event (without the error message, which could contain PHI).
- **Validation strictness (decided 2026-11-22):** validation is always on, with no opt-out; an opt-out can be added later without a breaking change, removing one can't. Extensions are open: any `url` is accepted, but each must be a well-formed Extension. Stored data isn't re-validated on read. Revisit if apps need to import legacy data that doesn't conform (an `asSystem` import mode would be the place, audited).
- **Denied `create` / `search`** return 403 while denied reads return 404. Revisit if some apps need 404 everywhere.
- **Audit failures on writes:** if `onAudit` throws after a write committed, the caller gets an error for a write that happened. The built-in audit table (same transaction) would remove that gap.

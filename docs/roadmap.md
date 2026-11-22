# Roadmap

What's built, what's next and in what order, and the decisions still open. Keep this current: when you finish an item, move it to **Done** and update README.md and CLAUDE.md in the same change (CLAUDE.md, "Keeping README.md in sync"). Claude: read CLAUDE.md first; its security rules apply to everything below.

_Last updated: 2026-11-22, after the REST handler (`@fhirforge/http`)._

## Done

- **0.1.0 published** to npm, all seven packages (`@fhirforge/definitions`, `codegen`, `core`, `r4`, `pg`, `pglite`, unscoped `fhirforge`). `fhirforge@1.0.0` (name placeholder) is deprecated and `latest` points to 0.1.0.
- **Types:** strict R4 types generated from `hl7.fhir.r4.core@4.0.1` (146 resources), with literal code bindings, exclusive choice types and generic `Reference<T>`.
- **Store:** create, read, vread, update (with `ifMatch`), delete and history on Postgres and PGlite; migrations under an advisory lock.
- **Search:** SearchParameters compiled at build time; string, token, date, reference, quantity, number and uri; prefixes, common modifiers, `_sort`, `_count`, `_offset`; per-parameter `plaintext` / `none` policy.
- **Security:** TLS enforcement for remote `pg` Pools; required `authorize` policy with `as(ctx)` / `asSystem(reason)`; `onAudit`; denied reads hidden as 404; writes pinned to the approved version; errors never echo values.
- **Runtime validation** (roadmap item 2): rules compiled from the StructureDefinitions into `@fhirforge/r4`'s `validation`, walked by `core/src/validation/`. Checks unknown elements, cardinality, types, choice elements, required `code` bindings, primitive formats and contained resources. `create` / `update` validate before the policy check; 400 with one path-only issue per problem. All 5,293 valid R4 spec examples pass; the 16 that break the base spec are rejected (`pnpm test:examples --no-types <examples package>`).
- **Release pipeline:** Changesets, `scripts/publish.mjs` with tarball checks, `release.yml` for trusted publishing.
- **Expunge:** `expunge(type, id)` removes every version and index row in one transaction, pinned and policy-checked (action `expunge`), audited, audit rows kept. Not exposed over REST. The runtime role needs `DELETE` on resource and history tables only if the app uses it.
- **Chained search and `_include` / `_revinclude`** ([design/search-links.md](design/search-links.md)): one chain level, resolved as a policy-checked search on the target type; includes as policy-checked reads and searches; limits on chains, chain matches, include parameters and included resources. The REST handler returns includes as `include` entries and advertises `searchInclude` / `searchRevInclude`.
- **Built-in audit table:** `audit: { table: true, actor }` writes `fhir."_audit"` rows in the same database transaction as every write ([design/audit-table.md](design/audit-table.md), defaults accepted: opt-in, `actor` required, append-only triggers, no hash chain, expunge keeps audit rows, search result ids stored). INSERT-only runtime role, tested with a restricted role on Postgres. Closes the open decision "Audit failures on writes" for apps that turn it on.
- **REST API:** `@fhirforge/http` (renamed from the planned `@fhirforge/next`, since it isn't Next-specific): a fetch-style handler (`(Request) => Response`) for Next.js App Router, Hono, Bun and Deno, and `toNodeHandler` for Express and `node:http`, which replaces the planned `@fhirforge/express`. FHIR REST routes to `store.as(ctx)`, Bundles at the base URL, `searchset` / `history` Bundles, `ETag` / `Last-Modified` / `Location`, `If-Match`, a public `/metadata` CapabilityStatement, 401 without a context, `Cache-Control: no-store`, a body limit and generic 500s. Added `store.searchParameters(type)` for it.
- **Bundle transactions and batches:** `store.transaction(bundle)` / `store.batch(bundle)`, designed in [design/bundles.md](design/bundles.md) (option B: plan and authorize every entry outside the database transaction, then one `FhirStorage.writeAll`). `urn:uuid:` references resolved, rows locked in a fixed order, ≤ 100 entries and ≤ 10 searches, every entry validated, authorized, pinned and audited. `delete` gained `{ ifMatch }`.
- **Releases from CI** (roadmap item 1): 0.2.0 (runtime validation) went out from `release.yml` on 2026-11-22 via trusted publishing, with a provenance attestation on every package. It took four attempts of the release job; what went wrong is under **Release notes for maintainers** below.

## Next, in order

Nothing queued: pick the next item from **Later**.

## Later

- **Blind indexes:** the `blind` search policy (HMAC with an app-supplied key, exact match only).
- **Field-level encryption:** `encryptor` hook, envelope encryption, key ID per row (CLAUDE.md §5).
- **First publish of `@fhirforge/http`:** a new package's first version goes out by hand before trusted publishing can be configured (README > Releasing). Do it before merging the next "Version packages" PR.
- **REST follow-ups:** `PATCH`, conditional operations, `Prefer: return=minimal`, `HEAD`, type- and system-level history and search, `_summary` / `_elements`, XML. `PUT` re-creating a deleted resource returns 200 instead of 201 (the store's `update` doesn't report `created`).
- **Bundle follow-ups:** conditional operations (`ifNoneExist`, `PUT Type?…`; need a search in the plan step and a uniqueness guard at write time), `PATCH` entries, absolute request URLs, `prefer` return modes, and `next` links for search entries.
- **Audit table follow-ups:** tamper evidence (hash chain, or export to an external append-only store), a helper for monthly partitions, and a read API for auditors (a separate role, never the runtime store).
- **Profiles:** generated US Core types and profile validation.
- **Validation gaps:** invariants (FHIRPath constraints; would need a compiled subset like search, never a runtime evaluator), reference target types (the TS types already check them), required bindings on `Coding` / `CodeableConcept` (needs system + code expansions), and value sets that can't be expanded offline (mimetypes, currencies). `unvalidatedBindings` in `@fhirforge/r4` lists the bindings.
- **Full examples type-check:** 32 of 5,309 official R4 examples fail `pnpm test:examples` type-checking, because the types are stricter than the base spec (reference targets, a primitive's value required next to its `_extension`). Decide whether to relax the types or keep a known-failures list like the runtime check.
- **More FHIR versions:** `@fhirforge/r5` from `hl7.fhir.r5.core`.
- **Search gaps:** chains deeper than one level, `_include:iterate`, `_has`, batching include reads into one query, composite parameters, `:text`, `:above` / `:below`, the `ap` prefix, `_total`, and the expressions listed in `unsupportedSearchParameters`.
- **Optional multi-tenancy** with Postgres row-level security.

## Release notes for maintainers

Learned from the 0.2.0 release (run 45072636883, four attempts):

- **Trusted publisher not configured → 404** on the first `npm publish` ("could not be found or you do not have permission"), even though the log says "using npm trusted publishing". Every package needs its own trusted publisher entry.
- **Trusted publisher that doesn't allow direct publish → 403** "OIDC permission denied for this action". `scripts/publish.mjs` runs a plain `npm publish`, so each entry must allow publishing, not only staged publishing. Configure all seven packages before re-running: the script stops at the first failure, which leaves a partly published version.
- **New versions take minutes to show up.** npm accepted a version (`+ @fhirforge/r4@0.2.0`) that the registry didn't serve for several minutes. The script's "already on npm" check uses `npm view`, which misses them, so a re-run inside that window publishes the same version again. `scripts/publish.mjs` now treats npm's duplicate-version refusal (`publish-errors.mjs`) as already published, so re-running the failed job (`gh run rerun <run-id> --failed`) right away is safe.
- **`changesets/action` stays on `@v1` for now (checked 2026-11-22).** `@v1` resolves to v1.9.0, the maintained v1 line, and ran the 0.2.0 release end to end. The current major is v2 (v2.1.2). Moving to it means renaming inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`, a `github-token` input instead of the `GITHUB_TOKEN` env var). The real work: v2 no longer reads `New tag:` lines from the publish script's stdout. It detects published packages from the output file the Changesets CLI writes (`CHANGESETS_OUTPUT`), and our script publishes with `npm publish`. So `scripts/publish.mjs` would have to write that file (or the workflow would create tags and releases itself), or tags, GitHub releases and the `published` output stop working. Do it in its own change, and test it with a real release.

## Open decisions

- **Policy errors (decided 2026-11-22):** a throwing `authorize` still denies, and the error now goes to an optional `onPolicyError(error, request)` hook so policy bugs get noticed. Audit events aren't flagged: that would need per-operation state through every check, and the hook already reaches the app.
- **Validation strictness (decided 2026-11-22):** validation is always on, with no opt-out; an opt-out can be added later without a breaking change, removing one can't. Extensions are open: any `url` is accepted, but each must be a well-formed Extension. Stored data isn't re-validated on read. Revisit if apps need to import legacy data that doesn't conform (an `asSystem` import mode would be the place, audited).
- **Denied `create` / `search`** return 403 while denied reads return 404. Revisit if some apps need 404 everywhere.
- **Audit failures on writes (resolved 2026-11-22 for the audit table):** with `audit: { table: true }`, a write and its audit row commit together. Without it, `onAudit` still runs after the commit, as before. Revisit making the table required (like `authorize`) before 1.0.

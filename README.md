# fhirforge

Embeddable FHIR storage for Node and TypeScript. Add it to any app to store, search and manage FHIR resources in your own Postgres database. It's a library, not a server: your app keeps control of the connection, transactions, auth and HTTP.

> **Status:** early development. Typed create, read, update, delete, history and FHIR search work on Postgres and PGlite, with runtime validation, transaction and batch Bundles, access control, an append-only audit table, and a FHIR REST API for Next.js, Express and other frameworks (`@fhirforge/http`), including chained search and `_include` / `_revinclude`.

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
  authorize: 'allow-all', // required: a policy function, or 'allow-all' (see Access control)
});
await fhir.migrate(); // creates the "fhir" schema and tables; safe on every startup

const patient = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }] });
const same = await fhir.read('Patient', patient.id); // typed as R4 Patient
await fhir.update({ ...same, active: true }, { ifMatch: same.meta.versionId }); // 412 if someone else updated it
await fhir.delete('Patient', patient.id); // read now throws 410; history is kept
const versions = await fhir.history('Patient', patient.id); // newest first

const page = await fhir.search('Patient', { family: 'doe', birthdate: 'ge1970', _sort: '-birthdate', _count: 20 });
page.resources; // Stored<Patient>[]; page.total counts all matches; page.next has the next page's params
```

Errors are `FhirError`s with an HTTP `status` and a FHIR `outcome` (OperationOutcome): 400 invalid (including failed validation, with one issue per problem) or unsupported, 404 not found, 410 deleted, 412 version conflict.

Ids are server-assigned UUIDs. `update` also accepts a client-chosen id (update-as-create), but don't use real-world identifiers such as MRNs as ids: ids appear in references, URLs and error messages, so they shouldn't be PHI. Put identifiers in `identifier`.

### Validation

TypeScript types don't exist at runtime, so `create` and `update` validate every resource against the base FHIR spec before your access policy sees it. The rules are compiled from the StructureDefinitions at build time (`validation` in `@fhirforge/r4`); at runtime the store only walks that data.

- **Checked:** unknown elements; cardinality (required elements, arrays vs single values, no empty arrays or objects); element types; at most one variant per choice element (`deceased[x]`), and one when it's required; required bindings on `code` elements (`gender: 'M'` fails); primitive formats (dates with real calendar days, `dateTime` / `instant` with a time zone, `id`, `uri`, `code`, `oid`, `uuid`, `base64Binary`, integer ranges, strings up to 1 MB); primitive extensions (`_birthDate`); contained resources, by their own type.
- **Extensions are open:** any `url` is accepted, but each extension must be a well-formed Extension (a `url`, one `value[x]`).
- **Not checked yet:** invariants (FHIRPath constraints), profiles, reference target types, non-required bindings, and required bindings on `Coding` / `CodeableConcept` or on value sets that can't be expanded offline (`unvalidatedBindings` in `@fhirforge/r4` lists them).

Validation is always on; there is no opt-out. A rejected resource throws 400 with one OperationOutcome issue per problem (up to 100), each naming the element path, never the value:

```ts
await fhir.create(JSON.parse(body)); // e.g. { "resourceType": "Patient", "birthDate": "1974-02-30" }
// FhirError 400: outcome.issue = [{ severity: 'error', code: 'invalid',
//   diagnostics: 'Patient.birthDate is not a valid date (YYYY, YYYY-MM or YYYY-MM-DD)', expression: ['Patient.birthDate'] }]
```

Resources already in the database aren't re-validated on read.

### Access control and audit

`authorize` is required, so running without access control is always a visible choice. With a policy, every call goes through a scope:

```ts
const fhir = createFhirStore({
  storage,
  fhir: r4,
  resources: ['Patient', 'Observation'],
  authorize: ({ ctx, action, resourceType, resource }: AuthorizeRequest<Session>) => {
    if (ctx.role === 'clinician') return true;
    if (action === 'search') {
      // ANDed into the caller's query. (Patient has no `patient` parameter, so filter by _id.)
      return { filter: resourceType === 'Patient' ? { _id: ctx.patientId } : { patient: ctx.patientId } };
    }
    return resource?.resourceType === 'Patient'
      ? resource.id === ctx.patientId
      : (resource as Observation | undefined)?.subject?.reference === `Patient/${ctx.patientId}`;
  },
  onAudit: (event) => auditLog.write(event),
});

await fhir.as(session).read('Patient', id); // checked and audited with `session`
await fhir.asSystem('nightly export').search('Patient', {}); // bypasses the policy, audited with the reason
await fhir.read('Patient', id); // 403: no caller context
```

- Only `true` allows. `false`, `undefined`, any other value or a thrown error denies. Pass `onPolicyError: (error, request) => …` to find out when your policy throws (the request is still denied); the request can contain resource content, so treat it as PHI if you log it.
- The policy sees the content an action touches: the new resource for `create`, the stored one for `read`, `vread`, `history` and `delete`, and both the stored and the new version for `update`. The write then runs against exactly the version the policy approved, so a concurrent change fails with 412 instead of slipping through.
- A denied read, update or delete returns 404, the same as a missing resource, so callers can't probe for what exists. A denied `create` or `search` returns 403.
- For `search`, return `{ filter: { … } }` to restrict the query; totals and paging stay exact. Results are also checked one by one, and if any is removed the result's `total` is omitted.
- `onAudit` receives one event per operation, including denied and failed ones: who (`ctx`, or `system` with the reason), the action, resource type, id, version, outcome and status, and for searches the parameter names and returned ids. Events never include resource content or search values. If `onAudit` throws, the operation fails and the result is withheld (a write has already committed); pass `onAuditError` to handle audit failures yourself.

`migrate()` and `reindex()` are maintenance operations on the store itself and aren't audited.

#### Built-in audit table

`onAudit` runs after a write has committed, so if your audit sink fails, the change is already made. For a record that can't go missing, turn on the audit table:

```ts
const fhir = createFhirStore({
  storage, fhir: r4, resources: ['Patient', 'Observation'], authorize: policy,
  audit: { table: true, actor: (ctx: Session) => ctx.userId }, // a stable, non-secret id, never a token
  onAudit: (event) => siem.send(event), // optional, still called
});
```

- Every create, update, delete and transaction Bundle writes its audit rows **in the same database transaction** as the data: if the audit row can't be written, the change is rolled back. Reads, denials and failures are recorded with their own insert; if that fails, the operation fails (the error from the failed operation is kept in an `AggregateError`).
- A row has the same fields as an `onAudit` event: actor (from your `actor` function; the store never stores `ctx`), `system` and reason, action, resource type, id, version, outcome, status, search parameter names and returned ids, for Bundles the entry count, and for expunge its reason. A Bundle's entry rows and its own row share an `operation_id` (also `operationId` on `onAudit` events). Never resource content, search values or error messages.
- **Append-only:** triggers refuse `UPDATE`, `DELETE` and `TRUNCATE` on the table, even for its owner, and the runtime role only needs `INSERT` on it (see [Storage layout](#storage-layout)). fhirforge never deletes audit rows: retention is a job for a separate privileged role (or monthly partitions, below).
- The reason you pass to `asSystem(reason)` is stored as is: keep PHI out of it.

### Transactions and batches

```ts
const result = await fhir.as(session).transaction({
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    { fullUrl: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01',
      resource: { resourceType: 'Patient', name: [{ family: 'Doe' }] },
      request: { method: 'POST', url: 'Patient' } },
    { resource: { resourceType: 'Observation', status: 'final', code: { text: 'Heart rate' },
                  subject: { reference: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01' } }, // becomes Patient/<new id>
      request: { method: 'POST', url: 'Observation' } },
  ],
});
result.entry[0].response; // { status: '201 Created', location: 'Patient/…/_history/1', etag: 'W/"1"', lastModified: … }
```

- **`transaction`** commits every write or none. `urn:uuid:` references between entries are resolved to the new ids before the policy sees them, and are stored resolved. Entries run in FHIR's order (DELETE, POST, PUT, then GET), and the response lists them in request order. The first failure throws, with the entry index in the message (`entry[1]: Not allowed to create Observation`), and nothing is written.
- **`batch`** runs each entry as an independent single operation. A failing entry gets its status and OperationOutcome in its own `response`; the others still run. Batch entries can't reference each other (use a transaction).
- **Same checks as single operations:** every entry is validated, checked by `authorize` with the content it touches, pinned to the approved version, and audited as its own event, plus one `transaction` / `batch` event for the Bundle (with the entry count). If any resource changes between the policy check and the commit, the whole transaction fails with 412.
- **Supported entries:** `POST Type`, `PUT Type/id` (with `ifMatch`), `DELETE Type/id` (with `ifMatch`), `GET Type/id`, `GET Type/id/_history/v` and `GET Type?params`, with relative URLs. GET entries in a transaction run after the commit, see its writes, and report a failure in their own entry (it can't undo the commit). Conditional entries work too: `ifNoneExist` on POST, and `PUT Type?…` / `DELETE Type?…` (see [Conditional operations](#conditional-operations)); in a transaction, a conditional create that matches points its `fullUrl` at the existing resource. Not supported yet (400): `PATCH`, conditional reads (`ifNoneMatch`, `ifModifiedSince`), conditional references (`"reference": "Patient?…"`) and absolute URLs.
- **Limits:** at most 100 entries per Bundle (`MAX_BUNDLE_ENTRIES`) and 10 search entries (`MAX_BUNDLE_SEARCHES`); each search keeps the normal search limits.

`delete` also takes `{ ifMatch }`, like `update`.

### Conditional operations

For idempotent imports and retries: "create this Patient unless one with this identifier exists".

```ts
const mrn = { identifier: 'urn:oid:1.2.36.1.2001.1003.0|A100' }; // search parameters, or a query string
const { resource, created } = await fhir.as(session).conditionalCreate(patient, mrn); // created: false → the existing one
await fhir.as(session).conditionalUpdate('Patient', mrn, patient); // update the match, or create it
await fhir.as(session).conditionalDelete('Patient', mrn); // delete the match, if any
```

| | No match | One match | Several |
| --- | --- | --- | --- |
| `conditionalCreate` | creates (`created: true`) | returns it, writes nothing | 412 |
| `conditionalUpdate` | creates (with the body's `id`, or a new one) | updates it (the body's `id`, if any, must be the match's) | 412 |
| `conditionalDelete` | nothing to do (`deleted: false`) | deletes it | 412 |

- **Search parameters only:** the condition is plain search parameters (at most 10), searched as the caller: through your policy and audit, like any search. Resources the caller can't see don't count as matches, so a conditional create can add a resource next to one the caller can't see. Run imports that must see everything as `asSystem(reason)`.
- **No duplicates from concurrent retries:** writes with the same condition are serialized. In the write transaction, the store takes a lock on the condition and checks it again; if it no longer matches as it did (someone created a match meanwhile), the write fails with 412 and nothing is written. Retrying then returns the existing resource. This holds among conditional writes with the same condition. It doesn't cover an unconditional `create` that happens to match, or two different conditions that match the same resource: use one identifier per condition, and a unique constraint in your own schema if you need a hard guarantee across all writers.
- `conditionalUpdate` won't overwrite a resource that doesn't match: with no match and a body `id` that already exists, it's 412.

### Encryption at rest

Disk encryption protects a stolen disk. To protect against a leaked dump or backup, or an over-privileged read role, encrypt resource bodies with keys from your KMS:

```ts
const fhir = createFhirStore({
  storage, fhir: r4, resources: ['Patient', 'Observation'], authorize,
  encryption: { keys: kmsKeyProvider }, // { wrap(dataKey), unwrap(keyId, wrapped) } backed by AWS KMS, GCP KMS, Vault, ...
  search: { policy: { 'Patient.address': 'none' } }, // index rows aren't encrypted: see below
});
```

- **What's encrypted:** every resource body, current and history, with envelope encryption. fhirforge generates 256-bit data keys, your `KeyProvider` wraps them with a master key that never leaves the KMS, and bodies are encrypted with AES-256-GCM (Web Crypto, a random 96-bit nonce each time). Each row stores its data key's id; each data key stores the master key id.
- **Tamper-evident:** a ciphertext is bound to its row (`Type/id/_history/version`), so a body copied to another resource or version fails to decrypt (`could not decrypt Patient/123`, a 500-class error with no content).
- **KMS calls:** a data key is reused for at most 5 minutes or 100,000 encryptions (`dataKeyMaxAgeMs`, `dataKeyMaxUses`), and unwrapped keys are cached for reads (`dataKeyCacheSize`), so the KMS is called once per window, not per write, and never inside a database transaction. If the KMS fails, the operation fails; nothing is ever written in plaintext instead.
- **Not encrypted:** resource type, id, version, `lastUpdated`, and **search index rows of `plaintext` parameters**, which are readable copies of the values they index. Give sensitive parameters the `blind` policy (keyed hashes, exact match only; see [Search](#search)) or `none`:

  ```ts
  encryption: { keys: kmsKeyProvider, blindIndexKey: () => secrets.get('fhir-blind-index') }, // { id, key: 32+ bytes }
  search: { policy: { 'Patient.family': 'blind', 'Patient.identifier': 'blind', 'Patient.birthdate': 'blind', 'Patient.address': 'none' } },
  ```
- **Turning it on for existing data:** existing plaintext rows stay readable, so you can enable encryption without downtime. Then run `await fhir.reencrypt()` once to encrypt them. After the master key rotates in the KMS, `await fhir.reencrypt({ olderThan: rotationDate })` moves every version to a new data key. It works one resource per transaction, with the row locked.
- **Mixed mode is a trade-off:** while plaintext rows are readable, someone with *write* access to the database could put plaintext in place of a ciphertext and it would be served. Run `reencrypt()` after enabling encryption. A strict mode that refuses plaintext rows is planned.

### Expunge

`delete` keeps every version (FHIR history). To remove a resource for good, for example for a data-deletion request, enable expunge when you create the store and call it with a reason:

```ts
const fhir = createFhirStore({
  storage: postgresStorage(appPool),           // runtime role: no DELETE on resource data
  expunge: { storage: postgresStorage(adminPool) }, // optional: a role with DELETE, used only for expunge
  // …
});

await fhir.as(session).expunge('Patient', id, { reason: 'erasure request #1234' });
```

- **Off by default.** Without the `expunge` option, `expunge` fails with 400. `expunge: {}` runs it on the main storage, whose role then needs `DELETE` on the resource and history tables. `expunge: { storage }` runs it on a second storage for the same schema, typically a separate pool whose role has that `DELETE`, so the everyday runtime role never can delete resource data.
- **A reason is required** (1–1000 characters) and recorded in the audit event (`expungeReason`) and the audit table. Keep PHI out of it: use a ticket or request number.

- It removes the current version, every history version and every search index row in one transaction. Afterwards, `read`, `vread` and `history` return 404 and the id can be reused. It works on deleted resources too.
- It's its own operation: `delete` never expunges. Your policy decides on it (action `expunge`, with the latest content); denied looks like missing (404). It's pinned like other writes: if the resource changes after the policy check, or `ifMatch` doesn't match, it fails with 412 and removes nothing.
- It's audited (action `expunge`). Audit events and audit-table rows about the resource are **kept**: they hold ids, not content, and audit retention usually outlives the data.
- It isn't exposed by the REST handler: call it from trusted server code.
- Grants: see [Storage layout](#storage-layout). Without them, expunge fails with a permission error and nothing is removed.

### REST API

`@fhirforge/http` serves the store over FHIR REST. `createFhirHandler` returns a fetch-style handler for frameworks built on web-standard Request/Response; `toNodeHandler` adapts it for Express and `node:http`. In a Next.js App Router app, in `app/fhir/[[...path]]/route.ts`:

```ts
import { createFhirHandler } from '@fhirforge/http';

const handler = createFhirHandler({
  store, // from createFhirStore
  basePath: '/fhir',
  context: async (request) => sessionFrom(request), // your auth; return undefined → 401
});

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
```

In Express: `app.use('/fhir', toNodeHandler(createFhirHandler({ store, basePath: '/fhir', baseUrl, context })))`. Mount it before body parsers so it reads the body with its own size limit (if a parser already ran, the parsed `req.body` is used). Set `baseUrl`: without it, links are built from the client-supplied `Host` header.

- Every request runs as `store.as(ctx)`: the same validation, `authorize` policy and `onAudit` as calls in code. Without a context it gets 401 and never reaches the store. `GET /metadata` (a CapabilityStatement built from the configured types and searchable parameters) is public.
- Routes: `POST /` for transaction and batch Bundles; `GET /Type?…` and `POST /Type/_search` for search (`searchset` Bundles with absolute `fullUrl`s, `self` / `next` links, and `_include`d resources as `search.mode: 'include'` entries); `POST /Type`; `GET`, `PUT` and `DELETE /Type/id`; `GET /Type/id/_history` and `/_history/v`. `If-Match` maps to `ifMatch`; responses carry `ETag`, `Last-Modified` and, on create, `Location`.
- Responses are `application/fhir+json` with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Errors are OperationOutcomes; unexpected errors become a generic 500 (pass `onError` to see them). Bodies over `maxBodyBytes` (default 10 MB) get 413.
- Conditional operations: `POST /Type` with `If-None-Exist` (201 when created, 200 with the existing resource when one matches), `PUT /Type?…` and `DELETE /Type?…`.
- Not handled: XML (`_format=xml` gets 406), `PATCH`, conditional reads (`If-None-Match`, `If-Modified-Since`), system- and type-level history, CORS and rate limiting (your app's job). Re-creating a deleted resource with `PUT` returns 200, not 201.

### Search

`search(resourceType, params)` takes FHIR search parameters as an object. Arrays are ANDed (`birthdate: ['ge1970', 'lt1980']`) and comma-separated values are ORed (`gender: 'male,female'`). Parameters come from the official SearchParameter definitions, compiled at build time.

| Type | Examples | Supported |
| --- | --- | --- |
| string | `family=doe`, `name:exact=Doe`, `address-city:contains=creek` | Prefix match (default), ignoring case and accents; `:exact`, `:contains` |
| token | `gender=female`, `identifier=urn:mrn\|A100`, `identifier=\|A100`, `code=http://loinc.org\|` | `code`, `system\|code`, `\|code`, `system\|`; `:not` |
| date | `birthdate=1974`, `date=ge2026-11-01`, `_lastUpdated=gt2026-11-20T10:00:00Z` | Precision ranges; `eq ne gt lt ge le sa eb`; periods, open-ended periods, choice types |
| reference | `subject=Patient/123`, `patient=123`, `subject:Group=7` | `Type/id`, bare id, absolute URL, `urn:uuid:`, `:Type` |
| quantity | `value-quantity=gt80\|http://unitsofmeasure.org\|kg` | Prefixes, precision ranges, system and code |
| number, uri | `_profile=http://…` | Prefixes for number; exact match for uri |
| any | `birthdate:missing=true`, `_id=a,b` | `:missing`, `_id`, `_lastUpdated` |

Results: `_count` (default 20, max 1000), `_offset`, `_sort` (`_sort=-birthdate,family`; date, string, token, number, quantity, uri, `_id`, `_lastUpdated`). Handling is strict: an unknown parameter, unsupported modifier or malformed value is a 400 error rather than being ignored, so a typo never widens a search.

**Chaining and includes.**

```ts
await fhir.as(session).search('Observation', { 'subject.name': 'doe', code: '8867-4' }); // Observations of patients named Doe
await fhir.as(session).search('Observation', { 'performer:Practitioner.name': 'xavier' }); // the type is needed when there are several
const page = await fhir.as(session).search('Observation', { code: '8867-4', _include: 'Observation:subject' });
page.included; // the referenced Patients the caller may read
await fhir.as(session).search('Patient', { family: 'doe', _revinclude: 'Observation:subject' }); // plus their Observations
```

- A chain runs as its own search on the target type, through `authorize` and `onAudit` like any search, and its matches become a reference filter. It only matches resources the caller may see. One level, at most 3 chained values per search, and a chain may match at most 100 targets (more is a 400: narrow it).
- Each `_include`d resource is a `read` and each `_revinclude` a `search`, each checked by the policy and audited on its own. Resources the caller may not read are left out silently. At most 5 `_include` / `_revinclude` values and 100 included resources per page; `includeLimitReached` says when some were left out. Not supported: `:iterate` and `*`.
- A policy's search `filter` can't contain chains or includes.

Not supported yet: composite and special parameters, chains deeper than one level, `_include:iterate`, `_has`, the `ap` prefix, `:text`, `:above` / `:below`, `_total` options, and a few expressions outside the compiled FHIRPath subset. `unsupportedSearchParameters` from `@fhirforge/r4` lists each with the reason.

**Search policy.** Index rows are readable copies of resource data, so each parameter can be configured:

```ts
createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize, search: { policy: { 'Patient.birthdate': 'none' } } });
```

`plaintext` (default) indexes the value for full search. `none` doesn't index it and makes it unsearchable. `blind` stores a keyed hash (HMAC-SHA-256) of the normalized value instead of the value, so the parameter stays searchable by exact match while the database holds no readable copy. It needs `encryption.blindIndexKey` and works for string, token and date parameters. After changing the policy, run `await fhir.reindex()`.

| Blind parameter type | Still works | Stops working (400) |
| --- | --- | --- |
| string | the whole value, ignoring case and accents: `family=doe` finds `Doé` | prefix match (the default: `family=do` finds nothing), `:contains`, `:exact`, `_sort` |
| token | `code`, `system\|code`, `\|code` | `system\|` (any code), `:not`, `_sort` |
| date | the value at its stored precision: `birthdate=1974-12-25` | `ge` / `lt` / other prefixes, ranges, `_sort` |

`:missing` isn't supported on blind parameters. Searches stop matching after the blind index key changes, until `reindex()` rewrites the hashes with the new key.

### Storage layout

Everything lives in its own schema (`fhir` by default, configurable), never mixed with your app's tables:

- `fhir."Patient"`: the current version of each resource as JSONB
- `fhir."Patient_history"`: every version, including delete markers
- `fhir."Patient_string"`, `_token`, `_date`, `_reference`, `_number`, `_quantity`, `_uri`, `_blind` (keyed hashes of `blind` parameters): search index rows, replaced in the same transaction as each write, removed with the resource
- `fhir."_migrations"`: applied migration ids
- `fhir."_data_keys"` (with `encryption`): wrapped data keys (never plaintext keys); rows' `enc` and `dek_id` columns hold encrypted bodies, with `content` NULL
- `fhir."_audit"` (with `audit: { table: true }`): the append-only audit log, one row per operation (no resource content)

The runtime database role needs `SELECT`, `INSERT` and `UPDATE` on the resource, history and index tables, plus `DELETE` on the index tables (index rows are replaced on every write), and only `INSERT` on `_audit`: no `SELECT`, `UPDATE` or `DELETE`, so the application can't read or change the audit log. Read it with a separate auditor role. Only `migrate()` needs DDL rights.

```sql
GRANT USAGE ON SCHEMA fhir TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON fhir."Patient", fhir."Patient_history" TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON fhir."Patient_string", fhir."Patient_token", fhir."Patient_date",
  fhir."Patient_reference", fhir."Patient_number", fhir."Patient_quantity", fhir."Patient_uri", fhir."Patient_blind" TO app_runtime;
GRANT INSERT ON fhir."_audit" TO app_runtime;
-- With encryption on:
GRANT SELECT, INSERT ON fhir."_data_keys" TO app_runtime;
-- Only for expunge, on the role of the expunge storage (a separate role if you pass `expunge: { storage }`):
GRANT DELETE ON fhir."Patient", fhir."Patient_history" TO app_expunge;
```

The audit table grows without bound. To manage retention by dropping old partitions instead of deleting rows, create `fhir."_audit"` yourself as a table partitioned by `recorded` (same columns) before the first `migrate()`: the migration only creates it if it doesn't exist. When a migration adds index tables, `migrate()` indexes existing resources automatically.

`migrate()` takes a Postgres advisory lock, so several instances starting at once are safe. To run migrations with your own tool instead, `migrationSql(['Patient', 'Observation'], { audit: true })` from `@fhirforge/pg` returns the same schema as plain, idempotent SQL.

## Packages

| Package | What it is |
| --- | --- |
| `@fhirforge/definitions` | Build-time. Loads official FHIR packages (e.g. `hl7.fhir.r4.core@4.0.1`) from packages.fhir.org into the standard `~/.fhir/packages` cache, indexes StructureDefinitions, ValueSets, CodeSystems and SearchParameters, and builds element trees. |
| `@fhirforge/codegen` | Build-time. Generates strict TypeScript types for a FHIR version, compiles its search parameters' FHIRPath expressions into plain path data, and compiles its StructureDefinitions into validation rules (`fhirforge-codegen` CLI). |
| `@fhirforge/r4` | Generated FHIR R4 types (146 resources, 41 datatypes, 20 primitives, `ResourceTypeMap`), compiled search parameters and validation rules. Use `import type` in frontend code so the search and validation data isn't bundled. |
| `@fhirforge/core` | `createFhirStore`: version-neutral, typed from the version package you pass in, with `authorize` / `onAudit` hooks. No I/O of its own. |
| `@fhirforge/pg` | Postgres storage: takes a `pg` Pool (or any `Database`), with migrations, optimistic locking, search indexes and TLS enforcement. |
| `@fhirforge/pglite` | In-process [PGlite](https://pglite.dev) storage: real Postgres with no server, for tests and local development. |
| `@fhirforge/http` | The FHIR REST API: a fetch-style handler (`(Request) => Response`) for Next.js App Router, Hono, Bun and Deno, plus `toNodeHandler` for Express and `node:http`. Depends only on `core`. |
| `fhirforge` | One install for the common setup: re-exports `core`, `pg` and `r4`. |

Planned: chained search and `_include`.

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

The store checks the same bindings, choice rules and cardinality at runtime (see [Validation](#validation)), so untyped JSON gets the same guarantees. Reference targets are checked only by the types for now.

## Security

fhirforge is built for apps that store PHI, but it can't make an app HIPAA or SOC 2 compliant on its own. What it does today:

- All SQL uses bind parameters, including every search value; table and schema names are allow-listed, and LIKE wildcards in search values are escaped.
- Tables live in their own schema, and the runtime store never changes the schema (only `migrate()` does), so it can run under a role with data-only privileges.
- Writes are atomic and race-free: each update or delete locks the row and writes the current version, its history and its search index rows in one transaction. A Bundle transaction writes all its entries in one database transaction, locking rows in a fixed order so concurrent transactions can't deadlock.
- `postgresStorage(pool)` refuses a non-TLS connection to a non-local host (`ssl`, or `sslmode=require` / `verify-ca` / `verify-full`). `{ allowInsecure: true }` overrides it for development only. A custom `Database` is your responsibility.
- Errors (`FhirError`) name the resource type, id, version or search parameter, never field or search values. The library doesn't log resource content.
- Every resource is validated against the base spec before it reaches the access policy or the database. Validation issues carry element paths only, element names from the input appear only if they look like FHIR names, and nesting depth and issue count are bounded so hostile JSON can't make it do unbounded work. Primitive formats use fixed, linear-time patterns, not regexes from the definitions.
- Search index rows are copies of PHI. Per-parameter search policies let you leave sensitive fields unindexed (`none`), and index rows are deleted with their resource.
- The REST handler (`@fhirforge/http`, both the fetch-style and the Node adapter) requires a caller context for every data request (401 otherwise), never returns stack traces, SQL or driver messages, sends `Cache-Control: no-store` so responses with PHI aren't cached, and caps request bodies (413).
- Access control is explicit: every operation goes through your `authorize` policy (default-deny) or a named `asSystem(reason)` bypass, and every operation can be audited through `onAudit`, without PHI in the events.
- With `encryption`, resource bodies (current and history) are encrypted at rest with your KMS's keys (envelope encryption, AES-256-GCM, ciphertexts bound to their row); search index rows are protected per parameter: `blind` (keyed hashes, exact match only) or `none`.
- `expunge` (off unless enabled) removes a resource's every version and index row in one transaction (history and index rows are copies of PHI), as its own policy-checked operation with a required reason, audited; audit rows are kept. It can run on its own connection, so the everyday runtime role never needs `DELETE` on resource data.
- The optional audit table records every operation append-only, and writes a change and its audit row in one database transaction, so a committed change always has its record.

What your app needs to provide: database encryption at rest (e.g. KMS-backed disks), the access policy itself, and either the audit table or another durable destination for audit events (plus long-term retention and review of them). Planned in fhirforge: a strict mode that refuses plaintext rows once everything is encrypted. [CLAUDE.md](CLAUDE.md) has the full requirements contributors follow.

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm test          # build, unit + store tests (PGlite), type tests, example type-check and validation
pnpm gen:r4        # regenerate packages/r4/src/generated from hl7.fhir.r4.core@4.0.1
```

To create a local development database with every R4 resource type migrated (plus the audit and encryption tables):

```bash
pnpm dev:db                    # asks for the database name
pnpm dev:db fhir_dev           # creates fhir_dev on the local Postgres (if missing) and migrates it
pnpm dev:db fhir_dev --pglite  # no server: a PGlite database in .fhir-dev/fhir_dev
```

It connects to `FHIRFORGE_DEV_DATABASE_URL` (default `postgres://postgres@localhost:5432/postgres`; put the password there or in `PGPASSWORD`), refuses non-local servers, and is safe to re-run.

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

To check the full set of official examples, extract `hl7.fhir.r4.examples` and run:

```bash
pnpm test:examples ~/.fhir/packages/hl7.fhir.r4.examples#4.0.1/package            # type-check and runtime validation
pnpm test:examples --no-types ~/.fhir/packages/hl7.fhir.r4.examples#4.0.1/package # runtime validation only (seconds)
```

All 5,293 valid examples pass runtime validation; 16 examples that break the base spec (missing required elements, malformed codes or ids) are listed in `check-examples.ts` and must be rejected. The type-check is stricter than the base spec (reference targets, a primitive's value required next to its `_extension`), and 32 official examples fail it.

Releases use [Changesets](https://github.com/changesets/changesets); all `@fhirforge/*` packages are versioned together.

## Roadmap

[docs/roadmap.md](docs/roadmap.md) lists what's done, what's next and the open design decisions.

## Releasing

All published packages (`@fhirforge/*` and `fhirforge`) share one version and are released together with [Changesets](https://github.com/changesets/changesets). Releases are 0.x while the API settles.

Day to day:

1. With each user-facing change, run `pnpm changeset` and commit the generated file.
2. When it reaches `main`, the **Release** workflow opens (or updates) a "Version packages" pull request with the version bumps and changelogs.
3. Merging that pull request publishes the new versions to npm from GitHub Actions and pushes `name@version` tags.

Publishing uses npm trusted publishing: no npm token is stored anywhere, and each package gets a provenance attestation linking it to the commit that built it. `scripts/publish.mjs` publishes only versions not yet on npm, in dependency order, and refuses a dirty working tree, files outside `dist/`, README and LICENSE, or an unresolved `workspace:` version. `pnpm release:check` runs all of that without publishing.

First release (once, and again for each new package): trusted publishing can only be configured for packages that already exist on npm, so a package's first version goes out from your machine. For a new package, publish it by hand (`npm login`, then `pnpm build && cd packages/<name> && pnpm publish --access public`), configure its trusted publisher, and only then merge the "Version packages" pull request. `scripts/publish.mjs` publishes the newest package last, so if that step was missed, the others still go out.

```bash
npm login                      # an account in the @fhirforge org, with 2FA
pnpm version-packages          # applies .changeset/initial-release.md → 0.1.0
git commit -am "Version packages" && git push
pnpm release                   # build, check and publish all seven packages
git push origin --tags
npm deprecate fhirforge@1.0.0 "Name placeholder. Use the latest 0.x release."
```

`fhirforge@1.0.0` is an empty name placeholder, so it's higher than the 0.x releases. `scripts/publish.mjs` always passes the dist-tag explicitly (`latest` unless `--tag` is given), because npm otherwise refuses to tag a lower version `latest`.

Then, for each of the seven packages on npmjs.com: Settings → Trusted publishing → GitHub Actions, repository `schlegz/fhirforge`, workflow `release.yml`, with publishing allowed (not only staged publishing: the release runs a plain `npm publish`). From then on, releases go through the pull request.

If a release fails partway (e.g. one package's trusted publisher is missing), fix the npm settings for every package, then re-run the failed job with `gh run rerun <run-id> --failed`. Already-published versions are skipped, including ones npm accepted but doesn't serve yet (that can take a few minutes): `scripts/publish.mjs` treats npm's "cannot publish over the previously published version" refusal as already published. [docs/roadmap.md](docs/roadmap.md) has the details from the 0.2.0 release.

## License

Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7. The FHIR specification content these types are generated from is published under CC0.

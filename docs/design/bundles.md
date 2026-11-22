# Design: Bundle transactions and batches

Status: **draft for review** (2026-11-22). Roadmap: Next, item 1. Nothing here is implemented.

## Goal

`store.as(ctx).transaction(bundle)` and `store.as(ctx).batch(bundle)` take a FHIR `Bundle` of type `transaction` / `batch` and return a `transaction-response` / `batch-response` Bundle. Entries go through exactly the same steps as single operations: validation, `authorize`, the version guard and `onAudit` (CLAUDE.md §7). The HTTP adapter (roadmap item 2) will map `POST [base]` with a Bundle to these.

First version supports `POST` (create), `PUT` (update, update-as-create), `DELETE` and `GET` (read, vread, search) entries. Not in the first version: `PATCH`, conditional create/update/delete (`ifNoneExist`, `PUT Patient?identifier=…`), `_history` at the base, and `prefer` return modes. Those are rejected with 400 `not-supported`, never approximated.

## The key decision: where the policy runs relative to the database transaction

**Option A: a transactional storage view.** `FhirStorage.transaction(fn)` hands core a storage object bound to one connection; core runs its existing per-entry logic inside it. Reads lock rows (`FOR UPDATE`), so the version guard is trivially race-free.
*Against:* the app's `authorize` (arbitrary async code, maybe network calls) and `onAudit` run while a database transaction holds row locks and a pool connection. A slow policy stalls other writers; a policy that itself uses the same pool can deadlock it. The adapter contract doubles in size.

**Option B (recommended): plan first, then one atomic write.** Core does all reads and policy checks outside any database transaction, exactly as single operations do today, and collects the approved writes, each pinned to the version the policy saw. It then hands the whole list to one new storage method that applies it in one transaction. If any row changed in between, its guard fails and the whole transaction rolls back with 412.
*For:* no app code inside database transactions; the contract grows by one method; it reuses the "pin writes to the approved version" rule that already makes single writes race-free (CLAUDE.md §7). *Against:* a concurrent writer causes a 412 for the whole Bundle instead of waiting on a lock. That's the same behavior single updates have today, and clients already handle 412 by re-reading.

## Storage contract (option B)

```ts
interface FhirStorage {
  // ...existing methods...

  /**
   * Applies every write in one database transaction, all or nothing.
   * Locks all affected rows first, in a fixed order (resource type, then id),
   * so two concurrent Bundles can't deadlock. Every guard is checked under
   * the lock; any failure rolls back everything and rethrows that entry's error.
   * Returns one result per write, in input order.
   */
  writeAll(writes: readonly PlannedWrite[], options?: WriteOptions): Promise<WriteResult[]>;
}

type PlannedWrite =
  | { kind: 'create'; resource: AnyResource & { id: string } }
  | { kind: 'update'; resource: AnyResource & { id: string }; ifMatch?: string; ifNoneExist?: boolean }
  | { kind: 'delete'; resourceType: string; id: string; ifMatch: string };

// Per kind, like the single methods: create → StoredVersion, update → UpdateResult,
// delete → StoredVersion (undefined when there was nothing to delete).
type WriteResult =
  | { kind: 'create'; version: StoredVersion }
  | { kind: 'update'; result: UpdateResult }
  | { kind: 'delete'; version?: StoredVersion };
```

The single `create` / `update` / `delete` methods stay. In `@fhirforge/pg` they become `writeAll` with one entry, so there's one write path to keep race-free.

## Processing a transaction (core)

1. **Shape and limits.** `resourceType: 'Bundle'`, `type: 'transaction'`; at most `MAX_BUNDLE_ENTRIES` entries (proposed 100); each entry has `request.method` and `request.url`, and a `resource` for POST/PUT. Validate the Bundle with the runtime validator first.
2. **Parse each `request.url`** into (type, id, version, search params) against the configured resource types only, using the same id and type checks as single operations. Unknown types, malformed ids or unsupported forms → 400 naming the entry index, never the URL text.
3. **No duplicates.** Two entries for the same resource → 400 (the spec forbids it). This also guarantees one lock per row in `writeAll`.
4. **Assign ids and resolve references.** Each POST entry gets a server UUID. Every `fullUrl` of the form `urn:uuid:…` maps to its new `Type/id`. Rewrite matching `Reference.reference` values (and `#` fragments stay untouched) everywhere in the Bundle's resources. A `urn:uuid:` reference with no matching entry → 400.
5. **Validate** every entry's resource after rewriting (references now point at real ids).
6. **Read and authorize**, entry by entry, in the order FHIR prescribes (DELETE, POST, PUT, GET). This is the same logic as single operations: stored version for update and delete, new content for create and update; denied reads of existing resources are hidden as 404, denied creates 403. Any failure stops here: nothing has been written.
7. **Write.** One `storage.writeAll(...)` with every approved write, each pinned (`ifMatch` = the version the policy saw, `ifNoneExist` for update-as-create). A 412 from any guard fails the whole Bundle.
8. **GET entries** run after the commit, as normal reads/searches through the policy. They see the committed writes; they are not part of the atomic unit (they can't be: reads don't change anything).
9. **Response:** a `transaction-response` Bundle with one entry per request entry, in request order: `response.status` (`201 Created`, `200 OK`, `204 No Content`), `location` (`Type/id/_history/v`), `etag` (`W/"v"`), `lastModified`, and the stored resource for writes.

On failure the whole call throws the failing entry's `FhirError` with the entry index added to the message (`entry[3]: Patient/123 not found`), never resource content.

## Batch

No storage change: each entry runs as its own single operation (same scope), independently, in request order. Each result or error becomes that entry's `response` (errors as an `OperationOutcome` in `response.outcome`). One failing entry doesn't affect the others. `urn:uuid:` references between batch entries aren't resolved (the spec doesn't allow interdependent batch entries) and are rejected with 400.

## Audit

- One `StoreAuditEvent` per entry, with its action, type, id, version and outcome, exactly as if it were a single operation.
- Plus one event for the Bundle itself: action `transaction` or `batch` (two new `StoreAction` values), outcome, status and the entry count. Never entry content or URLs.
- Transaction: on success, entry events report success. On failure, every entry is audited with the Bundle's failure status (nothing was written), and the failing entry with its own.
- Same rule as today: if `onAudit` throws, the result is withheld (writes have committed). The open decision about audit failures after commit gets more pressing here; see below.

## Limits

- `MAX_BUNDLE_ENTRIES` (proposed 100, configurable down, not up).
- Each GET-search entry keeps the normal search limits; a Bundle may contain at most `MAX_BUNDLE_SEARCHES` searches (proposed 10), so one request can't run 100 searches.
- The Bundle's own validation is bounded by the validator's depth and issue limits.

## Security checklist notes

- **SQL:** `writeAll` uses the existing bind-parameter helpers; lock ordering uses the allow-listed resource types.
- **Errors:** entry index plus type/id/version only. `request.url` and `fullUrl` values are never echoed (they can contain identifiers).
- **Authorization:** every entry checked with the content it touches; GETs are reads; no bypass. `asSystem(reason)` works for Bundles like for single operations.
- **Integrity:** all writes of a transaction, their history rows and index rows in one database transaction (CLAUDE.md §6).

## Open questions for review

1. **Option A or B?** Recommended: B.
2. **Entry limit:** 100 by default? Large imports would use `asSystem` with several Bundles, or a future bulk import.
3. **Conditional operations** (`ifNoneExist`, conditional update): leave for a follow-up? They need a search inside the plan step, and to be race-free, a uniqueness guard at write time.
4. **Audit after commit:** should we do the built-in audit table (same database transaction as the writes) before or together with Bundles, so a transaction and its audit events commit together?
5. **Return shape:** return the response Bundle (FHIR-native, what HTTP adapters need), or a typed result plus a helper that builds the Bundle? Proposed: the Bundle, typed as R4 `Bundle`.

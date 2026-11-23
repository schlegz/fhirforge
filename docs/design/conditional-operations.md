# Design: conditional create, update and delete

Status: **implemented** (2026-11-23) with the proposed answers: the condition is searched as the caller, advisory lock plus re-check, 412 on several matches for delete, new `conditional*` methods, and conditional references left for a follow-up.

## Why

FHIR clients use conditional operations to make writes idempotent: "create this Patient unless one with identifier `urn:mrn|A100` exists" (`If-None-Exist`), "update the Patient with this identifier, or create it" (`PUT Patient?identifier=…`), "delete whatever matches". Imports and retries depend on them. Today the store has no API for them, and Bundles and the REST handler reject them with 400.

## FHIR semantics (R4)

| Operation | 0 matches | 1 match | 2+ matches |
| --- | --- | --- | --- |
| Conditional create (`POST` + `If-None-Exist`) | create, 201 | return the existing resource, 200, nothing written | 412 |
| Conditional update (`PUT Type?query`) | create (server id, or the body's id), 201 | update that resource, 200 (body `id`, if any, must match) | 412 |
| Conditional delete (`DELETE Type?query`) | 204, nothing deleted | delete it, 204 | 412 (we don't delete multiple) |

## API

New methods, so existing ones keep their types:

```ts
const { resource, created } = await fhir.as(ctx).conditionalCreate(patient, { identifier: 'urn:mrn|A100' });
const { resource, created } = await fhir.as(ctx).conditionalUpdate('Patient', { identifier: 'urn:mrn|A100' }, patient, { ifMatch });
await fhir.as(ctx).conditionalDelete('Patient', { identifier: 'urn:mrn|A100' });
```

The condition is ordinary search parameters, validated like a search. Not allowed in a condition (400): `_count`, `_offset`, `_sort`, chains, `_include` / `_revinclude`. At most 10 parameters.

- **REST:** `POST /Type` with `If-None-Exist: identifier=urn:mrn|A100`, and `PUT /Type?…` / `DELETE /Type?…`.
- **Bundles:** `request.ifNoneExist` on POST entries; `PUT Type?…` / `DELETE Type?…` URLs. In a transaction, a conditional create that matches an existing resource maps its `urn:uuid:` `fullUrl` to the existing id, so other entries reference it.

## The two hard problems

### 1. Races

Two clients run "create unless identifier=A100 exists" at the same time. Both search, both see nothing, both create: a duplicate. That's exactly what the client wanted to avoid.

**Proposed: lock on the condition, then re-check inside the write transaction.**

1. **Plan** (outside any database transaction, like everything else): run the condition as a search through the policy, decide 0 / 1 / 2+, and check the write with the policy, as single operations do today.
2. **Write:** in the write transaction, take `pg_advisory_xact_lock(hash(resource type + canonical condition))`, then re-run the condition **as SQL** (with the policy's search filter, if any) and check it still gives the planned answer: no match for a create, exactly the planned resource for an update or delete. If it doesn't, 412 and nothing written. Then write.

The canonical condition is the parsed query (clauses sorted, values normalized), so `identifier=urn:mrn|A100` and `identifier=urn:mrn%7CA100` share a lock. Two concurrent conditional creates with the same condition are serialized: the second waits, re-checks, sees the first's resource and fails with 412. A retry then gets the existing resource back, which is the idempotent outcome.

**Not covered** (documented):
- An unconditional write that happens to create a matching resource doesn't take the lock.
- Two *different* conditions that match the same resource (`identifier=A100` vs `identifier=A100&active=true`) don't share a lock.

For a hard guarantee across all writers, an app would need a unique constraint on the identifier. That's an app-specific schema choice and out of scope. The docs will recommend conditions on a single identifier.

The storage contract gets a guard on writes: `PlannedWrite` gains an optional `condition: { query: SearchQuery; expect: 'none' | { id: string } }`, checked under the lock in `writeAll` / single writes.

### 2. Visibility

The condition search runs **as the caller**, through `authorize` (filter, per-result read check) and audit, like any search. So a matching resource the caller isn't allowed to see doesn't count as a match:

- **Conditional create** would then create a second, visible resource. That's the correct answer from the caller's point of view, and the alternative leaks that a hidden resource exists.
- **The re-check under the lock** can only apply the policy's search *filter* (SQL), not the per-result read check, which is app code and stays out of transactions. A resource that passes the filter but fails the read check therefore makes the re-check disagree, and the write fails with 412 instead of creating a duplicate. That's a small, deliberate leak ("something conflicts") in an edge case. Policies that express visibility as a search filter (recommended already, for exact totals) never hit it.
- Imports that need to see everything should run as `asSystem(reason)`.

## Access control and audit

- **Condition:** the condition search is a `search` event (parameter names only).
- **Write:** the write is checked and audited as the usual `create` / `update` / `delete`, pinned to the version the policy saw.
- **Conditional create with one match:** returns the existing resource, which is a `read`. It needs read permission and is audited as a read. If the read is denied (possible only through the read-check edge case above), the answer is 412.
- **Audit table:** the write's audit row is in the write transaction as usual.

## Limits

- 10 parameters per condition.
- The condition search fetches at most 2 results (0 / 1 / 2+ is all that matters).
- Each conditional entry in a Bundle takes one advisory lock. Locks are taken in a fixed order (by hash) to avoid deadlocks between transactions.

## Out of scope (follow-ups)

- **Conditional references** in transactions (`"reference": "Patient?identifier=urn:mrn|A100"`).
- **`If-None-Match` and `If-Modified-Since`** (conditional reads).
- **Deleting multiple matches.**

## Open questions for review

1. **Visibility:** run the condition as the caller (proposed) or always unfiltered? Unfiltered prevents duplicates of hidden resources, but tells callers about resources they can't read (200 with a resource they can't see, or a 412 for them).
2. **Race protection:** advisory lock plus re-check per canonical condition (proposed), or nothing (document that concurrent conditional creates can duplicate)?
3. **Multiple matches on conditional delete:** 412 (proposed), or delete all of them (FHIR allows either)?
4. **API shape:** new `conditionalCreate` / `conditionalUpdate` / `conditionalDelete` methods returning `{ resource, created }` (proposed), or options on `create` / `update` / `delete` (that would change their return types)?
5. **Conditional references** in transactions: include them now, or as the first follow-up (proposed)?

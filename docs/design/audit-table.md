# Design: built-in audit table

Status: **implemented** (2026-11-22) with the proposed answers to every open question: opt-in, `actor` required, append-only triggers, no hash chain, expunge keeps audit rows, search result ids stored.

Differences from the draft: a failed operation whose audit row can't be written throws an `AggregateError` holding the audit error and the original error. `storage.delete` takes `audit` rows like `create` and `update`. Every `onAudit` event now carries `operationId` too.

## Why

Today audit events go only to the app's `onAudit` hook, which runs after a write has committed. If the hook fails, the caller gets an error for a write that happened, and the event may be lost (roadmap, open decision "Audit failures on writes"). Bundles and the REST handler made this worse: one HTTP request can commit a whole transaction whose audit events then fail.

HIPAA §164.312(b) and SOC 2 CC7.2 expect a reliable record of who accessed or changed PHI. A missing audit record for a committed change is the gap auditors look for.

## Goal

An optional, append-only `fhir."_audit"` table, written **in the same database transaction as the data** for every write, so a change and its audit record commit together or not at all. It's a ready-made, reliable sink; `onAudit` keeps working alongside it.

## Configuration

```ts
createFhirStore({
  storage, fhir: r4, resources: ['Patient'], authorize: policy,
  audit: {
    table: true,
    // Required with the table: what identifies the caller in the audit row.
    // Return a stable, non-secret identifier (user id, service name), never a token.
    actor: (ctx: Session) => ctx.userId,
  },
  onAudit: (event) => siem.send(event), // optional, still called after commit
});
```

- `actor` is required when the table is on. The store never serializes `ctx` itself: it's app-defined and could hold tokens or PHI.
- `asSystem(reason)` rows store `system = true`, the reason and no actor. The reason is app-written text: the docs will say to keep PHI out of it.
- `migrate()` creates the table only when `audit.table` is on. Turning it on later is a normal migration.

## Table

Migration `audit:1`, idempotent like the others:

```sql
CREATE TABLE IF NOT EXISTS fhir."_audit" (
  seq           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded      timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation_id  uuid NOT NULL,        -- groups a Bundle's entry rows with its Bundle row
  actor         text,                 -- from audit.actor(ctx); null for system calls
  system        boolean NOT NULL,
  reason        text,                 -- asSystem(reason)
  action        text NOT NULL,        -- create | read | vread | update | delete | history | search | transaction | batch
  resource_type text NOT NULL,
  resource_id   text,
  version_id    bigint,
  outcome       text NOT NULL,        -- success | denied | not-found | error
  status        integer,
  params        text[],               -- search: parameter names only, never values
  result_ids    text[],               -- search: ids returned (≤ _count, so ≤ 1000)
  entries       integer               -- transaction / batch: entry count
);
CREATE INDEX IF NOT EXISTS "_audit_recorded_idx" ON fhir."_audit" (recorded);
CREATE INDEX IF NOT EXISTS "_audit_resource_idx" ON fhir."_audit" (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS "_audit_actor_idx"    ON fhir."_audit" (actor, recorded);
```

It holds the same fields as `StoreAuditEvent`, and nothing more. No resource content, search values or error messages (CLAUDE.md §7). Resource ids are stored. Client-assigned ids can be PHI, which is why the docs already say not to use real-world identifiers as ids.

### Append-only

- **Privileges:** the runtime role gets `INSERT` only on `_audit`: no `SELECT`, `UPDATE`, `DELETE` or `TRUNCATE` (CLAUDE.md §3). Inserts never use `RETURNING`, which would need `SELECT`. Identity columns need no sequence grant. To be verified in a test with a restricted role on real Postgres.
- **Trigger:** a `BEFORE UPDATE OR DELETE` row trigger and a `BEFORE TRUNCATE` statement trigger raise an exception. They also stop the owner by accident; only someone who can drop the trigger can bypass them, and that is a DDL change that shows up in Postgres logs.
- **Retention:** deleting old rows is a job for a separate, privileged role. It has to drop the trigger, or use partitioning (below). fhirforge never deletes audit rows.

## When rows are written

| Situation | How |
| --- | --- |
| Successful write (`create`, `update`, `delete`) | Inside the write's database transaction. The storage fills in `version_id` from the write. If the audit insert fails, the write rolls back and the caller gets the error: nothing is committed without its record. |
| Transaction Bundle | Every write entry's row and the Bundle row, inside `writeAll`'s transaction. GET entries (run after the commit) get their own rows, like single reads. |
| Read, vread, history, search (success) | One insert after the read, before the result is returned. If it fails, the result is withheld (as with `onAudit` today). |
| Denied, not-found, error | One insert on its own. If it fails, the caller gets the audit error, with the original error as its `cause`. |
| Batch | Each entry is a single operation, so each gets its own row by the rules above. The Bundle row is inserted at the end. |

`onAudit`, if configured, is still called after the commit with the same event. Its failures keep today's behavior (`onAuditError` or a withheld result), but the table already has the record.

## Storage contract

```ts
interface FhirStorage {
  // ...
  /** Inserts audit rows on their own (reads, failures). Never returns them: the runtime role can't read the table. */
  recordAudit(rows: readonly AuditRow[]): Promise<void>;
}

interface WriteOptions {
  index?: Indexer;
  /** Audit rows to insert in the same transaction. `write` links a row to a writeAll result, so its version_id is filled in. */
  audit?: readonly (AuditRow & { write?: number })[];
}

type AuditRow = Omit<StoreAuditEvent<unknown>, 'ctx' | 'recorded'> & { actor?: string; operationId: string };
```

`migrate(resourceTypes, { audit: true })` adds the `audit:1` migration. `migrationSql` gets the same option, so external migration tools stay in sync.

## Partitioning (optional, documented, not built in)

Audit tables grow without bound. The docs will show how to create `_audit` as a table partitioned by month, so retention means detaching old partitions instead of row deletes. fhirforge's migration creates a plain table; an app that wants partitions creates the table itself before the first `migrate()`, since `CREATE TABLE IF NOT EXISTS` leaves it alone.

## Security checklist notes

- **SQL:** all values are bind parameters; table and index names go through `ident()`.
- **Privileges:** `INSERT` only for the runtime role, documented in README > Storage layout, with a test using a restricted role on Postgres.
- **Transactions:** write and audit commit together; reads and failures insert on their own.
- **PHI:** no content, values or messages; `actor` comes from an explicit app mapping; `reason` is documented as app text.
- **Expunge (later):** removes a resource's data, not its audit rows (see open questions).

## Open questions for review

1. **Opt-in or required?** Proposed: opt-in (`audit.table: true`) for 0.x, strongly recommended in the README. The alternative mirrors `authorize`: require an explicit `audit: { table: true, … }` or `audit: 'none'` at `createFhirStore`. That's a breaking change, but it makes running without a durable audit log a visible choice.
2. **`actor` required with the table?** Proposed: yes, and the store never serializes `ctx` itself.
3. **Trigger against UPDATE / DELETE / TRUNCATE?** Proposed: yes.
4. **Tamper evidence (hash chain):** each row stores a hash of the previous row, so deleting or editing rows is detectable. This serializes all audited operations on the last row, a real throughput cost. Proposed: not now; document exporting to an external append-only store (SIEM, WORM bucket) for that.
5. **Expunge and audit rows:** proposed: expunge keeps audit rows, because audit retention outlives data. The rows carry ids, not content.
6. **Search `result_ids`:** store them (more complete "who saw what", up to 1000 per row) or only the count? Proposed: store them, as `onAudit` does today.

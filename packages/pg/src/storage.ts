import {
  FhirError,
  stampMeta,
  type AnyResource,
  type AuditRow,
  type FhirStorage,
  type Indexer,
  type PendingAuditRow,
  type PlannedWrite,
  type StoredVersion,
  type UpdateResult,
  type WriteResult,
} from '@fhirforge/core';
import { isDatabase, pgPoolDatabase, type Database, type PgPoolLike, type SqlClient } from './database.js';
import { bootstrapStatements, isIndexMigration, migrationsFor } from './migrations.js';
import { deleteIndexRows, runSearch, writeIndexRows } from './search.js';
import { checkSchemaName, ident, tablesFor } from './sql.js';
import { assertSecureTransport, type TransportOptions } from './transport.js';

export interface PostgresStorageOptions extends TransportOptions {
  /** Postgres schema for all fhirforge tables. Default `fhir`. */
  schema?: string;
}

interface Row {
  v: string;
  last_updated: Date | string;
  deleted: boolean;
  content: (AnyResource & { id: string }) | string | null;
}

/**
 * FHIR storage on Postgres. Pass a `pg` Pool or any `Database`
 * (e.g. `pgliteDatabase(pglite)` from `@fhirforge/pglite`).
 *
 * A Pool pointing at a non-local host must be configured for TLS, or this
 * throws (opt out for development with `allowInsecure: true`).
 *
 * Layout per resource type, in the `fhir` schema by default:
 * - `"Patient"`: the current version (JSONB), one row per resource
 * - `"Patient_history"`: every version, including delete markers
 */
export function postgresStorage(db: Database | PgPoolLike, options: PostgresStorageOptions = {}): FhirStorage {
  // A pg Pool must use TLS unless it connects locally (see transport.ts).
  if (!isDatabase(db)) assertSecureTransport(db, options);
  const database: Database = isDatabase(db) ? db : pgPoolDatabase(db as PgPoolLike);
  const schema = checkSchemaName(options.schema ?? 'fhir');

  const run = async <T>(resourceType: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') {
        throw new Error(
          `fhirforge: the tables for ${resourceType} don't exist in schema "${schema}". Run store.migrate() first.`,
          { cause: err },
        );
      }
      throw err;
    }
  };

  const toVersion = (row: Row): StoredVersion => {
    const content = typeof row.content === 'string' ? (JSON.parse(row.content) as Row['content']) : row.content;
    return {
      versionId: String(row.v),
      lastUpdated: new Date(row.last_updated).toISOString(),
      deleted: row.deleted,
      resource: (content as StoredVersion['resource']) ?? null,
    };
  };

  /** Locks the current row (if any) for the rest of the transaction. */
  const lockCurrent = async (tx: SqlClient, resourceType: string, id: string) => {
    const t = tablesFor(schema, resourceType);
    const { rows } = await tx.query<{ v: string; deleted: boolean }>(
      `SELECT version_id::text AS v, deleted FROM ${t.current} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0];
  };

  /** Writes a version to both tables. `insert` = no current row yet. */
  const writeVersion = async (
    tx: SqlClient,
    resourceType: string,
    id: string,
    versionId: number,
    resource: (AnyResource & { id: string }) | null,
    insert: boolean,
    index: Indexer | undefined,
  ): Promise<StoredVersion> => {
    const t = tablesFor(schema, resourceType);
    const lastUpdated = new Date().toISOString();
    const stamped = resource ? stampMeta(resource, String(versionId), lastUpdated) : null;
    const content = stamped ? JSON.stringify(stamped) : null;
    const deleted = resource === null;
    if (insert) {
      const { rows } = await tx.query(
        `INSERT INTO ${t.current} (id, version_id, last_updated, deleted, content)
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, versionId, lastUpdated, deleted, content],
      );
      if (rows.length === 0) throw FhirError.duplicate(resourceType, id);
    } else {
      await tx.query(
        `UPDATE ${t.current} SET version_id = $2, last_updated = $3, deleted = $4, content = $5::jsonb WHERE id = $1`,
        [id, versionId, lastUpdated, deleted, content],
      );
    }
    await tx.query(
      `INSERT INTO ${t.history} (id, version_id, last_updated, deleted, content) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, versionId, lastUpdated, deleted, content],
    );
    // Search index rows are replaced in the same transaction, so a search never sees a stale index.
    if (stamped && index) await writeIndexRows(tx, t, id, index(stamped));
    else if (!stamped) await deleteIndexRows(tx, t, id);
    return { versionId: String(versionId), lastUpdated, deleted, resource: stamped };
  };

  // ---- audit table ----

  const auditTable = `${ident(schema)}."_audit"`;
  const AUDIT_COLUMNS = 14;
  const AUDIT_CASTS = ['::uuid', '', '', '', '', '', '', '::bigint', '', '::integer', '::text[]', '::text[]', '::integer', ''];

  /** Inserts audit rows (no RETURNING: the runtime role can't read the table). */
  const insertAudit = async (tx: SqlClient, rows: readonly (AuditRow & { versionId?: string })[]) => {
    if (rows.length === 0) return;
    const params: unknown[] = [];
    const values = rows.map((r, n) => {
      params.push(
        r.operationId,
        r.actor ?? null,
        r.system,
        r.reason ?? null,
        r.action,
        r.resourceType,
        r.id ?? null,
        r.versionId ?? null,
        r.outcome,
        r.status ?? null,
        r.params ? [...r.params] : null,
        r.ids ? [...r.ids] : null,
        r.entries ?? null,
        r.expungeReason ?? null,
      );
      const placeholders = AUDIT_CASTS.map((cast, c) => '$' + String(n * AUDIT_COLUMNS + c + 1) + cast);
      return `(${placeholders.join(', ')})`;
    });
    await tx.query(
      `INSERT INTO ${auditTable} (operation_id, actor, system, reason, action, resource_type, resource_id, version_id, outcome, status, params, result_ids, entries, expunge_reason)
       VALUES ${values.join(', ')}`,
      params,
    );
  };

  /** Audit rows for a single write, with the written version filled in. */
  const withVersion = (rows: readonly PendingAuditRow[] | undefined, version: StoredVersion | undefined) =>
    (rows ?? []).map(({ write: _write, ...r }) => ({ ...r, ...(version ? { versionId: version.versionId } : {}) }));

  // ---- writes: one implementation per kind, run inside a caller's transaction ----

  const applyUpdate = async (
    tx: SqlClient,
    resource: AnyResource & { id: string },
    guard: { ifMatch?: string; ifNoneExist?: boolean },
    index: Indexer | undefined,
  ): Promise<UpdateResult> => {
    const { resourceType, id } = resource;
    const current = await lockCurrent(tx, resourceType, id);
    if (guard.ifMatch !== undefined && guard.ifMatch !== current?.v) {
      throw FhirError.versionConflict(resourceType, id, guard.ifMatch, current?.v);
    }
    if (guard.ifNoneExist && current) {
      throw FhirError.versionConflict(resourceType, id, 'none', current.v);
    }
    if (!current) {
      return { version: await writeVersion(tx, resourceType, id, 1, resource, true, index), created: true };
    }
    const version = await writeVersion(tx, resourceType, id, Number(current.v) + 1, resource, false, index);
    return { version, created: current.deleted };
  };

  const applyDelete = async (
    tx: SqlClient,
    resourceType: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<StoredVersion | undefined> => {
    const current = await lockCurrent(tx, resourceType, id);
    if (ifMatch !== undefined && ifMatch !== current?.v) {
      throw FhirError.versionConflict(resourceType, id, ifMatch, current?.v);
    }
    if (!current || current.deleted) return undefined;
    return writeVersion(tx, resourceType, id, Number(current.v) + 1, null, false, undefined);
  };

  const applyWrite = async (tx: SqlClient, write: PlannedWrite, index: Indexer | undefined): Promise<WriteResult> => {
    switch (write.kind) {
      case 'create': {
        const { resource } = write;
        return { kind: 'create', version: await writeVersion(tx, resource.resourceType, resource.id, 1, resource, true, index) };
      }
      case 'update':
        return { kind: 'update', result: await applyUpdate(tx, write.resource, write, index) };
      case 'delete':
        return { kind: 'delete', version: await applyDelete(tx, write.resourceType, write.id, write.ifMatch) };
    }
  };

  // Code-unit order, not localeCompare: every app instance must lock rows in the same order.
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const targetOf = (w: PlannedWrite) => (w.kind === 'delete' ? [w.resourceType, w.id] : [w.resource.resourceType, w.resource.id]);

  return {
    async migrate(resourceTypes, migrateOptions = {}) {
      const migrations = migrationsFor(schema, resourceTypes, { audit: migrateOptions.audit === true });
      return database.transaction(async (tx) => {
        // Serialize concurrent migrations (several app instances starting at once).
        // The lock is released automatically at COMMIT or ROLLBACK.
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`fhirforge:migrate:${schema}`]);
        for (const stmt of bootstrapStatements(schema)) await tx.query(stmt);
        const { rows } = await tx.query<{ id: string }>(`SELECT id FROM ${ident(schema)}."_migrations"`);
        const done = new Set(rows.map((r) => r.id));
        const applied: string[] = [];
        for (const m of migrations) {
          if (done.has(m.id)) continue;
          for (const stmt of m.statements) await tx.query(stmt);
          await tx.query(`INSERT INTO ${ident(schema)}."_migrations" (id) VALUES ($1)`, [m.id]);
          applied.push(m.id);
        }
        // New index tables are empty: existing resources of that type must be indexed.
        const reindex = applied.filter(isIndexMigration).map((id) => id.split(':')[1]!);
        return reindex.length ? { applied, reindex } : { applied };
      });
    },

    create(resource, opts = {}) {
      return run(resource.resourceType, () =>
        database.transaction(async (tx) => {
          const version = await writeVersion(tx, resource.resourceType, resource.id, 1, resource, true, opts.index);
          await insertAudit(tx, withVersion(opts.audit, version));
          return version;
        }),
      );
    },

    update(resource, opts = {}) {
      return run(resource.resourceType, () =>
        database.transaction(async (tx) => {
          const result = await applyUpdate(tx, resource, opts, opts.index);
          await insertAudit(tx, withVersion(opts.audit, result.version));
          return result;
        }),
      );
    },

    delete(resourceType, id, opts = {}) {
      return run(resourceType, () =>
        database.transaction(async (tx) => {
          const version = await applyDelete(tx, resourceType, id, opts.ifMatch);
          await insertAudit(tx, withVersion(opts.audit, version));
          return version;
        }),
      );
    },

    expunge(resourceType, id, opts = {}) {
      const t = tablesFor(schema, resourceType);
      return run(resourceType, () =>
        database.transaction(async (tx) => {
          const current = await lockCurrent(tx, resourceType, id);
          if (opts.ifMatch !== undefined && opts.ifMatch !== current?.v) {
            throw FhirError.versionConflict(resourceType, id, opts.ifMatch, current?.v);
          }
          if (!current) return undefined;
          const { rows } = await tx.query<{ n: number }>(
            `WITH removed AS (DELETE FROM ${t.history} WHERE id = $1 RETURNING 1) SELECT count(*)::int AS n FROM removed`,
            [id],
          );
          // Index rows go with the current row (ON DELETE CASCADE).
          await tx.query(`DELETE FROM ${t.current} WHERE id = $1`, [id]);
          await insertAudit(tx, withVersion(opts.audit, { versionId: current.v } as StoredVersion));
          return { versions: rows[0]!.n };
        }),
      );
    },

    recordAudit(rows) {
      return run('_audit', () => insertAudit(database, rows));
    },

    writeAll(writes, opts = {}) {
      if (writes.length === 0 && !opts.audit?.length) return Promise.resolve([]);
      // Apply in a fixed order (type, then id) so two concurrent calls lock rows in the same order.
      const order = writes
        .map((w, i) => ({ w, i, key: targetOf(w) }))
        .sort((a, b) => compare(a.key[0]!, b.key[0]!) || compare(a.key[1]!, b.key[1]!));
      const seen = new Set<string>();
      for (const { key } of order) {
        const k = key.join('/');
        if (seen.has(k)) throw new Error('writeAll: two writes for the same resource');
        seen.add(k);
      }
      return run(writes[0] ? targetOf(writes[0])[0]! : '_audit', () =>
        database.transaction(async (tx) => {
          const results = new Array<WriteResult>(writes.length);
          for (const { w, i } of order) results[i] = await applyWrite(tx, w, opts.index);
          const versionOf = (n: number | undefined) => {
            const r = n === undefined ? undefined : results[n];
            return r?.kind === 'update' ? r.result.version : r?.version;
          };
          await insertAudit(
            tx,
            (opts.audit ?? []).map(({ write, ...row }) => {
              const v = versionOf(write);
              return v ? { ...row, versionId: v.versionId } : row;
            }),
          );
          return results;
        }),
      );
    },

    read(resourceType, id) {
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        const { rows } = await database.query<Row>(
          `SELECT version_id::text AS v, last_updated, deleted, content FROM ${t.current} WHERE id = $1`,
          [id],
        );
        return rows[0] ? toVersion(rows[0]) : undefined;
      });
    },

    vread(resourceType, id, versionId) {
      if (!/^[1-9]\d{0,17}$/.test(versionId)) return Promise.resolve(undefined);
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        const { rows } = await database.query<Row>(
          `SELECT version_id::text AS v, last_updated, deleted, content FROM ${t.history} WHERE id = $1 AND version_id = $2`,
          [id, versionId],
        );
        return rows[0] ? toVersion(rows[0]) : undefined;
      });
    },

    history(resourceType, id) {
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        const { rows } = await database.query<Row>(
          `SELECT version_id::text AS v, last_updated, deleted, content FROM ${t.history} WHERE id = $1 ORDER BY version_id DESC`,
          [id],
        );
        return rows.map(toVersion);
      });
    },

    search(query) {
      const t = tablesFor(schema, query.resourceType);
      return run(query.resourceType, async () => {
        const { rows, total } = await runSearch(database, t, query);
        return { versions: rows.map((r) => toVersion(r as unknown as Row)), total };
      });
    },

    reindex(resourceType, index) {
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        let count = 0;
        let after = '';
        for (;;) {
          const { rows } = await database.query<{ id: string }>(
            `SELECT id FROM ${t.current} WHERE NOT deleted AND id > $1 ORDER BY id LIMIT 500`,
            [after],
          );
          if (rows.length === 0) return count;
          for (const { id } of rows) {
            // One short transaction per resource, with the row locked, so concurrent writes are never overwritten.
            await database.transaction(async (tx) => {
              const { rows: locked } = await tx.query<Row>(
                `SELECT version_id::text AS v, last_updated, deleted, content FROM ${t.current} WHERE id = $1 FOR UPDATE`,
                [id],
              );
              const v = locked[0] ? toVersion(locked[0]) : undefined;
              if (v?.resource && !v.deleted) {
                await writeIndexRows(tx, t, id, index(v.resource));
                count++;
              }
            });
          }
          after = rows[rows.length - 1]!.id;
        }
      });
    },
  };
}

import {
  FhirError,
  stampMeta,
  type AnyResource,
  type FhirStorage,
  type Indexer,
  type StoredVersion,
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

  return {
    async migrate(resourceTypes) {
      const migrations = migrationsFor(schema, resourceTypes);
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
        database.transaction((tx) => writeVersion(tx, resource.resourceType, resource.id, 1, resource, true, opts.index)),
      );
    },

    update(resource, opts = {}) {
      const { resourceType, id } = resource;
      return run(resourceType, () =>
        database.transaction(async (tx) => {
          const current = await lockCurrent(tx, resourceType, id);
          if (opts.ifMatch !== undefined && opts.ifMatch !== current?.v) {
            throw FhirError.versionConflict(resourceType, id, opts.ifMatch, current?.v);
          }
          if (!current) {
            return { version: await writeVersion(tx, resourceType, id, 1, resource, true, opts.index), created: true };
          }
          const version = await writeVersion(tx, resourceType, id, Number(current.v) + 1, resource, false, opts.index);
          return { version, created: current.deleted };
        }),
      );
    },

    delete(resourceType, id) {
      return run(resourceType, () =>
        database.transaction(async (tx) => {
          const current = await lockCurrent(tx, resourceType, id);
          if (!current || current.deleted) return undefined;
          return writeVersion(tx, resourceType, id, Number(current.v) + 1, null, false, undefined);
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

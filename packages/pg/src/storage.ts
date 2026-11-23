import {
  FhirError,
  stampMeta,
  type AnyResource,
  type AuditRow,
  type FhirStorage,
  type Indexer,
  type Opener,
  type PendingAuditRow,
  type Sealer,
  type WriteCondition,
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
  enc?: string | null;
  dek_id?: string | null;
}

/** The columns every version query selects (encrypted bodies as base64). */
const COLS = `version_id::text AS v, last_updated, deleted, content, encode(enc, 'base64') AS enc, dek_id::text AS dek_id`;

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

  const toVersion = (row: Row, resourceType: string, id: string): StoredVersion => {
    const base = { versionId: String(row.v), lastUpdated: new Date(row.last_updated).toISOString(), deleted: row.deleted };
    // Encrypted: core opens it (the adapter never sees keys).
    if (row.enc && row.dek_id) return { ...base, resource: null, sealed: { resourceType, id, enc: row.enc, dekId: row.dek_id } };
    const content = typeof row.content === 'string' ? (JSON.parse(row.content) as Row['content']) : row.content;
    return { ...base, resource: (content as StoredVersion['resource']) ?? null };
  };

  /** Data keys this adapter instance already stored, so each is inserted once. */
  const knownKeys = new Set<string>();
  const dataKeysTable = `${ident(schema)}."_data_keys"`;
  /** Attaches the wrapped data key to an encrypted version, read on `tx` (so opening it needs no other connection). */
  const withKey = async (tx: SqlClient, v: StoredVersion): Promise<StoredVersion> => {
    if (!v.sealed || v.sealed.key) return v;
    const { rows } = await tx.query<{ key_id: string; wrapped: string }>(
      `SELECT key_id, encode(wrapped, 'base64') AS wrapped FROM ${dataKeysTable} WHERE id = $1::uuid`,
      [v.sealed.dekId],
    );
    return rows[0] ? { ...v, sealed: { ...v.sealed, key: { keyId: rows[0].key_id, wrapped: rows[0].wrapped } } } : v;
  };
  const storeDataKey = async (tx: SqlClient, sealed: { dekId: string; keyId: string; wrapped: string }) => {
    if (knownKeys.has(sealed.dekId)) return;
    await tx.query(
      `INSERT INTO ${dataKeysTable} (id, key_id, wrapped) VALUES ($1::uuid, $2, decode($3, 'base64')) ON CONFLICT (id) DO NOTHING`,
      [sealed.dekId, sealed.keyId, sealed.wrapped],
    );
    knownKeys.add(sealed.dekId);
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
    seal?: Sealer,
  ): Promise<StoredVersion> => {
    const t = tablesFor(schema, resourceType);
    const lastUpdated = new Date().toISOString();
    const stamped = resource ? stampMeta(resource, String(versionId), lastUpdated) : null;
    const deleted = resource === null;
    // With encryption, the body goes into `enc` and `content` stays NULL.
    const sealed = stamped && seal ? await seal(stamped) : undefined;
    if (sealed) await storeDataKey(tx, sealed);
    const content = stamped && !sealed ? JSON.stringify(stamped) : null;
    const enc = sealed?.enc ?? null;
    const dekId = sealed?.dekId ?? null;
    if (insert) {
      const { rows } = await tx.query(
        `INSERT INTO ${t.current} (id, version_id, last_updated, deleted, content, enc, dek_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, decode($6, 'base64'), $7::uuid) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, versionId, lastUpdated, deleted, content, enc, dekId],
      );
      if (rows.length === 0) throw FhirError.duplicate(resourceType, id);
    } else {
      await tx.query(
        `UPDATE ${t.current} SET version_id = $2, last_updated = $3, deleted = $4, content = $5::jsonb,
           enc = decode($6, 'base64'), dek_id = $7::uuid WHERE id = $1`,
        [id, versionId, lastUpdated, deleted, content, enc, dekId],
      );
    }
    await tx.query(
      `INSERT INTO ${t.history} (id, version_id, last_updated, deleted, content, enc, dek_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, decode($6, 'base64'), $7::uuid)`,
      [id, versionId, lastUpdated, deleted, content, enc, dekId],
    );
    // Search index rows are replaced in the same transaction, so a search never sees a stale index.
    if (stamped && index) await writeIndexRows(tx, t, id, await index(stamped));
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

  // ---- conditional writes ----

  /**
   * Serializes conditional writes with the same condition and re-checks it: under the lock,
   * the condition must still match as planned, or nothing is written (412).
   */
  const checkCondition = async (tx: SqlClient, condition: WriteCondition | undefined) => {
    if (!condition) return;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fhirforge:conditional:${schema}:${condition.key}`]);
    const t = tablesFor(schema, condition.query.resourceType);
    const { rows } = await runSearch(tx, t, { ...condition.query, sort: [], count: 2, offset: 0 });
    const ids = rows.map((r) => r.id);
    const { expect } = condition;
    const ok = expect === 'none' ? ids.length === 0 : ids.length === 1 && ids[0] === expect.id;
    if (!ok) {
      throw new FhirError(412, 'conflict', `${condition.query.resourceType}: the condition no longer matches as it did when checked`);
    }
  };

  // ---- writes: one implementation per kind, run inside a caller's transaction ----

  const applyUpdate = async (
    tx: SqlClient,
    resource: AnyResource & { id: string },
    guard: { ifMatch?: string; ifNoneExist?: boolean },
    index: Indexer | undefined,
    seal?: Sealer,
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
      return { version: await writeVersion(tx, resourceType, id, 1, resource, true, index, seal), created: true };
    }
    const version = await writeVersion(tx, resourceType, id, Number(current.v) + 1, resource, false, index, seal);
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

  const applyWrite = async (tx: SqlClient, write: PlannedWrite, index: Indexer | undefined, seal?: Sealer): Promise<WriteResult> => {
    switch (write.kind) {
      case 'create': {
        const { resource } = write;
        return { kind: 'create', version: await writeVersion(tx, resource.resourceType, resource.id, 1, resource, true, index, seal) };
      }
      case 'update':
        return { kind: 'update', result: await applyUpdate(tx, write.resource, write, index, seal) };
      case 'delete':
        return { kind: 'delete', version: await applyDelete(tx, write.resourceType, write.id, write.ifMatch) };
    }
  };

  // Code-unit order, not localeCompare: every app instance must lock rows in the same order.
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const targetOf = (w: PlannedWrite) => (w.kind === 'delete' ? [w.resourceType, w.id] : [w.resource.resourceType, w.resource.id]);

  return {
    async migrate(resourceTypes, migrateOptions = {}) {
      const migrations = migrationsFor(schema, resourceTypes, {
        audit: migrateOptions.audit === true,
        encryption: migrateOptions.encryption === true,
      });
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
          await checkCondition(tx, opts.condition);
          const version = await writeVersion(tx, resource.resourceType, resource.id, 1, resource, true, opts.index, opts.seal);
          await insertAudit(tx, withVersion(opts.audit, version));
          return version;
        }),
      );
    },

    update(resource, opts = {}) {
      return run(resource.resourceType, () =>
        database.transaction(async (tx) => {
          await checkCondition(tx, opts.condition);
          const result = await applyUpdate(tx, resource, opts, opts.index, opts.seal);
          await insertAudit(tx, withVersion(opts.audit, result.version));
          return result;
        }),
      );
    },

    delete(resourceType, id, opts = {}) {
      return run(resourceType, () =>
        database.transaction(async (tx) => {
          await checkCondition(tx, opts.condition);
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
          // Conditions first, locked in key order (no deadlocks between transactions), all checked
          // before any write of this transaction changes what they'd match.
          const conditions = writes.flatMap((w) => (w.condition ? [w.condition] : [])).sort((a, b) => compare(a.key, b.key));
          for (const c of conditions) await checkCondition(tx, c);
          for (const { w, i } of order) results[i] = await applyWrite(tx, w, opts.index, opts.seal);
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
          `SELECT ${COLS} FROM ${t.current} WHERE id = $1`,
          [id],
        );
        return rows[0] ? toVersion(rows[0], resourceType, id) : undefined;
      });
    },

    vread(resourceType, id, versionId) {
      if (!/^[1-9]\d{0,17}$/.test(versionId)) return Promise.resolve(undefined);
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        const { rows } = await database.query<Row>(
          `SELECT ${COLS} FROM ${t.history} WHERE id = $1 AND version_id = $2`,
          [id, versionId],
        );
        return rows[0] ? toVersion(rows[0], resourceType, id) : undefined;
      });
    },

    history(resourceType, id) {
      const t = tablesFor(schema, resourceType);
      return run(resourceType, async () => {
        const { rows } = await database.query<Row>(`SELECT ${COLS} FROM ${t.history} WHERE id = $1 ORDER BY version_id DESC`, [id]);
        return rows.map((row) => toVersion(row, resourceType, id));
      });
    },

    search(query) {
      const t = tablesFor(schema, query.resourceType);
      return run(query.resourceType, async () => {
        const { rows, total } = await runSearch(database, t, query);
        return { versions: rows.map((r) => toVersion(r as unknown as Row, query.resourceType, r.id)), total };
      });
    },

    reindex(resourceType, index, reindexOptions = {}) {
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
              const { rows: locked } = await tx.query<Row>(`SELECT ${COLS} FROM ${t.current} WHERE id = $1 FOR UPDATE`, [id]);
              let v = locked[0] ? toVersion(locked[0], resourceType, id) : undefined;
              if (v?.sealed) {
                if (!reindexOptions.open) throw new Error(`fhirforge: ${resourceType}/${id} is encrypted; reindex needs the store's encryption settings`);
                v = await reindexOptions.open(await withKey(tx, v));
              }
              if (v?.resource && !v.deleted) {
                await writeIndexRows(tx, t, id, await index(v.resource));
                count++;
              }
            });
          }
          after = rows[rows.length - 1]!.id;
        }
      });
    },

    dataKeys(ids) {
      if (ids.length === 0) return Promise.resolve([]);
      return run('_data_keys', async () => {
        const { rows } = await database.query<{ id: string; key_id: string; wrapped: string }>(
          `SELECT id::text AS id, key_id, encode(wrapped, 'base64') AS wrapped FROM ${dataKeysTable} WHERE id = ANY($1::uuid[])`,
          [[...ids]],
        );
        return rows.map((r) => ({ id: r.id, keyId: r.key_id, wrapped: r.wrapped }));
      });
    },

    reencrypt(resourceType, opts) {
      const t = tablesFor(schema, resourceType);
      // Rows to rewrite: plaintext bodies, or bodies under a data key older than `olderThan`.
      const stale = opts.olderThan
        ? `((enc IS NULL AND content IS NOT NULL) OR dek_id IN (SELECT id FROM ${dataKeysTable} WHERE created < $2::timestamptz))`
        : `(enc IS NULL AND content IS NOT NULL)`;
      const extra = opts.olderThan ? [opts.olderThan] : [];
      return run(resourceType, async () => {
        let count = 0;
        let after = '';
        for (;;) {
          const { rows } = await database.query<{ id: string }>(
            `SELECT DISTINCT id FROM ${t.history} WHERE id > $1 AND ${stale} ORDER BY id LIMIT 500`,
            [after, ...extra],
          );
          if (rows.length === 0) return count;
          for (const { id } of rows) {
            await opts.prepare?.(); // a fresh data key if the window ran out (outside the transaction)
            // One resource per transaction, with its current row locked, so writes can't interleave.
            await database.transaction(async (tx) => {
              const { rows: current } = await tx.query<{ v: string }>(
                `SELECT version_id::text AS v FROM ${t.current} WHERE id = $1 FOR UPDATE`,
                [id],
              );
              if (!current[0]) return; // expunged meanwhile
              const { rows: versions } = await tx.query<Row>(`SELECT ${COLS} FROM ${t.history} WHERE id = $1 AND ${stale}`, [id, ...extra]);
              for (const row of versions) {
                const v = await opts.open(await withKey(tx, toVersion(row, resourceType, id)));
                if (!v.resource || v.deleted) continue;
                const sealed = await opts.seal(v.resource as Parameters<typeof opts.seal>[0]);
                await storeDataKey(tx, sealed);
                const params = [id, v.versionId, sealed.enc, sealed.dekId];
                await tx.query(
                  `UPDATE ${t.history} SET content = NULL, enc = decode($3, 'base64'), dek_id = $4::uuid WHERE id = $1 AND version_id = $2`,
                  params,
                );
                if (v.versionId === current[0].v) {
                  await tx.query(
                    `UPDATE ${t.current} SET content = NULL, enc = decode($3, 'base64'), dek_id = $4::uuid WHERE id = $1 AND version_id = $2`,
                    params,
                  );
                }
              }
              count++;
            });
          }
          after = rows[rows.length - 1]!.id;
        }
      });
    },
  };
}

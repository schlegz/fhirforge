import type { IndexRow, Prefix, SearchClause, SearchCondition, SearchQuery, SortKey } from '@fhirforge/core';
import type { SqlClient } from './database.js';
import { INDEX_KINDS, type IndexKind, type Tables } from './sql.js';

/**
 * Builds SQL with bind parameters only. Every value from a query or a
 * resource goes through `bind()`; the only things interpolated into SQL text
 * are table names from `tablesFor()` and fixed fragments in this file.
 */
class Sql {
  readonly params: unknown[] = [];
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

/** Escapes LIKE wildcards so a search for `50%` matches the text "50%", not anything starting with "50". */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

type Range = { lo: string; hi: string };

/** FHIR prefix semantics for a stored range [lo, hi) against a search range [pl, ph). Nulls mean unbounded. */
type Lazy = () => string;

/** Parameters are bound only when used: Postgres rejects bind parameters it can't type. */
function rangeCondition(prefix: Prefix, r: Range, lazyLow: Lazy, lazyHigh: Lazy): string {
  let low: string | undefined;
  let high: string | undefined;
  const pl = () => (low ??= lazyLow());
  const ph = () => (high ??= lazyHigh());
  switch (prefix) {
    case 'eq':
      return `(${r.lo} >= ${pl()} AND ${r.hi} <= ${ph()})`;
    case 'ne':
      return `NOT (${r.lo} >= ${pl()} AND ${r.hi} <= ${ph()})`;
    case 'gt':
      return `(${r.hi} > ${ph()})`;
    case 'lt':
      return `(${r.lo} < ${pl()})`;
    case 'ge':
      return `(${r.hi} > ${pl()})`;
    case 'le':
      return `(${r.lo} < ${ph()})`;
    case 'sa':
      return `(${r.lo} >= ${ph()})`;
    case 'eb':
      return `(${r.hi} <= ${pl()})`;
  }
}

/** FHIR prefix semantics for a stored point value against a search value with precision range [low, high). */
function pointCondition(prefix: Prefix, col: string, lazyValue: Lazy, lazyLow: Lazy, lazyHigh: Lazy): string {
  const value = () => lazyValue();
  const low = () => lazyLow();
  const high = () => lazyHigh();
  switch (prefix) {
    case 'eq':
      return `(${col} >= ${low()} AND ${col} < ${high()})`;
    case 'ne':
      return `NOT (${col} >= ${low()} AND ${col} < ${high()})`;
    case 'gt':
    case 'sa':
      return `(${col} > ${value()})`;
    case 'lt':
    case 'eb':
      return `(${col} < ${value()})`;
    case 'ge':
      return `(${col} >= ${value()})`;
    case 'le':
      return `(${col} <= ${value()})`;
  }
}

function condition(sql: Sql, c: SearchCondition): string {
  switch (c.kind) {
    case 'blind':
      // Only hashes under the current key match: after rotating the key, reindex.
      return `(i.key_id = ${sql.bind(c.keyId)} AND i.hash = ${sql.bind(c.hash)})`;
    case 'string':
      if (c.mode === 'exact') return `i.value_exact = ${sql.bind(c.value)}`;
      if (c.mode === 'contains') return `i.value_norm LIKE ${sql.bind(`%${likeEscape(c.value)}%`)} ESCAPE '\\'`;
      return `i.value_norm LIKE ${sql.bind(`${likeEscape(c.value)}%`)} ESCAPE '\\'`;
    case 'token': {
      const parts: string[] = [];
      if (c.code !== undefined) parts.push(`i.code = ${sql.bind(c.code)}`);
      if (c.system === null) parts.push('i.system IS NULL');
      else if (c.system !== undefined) parts.push(`i.system = ${sql.bind(c.system)}`);
      return `(${parts.join(' AND ')})`;
    }
    case 'date':
      return rangeCondition(
        c.prefix,
        { lo: `COALESCE(i.low, '-infinity'::timestamptz)`, hi: `COALESCE(i.high, 'infinity'::timestamptz)` },
        () => `${sql.bind(c.low)}::timestamptz`,
        () => `${sql.bind(c.high)}::timestamptz`,
      );
    case 'reference': {
      if (c.reference !== undefined) return `i.reference = ${sql.bind(c.reference)}`;
      const parts = [`i.target_id = ${sql.bind(c.targetId)}`];
      if (c.targetType !== undefined) parts.push(`i.target_type = ${sql.bind(c.targetType)}`);
      return `(${parts.join(' AND ')})`;
    }
    case 'number':
      return pointCondition(
        c.prefix,
        'i.value',
        () => `${sql.bind(c.value)}::numeric`,
        () => `${sql.bind(c.low)}::numeric`,
        () => `${sql.bind(c.high)}::numeric`,
      );
    case 'quantity': {
      const parts = [
        pointCondition(
          c.prefix,
          'i.value',
          () => `${sql.bind(c.value)}::numeric`,
          () => `${sql.bind(c.low)}::numeric`,
          () => `${sql.bind(c.high)}::numeric`,
        ),
      ];
      if (c.system === null) parts.push('i.system IS NULL');
      else if (c.system !== undefined) parts.push(`i.system = ${sql.bind(c.system)}`);
      if (c.code !== undefined) parts.push(`i.code = ${sql.bind(c.code)}`);
      return `(${parts.join(' AND ')})`;
    }
    case 'uri':
      return `i.value = ${sql.bind(c.value)}`;
  }
}

function indexKindOf(type: SearchClause['type']): IndexKind {
  if (type === 'id' || type === 'lastUpdated') throw new Error(`${type} has no index table`);
  return type;
}

function clauseSql(sql: Sql, t: Tables, clause: SearchClause): string {
  if (clause.type === 'id') {
    const ids = clause.conditions.flatMap((c) => (c.kind === 'token' && c.code !== undefined ? [c.code] : []));
    return `r.id = ANY(${sql.bind(ids)}::text[])`;
  }
  if (clause.type === 'lastUpdated') {
    const r = { lo: 'r.last_updated', hi: `(r.last_updated + interval '1 millisecond')` };
    const ors = clause.conditions.map((c) =>
      c.kind === 'date'
        ? rangeCondition(c.prefix, r, () => `${sql.bind(c.low)}::timestamptz`, () => `${sql.bind(c.high)}::timestamptz`)
        : 'false',
    );
    return `(${ors.join(' OR ')})`;
  }
  const table = t.index[indexKindOf(clause.type)];
  const base = `SELECT 1 FROM ${table} i WHERE i.resource_id = r.id AND i.param = ${sql.bind(clause.param)}`;
  if (clause.missing !== undefined) {
    return clause.missing ? `NOT EXISTS (${base})` : `EXISTS (${base})`;
  }
  const ors = clause.conditions.map((c) => condition(sql, c)).join(' OR ');
  return `${clause.negate ? 'NOT ' : ''}EXISTS (${base} AND (${ors}))`;
}

function sortSql(sql: Sql, t: Tables, key: SortKey): string {
  const dir = key.descending ? 'DESC' : 'ASC';
  if (key.type === 'id') return `r.id ${dir}`;
  if (key.type === 'lastUpdated') return `r.last_updated ${dir}`;
  const table = t.index[indexKindOf(key.type)];
  const agg = key.descending ? 'max' : 'min';
  const col =
    key.type === 'date'
      ? key.descending
        ? `COALESCE(i.high, 'infinity'::timestamptz)`
        : `COALESCE(i.low, '-infinity'::timestamptz)`
      : key.type === 'string'
        ? 'i.value_norm'
        : key.type === 'token'
          ? 'i.code'
          : key.type === 'reference'
            ? 'i.reference'
            : 'i.value';
  return `(SELECT ${agg}(${col}) FROM ${table} i WHERE i.resource_id = r.id AND i.param = ${sql.bind(key.param)}) ${dir} NULLS LAST`;
}

export interface SearchRow {
  id: string;
  v: string;
  last_updated: Date | string;
  deleted: boolean;
  content: unknown;
  enc: string | null;
  dek_id: string | null;
  total: string | number;
}

export async function runSearch(db: SqlClient, t: Tables, query: SearchQuery): Promise<{ rows: SearchRow[]; total: number }> {
  const sql = new Sql();
  const where = ['NOT r.deleted', ...query.clauses.map((c) => clauseSql(sql, t, c))].join('\n  AND ');
  const order = [...query.sort.map((k) => sortSql(sql, t, k)), 'r.id ASC'].join(', ');
  const limit = sql.bind(query.count);
  const offset = sql.bind(query.offset);
  const text = `SELECT r.id, r.version_id::text AS v, r.last_updated, r.deleted, r.content, encode(r.enc, 'base64') AS enc, r.dek_id::text AS dek_id, count(*) OVER () AS total
FROM ${t.current} r
WHERE ${where}
ORDER BY ${order}
LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await db.query<SearchRow>(text, sql.params);
  if (rows.length > 0) return { rows, total: Number(rows[0]!.total) };
  if (query.offset === 0) return { rows, total: 0 };
  // Past the last page: the window count is gone, so count separately (same WHERE, same binds).
  const countSql = new Sql();
  const countWhere = ['NOT r.deleted', ...query.clauses.map((c) => clauseSql(countSql, t, c))].join(' AND ');
  const { rows: count } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${t.current} r WHERE ${countWhere}`,
    countSql.params,
  );
  return { rows, total: Number(count[0]?.n ?? 0) };
}

/** Replaces a resource's index rows: delete all, insert the new set. Runs inside the caller's transaction. */
export async function writeIndexRows(tx: SqlClient, t: Tables, resourceId: string, rows: readonly IndexRow[]): Promise<void> {
  for (const kind of INDEX_KINDS) {
    await tx.query(`DELETE FROM ${t.index[kind]} WHERE resource_id = $1`, [resourceId]);
  }
  for (const kind of INDEX_KINDS) {
    const ofKind = rows.filter((r) => r.kind === kind);
    if (ofKind.length === 0) continue;
    const sql = new Sql();
    const values = ofKind.map((r) => `(${[resourceId, r.param, ...columnValues(r)].map((v) => sql.bind(v)).join(', ')})`);
    await tx.query(`INSERT INTO ${t.index[kind]} (resource_id, param, ${COLUMNS[kind]}) VALUES ${values.join(', ')}`, sql.params);
  }
}

const COLUMNS: Record<IndexKind, string> = {
  string: 'value_norm, value_exact',
  token: 'system, code',
  date: 'low, high',
  reference: 'target_type, target_id, reference',
  number: 'value',
  quantity: 'value, system, code',
  uri: 'value',
  blind: 'key_id, hash',
};

function columnValues(r: IndexRow): unknown[] {
  switch (r.kind) {
    case 'string':
      return [r.valueNorm, r.valueExact];
    case 'token':
      return [r.system, r.code];
    case 'date':
      return [r.low, r.high];
    case 'reference':
      return [r.targetType, r.targetId, r.reference];
    case 'number':
      return [r.value];
    case 'quantity':
      return [r.value, r.system, r.code];
    case 'uri':
      return [r.value];
    case 'blind':
      return [r.keyId, r.hash];
  }
}

export async function deleteIndexRows(tx: SqlClient, t: Tables, resourceId: string): Promise<void> {
  await writeIndexRows(tx, t, resourceId, []);
}

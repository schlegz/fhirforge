import { checkSchemaName, ident, tablesFor } from './sql.js';

/** Migrations that create search index tables: existing resources must be reindexed after them. */
export function isIndexMigration(id: string): boolean {
  return /^resource:[A-Za-z]+:2$/.test(id);
}

export interface Migration {
  /** Stable id recorded in `<schema>._migrations`, e.g. `resource:Patient:1`. */
  id: string;
  statements: string[];
}

/**
 * Every migration fhirforge knows for these resource types, in order.
 * Migrations are append-only: never edit one that has shipped, add a new id.
 */
export function migrationsFor(
  schema: string,
  resourceTypes: readonly string[],
  options: { audit?: boolean; encryption?: boolean } = {},
): Migration[] {
  checkSchemaName(schema);
  const migrations: Migration[] = [];
  if (options.audit) migrations.push(...auditMigrations(schema));
  if (options.encryption) {
    // Wrapped data keys (envelope encryption). Rows point here; the keys themselves are
    // wrapped by the app's KMS and never stored in plaintext.
    migrations.push({
      id: 'crypto:1',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${ident(schema)}."_data_keys" (
  id uuid PRIMARY KEY,
  key_id text NOT NULL,
  wrapped bytea NOT NULL,
  created timestamptz NOT NULL DEFAULT now()
)`,
      ],
    });
  }
  for (const resourceType of [...resourceTypes].sort()) {
    const t = tablesFor(schema, resourceType);
    const idx = (suffix: string) => ident(`${resourceType}_${suffix}`);
    migrations.push({
      id: `resource:${resourceType}:1`,
      statements: [
        // Current version of each resource. `content` is null for a deleted resource.
        `CREATE TABLE IF NOT EXISTS ${t.current} (
  id text PRIMARY KEY,
  version_id bigint NOT NULL,
  last_updated timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  content jsonb
)`,
        // Every version, including the current one and delete markers.
        `CREATE TABLE IF NOT EXISTS ${t.history} (
  id text NOT NULL,
  version_id bigint NOT NULL,
  last_updated timestamptz NOT NULL,
  deleted boolean NOT NULL,
  content jsonb,
  PRIMARY KEY (id, version_id)
)`,
        `CREATE INDEX IF NOT EXISTS ${idx('last_updated_idx')} ON ${t.current} (last_updated)`,
      ],
    });
    // Search indexes: one table per value kind. Rows are copies of resource data (may be PHI)
    // and cascade away with the resource row, so expunge can't leave them behind.
    const fk = `resource_id text NOT NULL REFERENCES ${t.current} (id) ON DELETE CASCADE,\n  param text NOT NULL`;
    const table = (kind: string, columns: string, lookup: string) => [
      `CREATE TABLE IF NOT EXISTS ${t.index[kind as keyof typeof t.index]} (\n  ${fk},\n  ${columns}\n)`,
      `CREATE INDEX IF NOT EXISTS ${idx(`${kind}_resource_idx`)} ON ${t.index[kind as keyof typeof t.index]} (resource_id)`,
      `CREATE INDEX IF NOT EXISTS ${idx(`${kind}_lookup_idx`)} ON ${t.index[kind as keyof typeof t.index]} (${lookup})`,
    ];
    migrations.push({
      id: `resource:${resourceType}:2`,
      statements: [
        ...table('string', 'value_norm text NOT NULL,\n  value_exact text NOT NULL', 'param, value_norm text_pattern_ops'),
        ...table('token', 'system text,\n  code text NOT NULL', 'param, code, system'),
        ...table('date', 'low timestamptz,\n  high timestamptz', 'param, low, high'),
        ...table('reference', 'target_type text,\n  target_id text,\n  reference text NOT NULL', 'param, target_id, target_type'),
        ...table('number', 'value numeric NOT NULL', 'param, value'),
        ...table('quantity', 'value numeric NOT NULL,\n  system text,\n  code text', 'param, value'),
        ...table('uri', 'value text NOT NULL', 'param, value'),
      ],
    });
    // Encrypted bodies: `enc` replaces `content` (which is then NULL) when encryption is on.
    migrations.push({
      id: `resource:${resourceType}:3`,
      statements: [t.current, t.history].map(
        (table) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS enc bytea, ADD COLUMN IF NOT EXISTS dek_id uuid`,
      ),
    });
    // Blind indexes: keyed hashes of `blind` parameters' normalized values (no plaintext).
    migrations.push({
      id: `resource:${resourceType}:4`,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${t.index.blind} (\n  ${fk},\n  key_id text NOT NULL,\n  hash text NOT NULL\n)`,
        `CREATE INDEX IF NOT EXISTS ${idx('blind_resource_idx')} ON ${t.index.blind} (resource_id)`,
        `CREATE INDEX IF NOT EXISTS ${idx('blind_lookup_idx')} ON ${t.index.blind} (param, hash)`,
      ],
    });
  }
  return migrations;
}

/**
 * The built-in audit table. Append-only: the runtime role gets INSERT only, and
 * triggers refuse UPDATE, DELETE and TRUNCATE even for the owner. Rows hold
 * audit metadata (who, what, which resource), never resource content.
 */
function auditMigrations(schema: string): Migration[] {
  const s = ident(schema);
  const table = `${s}."_audit"`;
  const fn = `${s}."_audit_append_only"`;
  return [
    {
      id: 'audit:1',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${table} (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded timestamptz NOT NULL DEFAULT clock_timestamp(),
  operation_id uuid NOT NULL,
  actor text,
  system boolean NOT NULL,
  reason text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  version_id bigint,
  outcome text NOT NULL,
  status integer,
  params text[],
  result_ids text[],
  entries integer
)`,
        `CREATE INDEX IF NOT EXISTS "_audit_recorded_idx" ON ${table} (recorded)`,
        `CREATE INDEX IF NOT EXISTS "_audit_resource_idx" ON ${table} (resource_type, resource_id)`,
        `CREATE INDEX IF NOT EXISTS "_audit_actor_idx" ON ${table} (actor, recorded)`,
        `CREATE INDEX IF NOT EXISTS "_audit_operation_idx" ON ${table} (operation_id)`,
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fhirforge: the audit table is append-only';
END
$$`,
        `CREATE OR REPLACE TRIGGER "_audit_no_update_delete" BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        `CREATE OR REPLACE TRIGGER "_audit_no_truncate" BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`,
      ],
    },
    {
      // The reason required by expunge. Adding a column isn't blocked by the row triggers.
      id: 'audit:2',
      statements: [`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS expunge_reason text`],
    },
  ];
}

/** Statements that create the schema and the migration log. Always safe to re-run. */
export function bootstrapStatements(schema: string): string[] {
  const s = ident(checkSchemaName(schema));
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s}`,
    `CREATE TABLE IF NOT EXISTS ${s}."_migrations" (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
  ];
}

/**
 * The full migration as plain SQL, for teams that run migrations with their
 * own tool (Prisma, Drizzle, Flyway). Idempotent: every statement uses IF NOT EXISTS.
 */
export function migrationSql(
  resourceTypes: readonly string[],
  options: { schema?: string; audit?: boolean; encryption?: boolean } = {},
): string {
  const schema = options.schema ?? 'fhir';
  const migrations = migrationsFor(schema, resourceTypes, { audit: options.audit, encryption: options.encryption });
  const lines = ['-- Generated by @fhirforge/pg', 'BEGIN;', ''];
  for (const stmt of bootstrapStatements(schema)) lines.push(`${stmt};`, '');
  for (const m of migrations) {
    lines.push(`-- ${m.id}`);
    for (const stmt of m.statements) lines.push(`${stmt};`, '');
    lines.push(`INSERT INTO ${ident(schema)}."_migrations" (id) VALUES ('${m.id}') ON CONFLICT (id) DO NOTHING;`, '');
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

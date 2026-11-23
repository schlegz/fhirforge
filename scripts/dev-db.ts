/**
 * Creates a local development database and migrates every resource type.
 *
 *   pnpm dev:db                    # asks for the database name
 *   pnpm dev:db fhir_dev           # or pass it
 *   pnpm dev:db fhir_dev --pglite  # no server: an in-process PGlite database in .fhir-dev/fhir_dev
 *
 * Postgres: connects to the server in FHIRFORGE_DEV_DATABASE_URL (default
 * postgres://postgres@localhost:5432/postgres; put the password there or in PGPASSWORD),
 * creates the database if it doesn't exist, and migrates it. Only local servers: this
 * script is for development and refuses anything else.
 *
 * Every R4 resource type is migrated, plus the audit table and the encryption tables, so
 * any feature works against it. Safe to re-run: migrations only apply what's missing.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { PGlite } from '@electric-sql/pglite';
import { postgresStorage } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import pg from 'pg';

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const args = process.argv.slice(2);
const usePglite = args.includes('--pglite');
let name = args.find((a) => !a.startsWith('--'));

if (!name) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  name = (await rl.question('Database name (lowercase letters, digits, _): ')).trim();
  rl.close();
}
if (!NAME.test(name)) {
  console.error(`Invalid database name. Use lowercase letters, digits and underscores, starting with a letter or _ (max 63).`);
  process.exit(1);
}

const resourceTypes = [...r4.validation!.resources];
const migrateOptions = { audit: true, encryption: true };

/** A connection URL for display: never print a password. */
const redact = (url: URL) => {
  const copy = new URL(url);
  if (copy.password) copy.password = '***';
  return copy.toString();
};

const started = Date.now();
let applied: string[];

if (usePglite) {
  const dir = resolve('.fhir-dev', name);
  mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  try {
    ({ applied } = await pgliteStorage(db).migrate(resourceTypes, migrateOptions));
  } finally {
    await db.close();
  }
  console.log(`PGlite database: ${dir}`);
  console.log(`Use it with: pgliteStorage(new PGlite('${join('.fhir-dev', name)}'))`);
} else {
  const server = new URL(process.env.FHIRFORGE_DEV_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres');
  if (!LOCAL_HOSTS.has(server.hostname)) {
    console.error(`Refusing ${server.hostname}: dev:db only creates databases on a local server.`);
    process.exit(1);
  }

  // Create the database if it doesn't exist (CREATE DATABASE can't run in a transaction or take parameters;
  // the name was checked against NAME above, so quoting it is safe).
  const admin = new pg.Client({ connectionString: server.toString() });
  try {
    await admin.connect();
  } catch (err) {
    console.error(`Can't connect to ${redact(server)}: ${(err as Error).message}`);
    console.error('Start a local Postgres, e.g.: docker run -d --name fhir-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18');
    console.error('and set FHIRFORGE_DEV_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres');
    process.exit(1);
  }
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${name}"`);
      console.log(`Created database ${name}`);
    } else {
      console.log(`Database ${name} exists; migrating it`);
    }
  } finally {
    await admin.end();
  }

  const target = new URL(server);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
  try {
    ({ applied } = await postgresStorage(pool).migrate(resourceTypes, migrateOptions));
  } finally {
    await pool.end();
  }
  console.log(`Postgres database: ${redact(target)}`);
}

console.log(
  applied.length
    ? `Applied ${applied.length} migrations for ${resourceTypes.length} resource types in ${Date.now() - started} ms.`
    : `Already up to date (${resourceTypes.length} resource types).`,
);

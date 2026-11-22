import { PGlite } from '@electric-sql/pglite';
import type { FhirStorage } from '@fhirforge/core';
import { postgresStorage } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import pg from 'pg';

export interface Backend {
  name: string;
  /** A fresh, empty storage (its own database or schema). */
  storage(): Promise<FhirStorage>;
  close(): Promise<void>;
}

/** One in-process PGlite for the whole file; each storage gets its own schema. */
export function pgliteBackend(): Backend {
  let db: PGlite | undefined;
  let n = 0;
  return {
    name: 'PGlite',
    async storage() {
      db ??= new PGlite();
      return pgliteStorage(db, { schema: `fhir_test_${n++}` });
    },
    async close() {
      await db?.close();
    },
  };
}

/** Real Postgres, only when FHIRFORGE_TEST_DATABASE_URL is set. Each storage gets its own schema, dropped at the end. */
export function postgresBackend(): Backend | undefined {
  const url = process.env.FHIRFORGE_TEST_DATABASE_URL;
  if (!url) return undefined;
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const schemas: string[] = [];
  return {
    name: 'Postgres',
    async storage() {
      const schema = `fhir_test_${process.pid}_${schemas.length}_${Date.now().toString(36)}`;
      schemas.push(schema);
      return postgresStorage(pool, { schema });
    },
    async close() {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

export const backends: Backend[] = [pgliteBackend(), postgresBackend()].filter((b): b is Backend => b !== undefined);

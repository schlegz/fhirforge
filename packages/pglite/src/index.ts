import type { FhirStorage } from '@fhirforge/core';
import { postgresStorage, type Database, type PostgresStorageOptions } from '@fhirforge/pg';

/** The parts of a PGlite instance fhirforge uses (no hard dependency on @electric-sql/pglite). */
export interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  transaction<T>(fn: (tx: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T>;
}

/** Wraps a PGlite instance as a fhirforge Database. */
export function pgliteDatabase(pg: PGliteLike): Database {
  return {
    query: (sql, params) => pg.query(sql, params) as never,
    transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) as never })),
  };
}

/**
 * FHIR storage on an in-process PGlite database: real Postgres, no server or
 * Docker. Good for tests, local development and trying fhirforge out.
 *
 * ```ts
 * import { PGlite } from '@electric-sql/pglite';
 * const storage = pgliteStorage(new PGlite());
 * ```
 *
 * PGlite is single-connection, so use `@fhirforge/pg` with a real Postgres in production.
 */
export function pgliteStorage(pg: PGliteLike, options?: PostgresStorageOptions): FhirStorage {
  return postgresStorage(pgliteDatabase(pg), options);
}

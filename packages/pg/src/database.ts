/** Anything that can run a parameterized query. */
export interface SqlClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A SqlClient that can also run a function inside a transaction. */
export interface Database extends SqlClient {
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

/** The parts of a `pg` Pool that fhirforge uses (no hard dependency on `pg`). */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PgPoolClientLike>;
}

export interface PgPoolClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(err?: Error | boolean): void;
}

export function isDatabase(value: unknown): value is Database {
  return typeof (value as Database)?.transaction === 'function' && typeof (value as Database)?.query === 'function';
}

/** Wraps a `pg` Pool. Transactions check out one client and run BEGIN/COMMIT on it. */
export function pgPoolDatabase(pool: PgPoolLike): Database {
  return {
    query: (sql, params) => pool.query(sql, params) as never,
    async transaction(fn) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => client.query(sql, params) as never });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {
          broken = true;
        });
        throw err;
      } finally {
        // If ROLLBACK failed the connection is in an unknown state: destroy it instead of reusing it.
        client.release(broken);
      }
    },
  };
}

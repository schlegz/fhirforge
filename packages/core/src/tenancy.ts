import { FhirError } from './errors.js';
import type { MigrationResult } from './types.js';

/** Tenant ids that are safe in a schema name (`t_${tenant}` stays under Postgres's 63-character limit). */
export const TENANT_ID = /^[a-z][a-z0-9_]{0,39}$/;

export interface TenantStores<S> {
  /**
   * The store for a tenant: created by your factory on first use, then cached. An id that
   * doesn't match the tenant pattern is a 400 (never echoed). This doesn't check that the
   * tenant exists: resolve tenants from your own auth, and migrate them before use.
   */
  get(tenant: string): S;
  /**
   * Runs `migrate()` for each tenant, one at a time (deploy time or tenant onboarding;
   * needs a role with DDL rights). Returns each tenant's result.
   */
  migrate(tenants: readonly string[]): Promise<Record<string, MigrationResult>>;
  /** Drops a tenant's cached store (e.g. after offboarding). */
  forget(tenant: string): void;
  /** How many tenant stores are cached. */
  readonly size: number;
}

export interface TenantStoresOptions {
  /** Allowed tenant ids. Default `TENANT_ID`: lowercase letter, then letters, digits or `_`, at most 40. */
  pattern?: RegExp;
  /** Most stores kept in memory; the least recently used one is dropped (and recreated when needed). Default 10,000. */
  maxCached?: number;
}

/**
 * One store per tenant, for schema-per-tenant (or database-per-tenant) isolation:
 *
 * ```ts
 * const tenants = tenantStores((tenant) =>
 *   createFhirStore({ storage: postgresStorage(pool, { schema: `t_${tenant}` }), fhir: r4, resources, authorize }),
 * );
 * await tenants.migrate(['acme', 'globex']); // deploy time
 * await tenants.get(session.tenantId).as(session).read('Patient', id);
 * ```
 *
 * The factory decides what isolates tenants (a schema, a database, keys): `tenantStores`
 * only validates ids, so they're safe to put in a schema name, and caches the stores.
 */
export function tenantStores<S extends { migrate(): Promise<MigrationResult> }>(
  create: (tenant: string) => S,
  options: TenantStoresOptions = {},
): TenantStores<S> {
  if (typeof create !== 'function') throw new Error('tenantStores: pass a function that creates the store for a tenant');
  const pattern = options.pattern ?? TENANT_ID;
  const max = options.maxCached ?? 10_000;
  if (!Number.isInteger(max) || max < 1) throw new Error('tenantStores: `maxCached` must be a positive integer');
  const cache = new Map<string, S>();

  const check = (tenant: unknown): string => {
    // The id never goes into the message: it can come from a request.
    if (typeof tenant !== 'string' || !pattern.test(tenant)) throw FhirError.invalid('Invalid tenant id');
    return tenant;
  };

  return {
    get(tenant) {
      const id = check(tenant);
      let store = cache.get(id);
      if (store) {
        cache.delete(id); // most recently used goes last
      } else {
        store = create(id);
      }
      cache.set(id, store);
      while (cache.size > max) cache.delete(cache.keys().next().value!);
      return store;
    },
    async migrate(tenants) {
      const out: Record<string, MigrationResult> = {};
      for (const tenant of tenants) out[check(tenant)] = await this.get(tenant).migrate();
      return out;
    },
    forget(tenant) {
      cache.delete(check(tenant));
    },
    get size() {
      return cache.size;
    },
  };
}

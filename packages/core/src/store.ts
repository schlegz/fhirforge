import { FhirError } from './errors.js';
import { extractIndexRows, type SearchPolicy } from './search/index-rows.js';
import { parseSearch, type SearchParams } from './search/query.js';
import type { FhirStorage, Indexer, StoredVersion } from './storage.js';
import type {
  AnyResource,
  FhirVersionPackage,
  HistoryEntry,
  MigrationResult,
  ResourceMapOf,
  SearchResult,
  Stored,
} from './types.js';

export interface CreateFhirStoreOptions<V extends FhirVersionPackage<unknown>, K extends string> {
  /** Where resources live, e.g. `pgliteStorage(new PGlite())` or `postgresStorage(pool)`. */
  storage: FhirStorage;
  /** The FHIR version package, e.g. `r4` from `@fhirforge/r4`. */
  fhir: V;
  /** The resource types this store manages. Only these get tables and can be written. */
  resources: readonly K[];
  search?: {
    /**
     * How each search parameter is indexed, keyed `ResourceType.code`
     * (e.g. `'Patient.birthdate'`). Default `plaintext` (full search).
     * `none`: not indexed and not searchable. `blind` (HMAC, exact match only)
     * is planned and rejected for now.
     */
    policy?: Readonly<Partial<Record<`${K}.${string}`, SearchPolicy>>>;
  };
}

/** A resource of type RT from map M, with its `resourceType` pinned so TS can infer RT. */
type ResourceOf<M, RT extends keyof M> = M[RT] & { resourceType: RT };

export interface FhirStore<M> {
  readonly fhirVersion: string;
  readonly resourceTypes: readonly (keyof M & string)[];

  /** Creates or upgrades storage for the configured resource types. Safe to run on every startup. */
  migrate(): Promise<MigrationResult>;

  /** Creates a resource with a server-assigned id. Any id or version in the input is ignored. */
  create<RT extends keyof M & string>(resource: ResourceOf<M, RT>): Promise<Stored<M[RT]>>;

  /** The current version. Throws 404 if it never existed and 410 if it was deleted. */
  read<RT extends keyof M & string>(resourceType: RT, id: string): Promise<Stored<M[RT]>>;

  /** A specific version. Throws 404 if there is no such version, 410 if that version is a delete. */
  vread<RT extends keyof M & string>(resourceType: RT, id: string, versionId: string): Promise<Stored<M[RT]>>;

  /**
   * Writes a new version (or creates the resource with this id if it doesn't
   * exist). Pass `ifMatch` with the version you read to fail with 412 if
   * someone else updated it in the meantime.
   */
  update<RT extends keyof M & string>(
    resource: ResourceOf<M, RT> & { id: string },
    options?: { ifMatch?: string },
  ): Promise<Stored<M[RT]>>;

  /** Deletes a resource, keeping its history. Deleting something absent or already deleted is a no-op. */
  delete<RT extends keyof M & string>(resourceType: RT, id: string): Promise<void>;

  /** Every version of a resource, newest first. Throws 404 if it never existed. */
  history<RT extends keyof M & string>(resourceType: RT, id: string): Promise<HistoryEntry<M[RT]>[]>;

  /**
   * FHIR search over current resources, e.g.
   * `search('Patient', { family: 'doe', birthdate: 'ge1970', _sort: '-birthdate', _count: 10 })`.
   * Repeated parameters (arrays) are ANDed; comma-separated values are ORed.
   * Unknown parameters and malformed values throw 400.
   */
  search<RT extends keyof M & string>(resourceType: RT, params?: SearchParams): Promise<SearchResult<Stored<M[RT]>>>;

  /** Rebuilds search indexes (all configured types, or one). Run after changing the search policy. */
  reindex<RT extends keyof M & string>(resourceType?: RT): Promise<Record<string, number>>;
}

// Web Crypto is global in Node 19+, Deno, Bun and browsers. Declared here so
// core needs neither the DOM lib nor @types/node.
declare const crypto: { randomUUID(): string };

/** Accepts a bare version (`3`) or an HTTP ETag (`W/"3"`), as FHIR's If-Match header sends it. */
function normalizeVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/** FHIR id: 1–64 characters of letters, digits, `-` and `.`. */
const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * Creates a FHIR store. The resource types come from the version package, so
 * `store.read('Patient', id)` is typed as that version's Patient.
 *
 * ```ts
 * import { r4 } from '@fhirforge/r4';
 * const fhir = createFhirStore({ storage, fhir: r4, resources: ['Patient', 'Observation'] });
 * ```
 */
export function createFhirStore<
  V extends FhirVersionPackage<unknown>,
  const K extends keyof ResourceMapOf<V> & string,
>(options: CreateFhirStoreOptions<V, K>): FhirStore<Pick<ResourceMapOf<V>, K>> {
  const { storage, fhir } = options;
  const resourceTypes = [...new Set(options.resources)];
  if (resourceTypes.length === 0) throw new Error('createFhirStore: `resources` must list at least one resource type');
  const allowed = new Set<string>(resourceTypes);

  const checkType = (resourceType: unknown): string => {
    if (typeof resourceType !== 'string' || !allowed.has(resourceType)) {
      throw FhirError.notSupported(
        `Resource type ${typeof resourceType === 'string' && /^[A-Z][A-Za-z]{0,63}$/.test(resourceType) ? resourceType : '(invalid)'} is not managed by this store (configured: ${resourceTypes.join(', ')})`,
      );
    }
    return resourceType;
  };
  const checkId = (id: unknown): string => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw FhirError.invalid('Invalid resource id');
    }
    return id;
  };
  const table = fhir.searchParameters;
  const policies = new Map<string, SearchPolicy>(Object.entries(options.search?.policy ?? {}) as [string, SearchPolicy][]);
  for (const [key, value] of policies) {
    const [type, code] = key.split('.');
    if (!type || !code || !allowed.has(type) || !table?.[type]?.some((p) => p.code === code)) {
      throw new Error(`createFhirStore: search policy for unknown parameter ${key}`);
    }
    if (value === 'blind') throw new Error(`createFhirStore: blind indexing (${key}) is not implemented yet`);
    if (value !== 'plaintext' && value !== 'none') throw new Error(`createFhirStore: invalid search policy ${String(value)} for ${key}`);
  }
  const policy = (resourceType: string, code: string): SearchPolicy => policies.get(`${resourceType}.${code}`) ?? 'plaintext';
  const index: Indexer | undefined = table ? (resource) => extractIndexRows(resource, table, policy) : undefined;
  const writeOptions = index ? { index } : {};

  const reindex = async (types: readonly string[]): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    if (!index) return out;
    for (const t of types) out[t] = await storage.reindex(t, index);
    return out;
  };

  const current = (resourceType: string, id: string, v: StoredVersion | undefined) => {
    if (!v) throw FhirError.notFound(resourceType, id);
    if (v.deleted || !v.resource) throw FhirError.gone(resourceType, id);
    return v.resource;
  };

  const store: FhirStore<Record<string, AnyResource>> = {
    fhirVersion: fhir.fhirVersion,
    resourceTypes,

    async migrate() {
      const { applied, reindex: needsReindex } = await storage.migrate(resourceTypes);
      if (!needsReindex?.length) return { applied };
      return { applied, reindexed: await reindex(needsReindex) };
    },

    async create(resource) {
      checkType(resource?.resourceType);
      const { id: _ignored, ...rest } = resource;
      const version = await storage.create({ ...rest, id: crypto.randomUUID() }, writeOptions);
      return version.resource as never;
    },

    async read(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      return current(resourceType, id, await storage.read(resourceType, id)) as never;
    },

    async vread(resourceType, id, versionId) {
      checkType(resourceType);
      checkId(id);
      const v = await storage.vread(resourceType, id, versionId);
      if (!v) throw FhirError.notFound(resourceType, id, versionId);
      if (v.deleted || !v.resource) throw FhirError.gone(resourceType, id);
      return v.resource as never;
    },

    async update(resource, updateOptions) {
      checkType(resource?.resourceType);
      checkId(resource.id);
      const ifMatch = normalizeVersion(updateOptions?.ifMatch);
      const { version } = await storage.update(
        resource as AnyResource & { id: string },
        ifMatch === undefined ? writeOptions : { ...writeOptions, ifMatch },
      );
      return version.resource as never;
    },

    async delete(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      await storage.delete(resourceType, id);
    },

    async history(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      const versions = await storage.history(resourceType, id);
      if (versions.length === 0) throw FhirError.notFound(resourceType, id);
      return versions.map((v) => ({
        versionId: v.versionId,
        lastUpdated: v.lastUpdated,
        deleted: v.deleted,
        ...(v.resource ? { resource: v.resource as never } : {}),
      }));
    },

    async search(resourceType, params = {}) {
      checkType(resourceType);
      if (!table) throw FhirError.notSupported(`FHIR ${fhir.fhirVersion} package has no compiled search parameters`);
      const query = parseSearch(resourceType, params, table, policy);
      const { versions, total } = await storage.search(query);
      const resources = versions.map((v) => v.resource as never);
      const nextOffset = query.offset + query.count;
      return {
        resources,
        total,
        ...(nextOffset < total ? { next: { ...params, _offset: nextOffset } } : {}),
      };
    },

    async reindex(resourceType) {
      if (resourceType !== undefined) checkType(resourceType);
      return reindex(resourceType ? [resourceType] : resourceTypes);
    },
  };

  return store as unknown as FhirStore<Pick<ResourceMapOf<V>, K>>;
}

import type { AccessOptions, StoreAuditEvent, AuditOutcome, AuthorizeRequest, StoreAction } from './access.js';
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

export interface CreateFhirStoreOptions<V extends FhirVersionPackage<unknown>, K extends string, Ctx>
  extends AccessOptions<Ctx> {
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

/** The data operations, available on a scope (`as(ctx)`, `asSystem(reason)`) and, with `authorize: 'allow-all'`, on the store itself. */
export interface FhirDataOperations<M> {
  /** Creates a resource with a server-assigned id. Any id or version in the input is ignored. */
  create<RT extends keyof M & string>(resource: ResourceOf<M, RT>): Promise<Stored<M[RT]>>;

  /** The current version. Throws 404 if it never existed or the caller may not see it, 410 if it was deleted. */
  read<RT extends keyof M & string>(resourceType: RT, id: string): Promise<Stored<M[RT]>>;

  /** A specific version. Throws 404 if there is no such version (or it isn't visible), 410 if that version is a delete. */
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

  /** Every version of a resource, newest first. Throws 404 if it never existed or isn't visible. */
  history<RT extends keyof M & string>(resourceType: RT, id: string): Promise<HistoryEntry<M[RT]>[]>;

  /**
   * FHIR search over current resources, e.g.
   * `search('Patient', { family: 'doe', birthdate: 'ge1970', _sort: '-birthdate', _count: 10 })`.
   * Repeated parameters (arrays) are ANDed; comma-separated values are ORed.
   * Unknown parameters and malformed values throw 400.
   */
  search<RT extends keyof M & string>(resourceType: RT, params?: SearchParams): Promise<SearchResult<Stored<M[RT]>>>;
}

export interface FhirStore<M, Ctx = unknown> extends FhirDataOperations<M> {
  readonly fhirVersion: string;
  readonly resourceTypes: readonly (keyof M & string)[];

  /** Data operations on behalf of a caller: every call is checked by `authorize` and audited with `ctx`. */
  as(ctx: Ctx): FhirDataOperations<M>;

  /**
   * Data operations that bypass `authorize`, for trusted jobs (imports,
   * migrations of data, background processing). Still audited, with the reason.
   */
  asSystem(reason: string): FhirDataOperations<M>;

  /** Creates or upgrades storage for the configured resource types. Safe to run on every startup. */
  migrate(): Promise<MigrationResult>;

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

/** Parameters a search policy filter may not set: they control paging, not which resources match. */
const RESULT_PARAMS = new Set(['_count', '_offset', '_sort']);

interface Scope<Ctx> {
  kind: 'caller' | 'system' | 'unscoped';
  ctx?: Ctx;
  reason?: string;
}

/**
 * Creates a FHIR store. The resource types come from the version package, so
 * `store.read('Patient', id)` is typed as that version's Patient.
 *
 * ```ts
 * import { r4 } from '@fhirforge/r4';
 * const fhir = createFhirStore({
 *   storage, fhir: r4, resources: ['Patient', 'Observation'],
 *   authorize: ({ ctx, action, resource }) => canAccess(ctx, action, resource),
 *   onAudit: (event) => auditLog.write(event),
 * });
 * const patient = await fhir.as(session).read('Patient', id);
 * ```
 */
export function createFhirStore<
  V extends FhirVersionPackage<unknown>,
  const K extends keyof ResourceMapOf<V> & string,
  Ctx = unknown,
>(options: CreateFhirStoreOptions<V, K, Ctx>): FhirStore<Pick<ResourceMapOf<V>, K>, Ctx> {
  const { storage, fhir, authorize, onAudit, onAuditError } = options;
  if (authorize !== 'allow-all' && typeof authorize !== 'function') {
    throw new Error("createFhirStore: `authorize` is required: pass a policy function, or 'allow-all' to run without access control");
  }
  const resourceTypes = [...new Set(options.resources)];
  if (resourceTypes.length === 0) throw new Error('createFhirStore: `resources` must list at least one resource type');
  const allowed = new Set<string>(resourceTypes);

  const checkType = (resourceType: unknown): string => {
    if (typeof resourceType !== 'string' || !allowed.has(resourceType)) {
      const shown = typeof resourceType === 'string' && /^[A-Z][A-Za-z]{0,63}$/.test(resourceType) ? resourceType : '(invalid)';
      throw FhirError.notSupported(`Resource type ${shown} is not managed by this store (configured: ${resourceTypes.join(', ')})`);
    }
    return resourceType;
  };
  const checkId = (id: unknown): string => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw FhirError.invalid('Invalid resource id');
    return id;
  };

  // ---- search policy and indexing ----
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

  // ---- authorization ----
  /** Returns the policy decision for a caller; system scope is always allowed. */
  const decide = async (scope: Scope<Ctx>, request: Omit<AuthorizeRequest<Ctx>, 'ctx'>) => {
    if (scope.kind === 'system' || authorize === 'allow-all') return { allowed: true as const };
    if (scope.kind === 'unscoped') {
      throw FhirError.forbidden('No caller context: use store.as(ctx) or store.asSystem(reason)');
    }
    let result: unknown;
    try {
      result = await authorize({ ...request, ctx: scope.ctx as Ctx });
    } catch {
      result = false; // a policy that throws denies
    }
    if (result === true) return { allowed: true as const };
    if (request.action === 'search' && result && typeof result === 'object' && 'filter' in result) {
      return { allowed: true as const, filter: (result as { filter: SearchParams }).filter };
    }
    return { allowed: false as const };
  };
  const can = async (scope: Scope<Ctx>, request: Omit<AuthorizeRequest<Ctx>, 'ctx'>) => (await decide(scope, request)).allowed;

  // ---- audit ----
  const audit = async (scope: Scope<Ctx>, event: Omit<StoreAuditEvent<Ctx>, 'recorded' | 'ctx' | 'system' | 'reason'>) => {
    if (!onAudit) return;
    const full: StoreAuditEvent<Ctx> = {
      recorded: new Date().toISOString(),
      ctx: scope.kind === 'caller' ? scope.ctx : undefined,
      system: scope.kind === 'system',
      ...(scope.reason ? { reason: scope.reason } : {}),
      ...event,
    };
    try {
      await onAudit(full);
    } catch (err) {
      if (onAuditError) onAuditError(err, full);
      else throw new Error('fhirforge: audit failed; the operation result was withheld', { cause: err });
    }
  };

  const outcomeOf = (err: unknown): { outcome: AuditOutcome; status?: number } => {
    if (err instanceof FhirError) {
      if (err.status === 403) return { outcome: 'denied', status: 403 };
      if (err.status === 404 || err.status === 410) return { outcome: 'not-found', status: err.status };
      return { outcome: 'error', status: err.status };
    }
    return { outcome: 'error', status: 500 };
  };

  /** Runs an operation and audits it, success or failure. Audit failures on success withhold the result. */
  const audited = async <T>(
    scope: Scope<Ctx>,
    base: { action: StoreAction; resourceType: string; id?: string; versionId?: string; params?: string[] },
    run: () => Promise<{ result: T; id?: string; versionId?: string; ids?: string[] }>,
  ): Promise<T> => {
    let done: Awaited<ReturnType<typeof run>>;
    try {
      done = await run();
    } catch (err) {
      await audit(scope, { ...base, ...outcomeOf(err) });
      throw err;
    }
    await audit(scope, {
      ...base,
      outcome: 'success',
      ...(done.id ? { id: done.id } : {}),
      ...(done.versionId ? { versionId: done.versionId } : {}),
      ...(done.ids ? { ids: done.ids } : {}),
    });
    return done.result;
  };

  // A denied read looks exactly like a missing resource, so callers can't probe for existence.
  const hidden = (resourceType: string, id: string, versionId?: string) => FhirError.notFound(resourceType, id, versionId);
  const forbidden = (action: StoreAction, resourceType: string) =>
    FhirError.forbidden(`Not allowed to ${action} ${resourceType}`);

  const currentOf = (resourceType: string, id: string, v: StoredVersion | undefined) => {
    if (!v) throw FhirError.notFound(resourceType, id);
    if (v.deleted || !v.resource) throw FhirError.gone(resourceType, id);
    return v.resource;
  };

  // ---- data operations, per scope ----
  const operations = (scope: Scope<Ctx>): FhirDataOperations<Record<string, AnyResource>> => ({
    async create(resource) {
      const resourceType = checkType(resource?.resourceType);
      return audited(scope, { action: 'create', resourceType }, async () => {
        const { id: _ignored, ...rest } = resource;
        if (!(await can(scope, { action: 'create', resourceType, resource: rest as AnyResource }))) {
          throw forbidden('create', resourceType);
        }
        const version = await storage.create({ ...rest, id: crypto.randomUUID() }, writeOptions);
        return { result: version.resource as never, id: version.resource!.id, versionId: version.versionId };
      });
    },

    async read(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      return audited(scope, { action: 'read', resourceType, id }, async () => {
        const resource = currentOf(resourceType, id, await storage.read(resourceType, id));
        if (!(await can(scope, { action: 'read', resourceType, id, resource }))) throw hidden(resourceType, id);
        return { result: resource as never, versionId: resource.meta?.versionId };
      });
    },

    async vread(resourceType, id, versionId) {
      checkType(resourceType);
      checkId(id);
      return audited(scope, { action: 'vread', resourceType, id, versionId }, async () => {
        const v = await storage.vread(resourceType, id, versionId);
        if (!v) throw FhirError.notFound(resourceType, id, versionId);
        if (v.deleted || !v.resource) throw FhirError.gone(resourceType, id);
        if (!(await can(scope, { action: 'vread', resourceType, id, resource: v.resource }))) {
          throw hidden(resourceType, id, versionId);
        }
        return { result: v.resource as never };
      });
    },

    async update(resource, updateOptions) {
      const resourceType = checkType(resource?.resourceType);
      const id = checkId(resource.id);
      return audited(scope, { action: 'update', resourceType, id }, async () => {
        const requested = normalizeVersion(updateOptions?.ifMatch);
        // The policy sees both the stored version (may this caller change it?) and the new content.
        const existing = await storage.read(resourceType, id);
        const stored = existing && !existing.deleted ? existing.resource ?? undefined : undefined;
        if (stored && !(await can(scope, { action: 'update', resourceType, id, resource: stored }))) {
          throw hidden(resourceType, id);
        }
        if (!(await can(scope, { action: 'update', resourceType, id, resource: resource as AnyResource }))) {
          throw forbidden('update', resourceType);
        }
        // Write against exactly the version the policy approved: if it changed in between, 412.
        const guard =
          requested !== undefined ? { ifMatch: requested } : existing ? { ifMatch: existing.versionId } : { ifNoneExist: true };
        const { version } = await storage.update(resource as AnyResource & { id: string }, { ...writeOptions, ...guard });
        return { result: version.resource as never, versionId: version.versionId };
      });
    },

    async delete(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      return audited(scope, { action: 'delete', resourceType, id }, async () => {
        const existing = await storage.read(resourceType, id);
        if (!existing || existing.deleted || !existing.resource) return { result: undefined }; // nothing to delete
        if (!(await can(scope, { action: 'delete', resourceType, id, resource: existing.resource }))) {
          throw hidden(resourceType, id);
        }
        const version = await storage.delete(resourceType, id, { ifMatch: existing.versionId });
        return { result: undefined, ...(version ? { versionId: version.versionId } : {}) };
      });
    },

    async history(resourceType, id) {
      checkType(resourceType);
      checkId(id);
      return audited(scope, { action: 'history', resourceType, id }, async () => {
        const versions = await storage.history(resourceType, id);
        if (versions.length === 0) throw FhirError.notFound(resourceType, id);
        // The policy decides on the latest content (a deleted resource is judged by its last version).
        const latest = versions.find((v) => v.resource)?.resource ?? undefined;
        if (!(await can(scope, { action: 'history', resourceType, id, ...(latest ? { resource: latest } : {}) }))) {
          throw hidden(resourceType, id);
        }
        const result = versions.map((v) => ({
          versionId: v.versionId,
          lastUpdated: v.lastUpdated,
          deleted: v.deleted,
          ...(v.resource ? { resource: v.resource as never } : {}),
        }));
        return { result };
      });
    },

    async search(resourceType, params = {}) {
      checkType(resourceType);
      const paramNames = Object.keys(params).filter((k) => params[k] !== undefined);
      return audited(scope, { action: 'search', resourceType, params: paramNames }, async () => {
        if (!table) throw FhirError.notSupported(`FHIR ${fhir.fhirVersion} package has no compiled search parameters`);
        const decision = await decide(scope, { action: 'search', resourceType, params });
        if (!decision.allowed) throw forbidden('search', resourceType);

        const query = parseSearch(resourceType, mergeFilter(params, decision.filter), table, policy);
        const { versions, total } = await storage.search(query);

        // Defense in depth: every result must also pass a read check. If any is removed, the
        // total no longer describes what this caller can see, so it is omitted.
        const resources: AnyResource[] = [];
        for (const v of versions) {
          if (v.resource && (await can(scope, { action: 'read', resourceType, id: v.resource.id, resource: v.resource }))) {
            resources.push(v.resource);
          }
        }
        const filtered = resources.length !== versions.length;
        const nextOffset = query.offset + query.count;
        const result: SearchResult<never> = {
          resources: resources as never[],
          ...(filtered ? {} : { total }),
          ...(nextOffset < total ? { next: { ...params, _offset: nextOffset } } : {}),
        };
        return { result, ids: resources.map((r) => r.id!) };
      });
    },
  });

  const unscoped = operations({ kind: 'unscoped' });
  const store: FhirStore<Record<string, AnyResource>, Ctx> = {
    fhirVersion: fhir.fhirVersion,
    resourceTypes,
    ...unscoped,
    as: (ctx) => operations({ kind: 'caller', ctx }),
    asSystem: (reason) => {
      if (typeof reason !== 'string' || reason.trim() === '') throw new Error('asSystem(reason): a reason is required');
      return operations({ kind: 'system', reason });
    },
    async migrate() {
      const { applied, reindex: needsReindex } = await storage.migrate(resourceTypes);
      if (!needsReindex?.length) return { applied };
      return { applied, reindexed: await reindex(needsReindex) };
    },
    async reindex(resourceType) {
      if (resourceType !== undefined) checkType(resourceType);
      return reindex(resourceType ? [resourceType] : resourceTypes);
    },
  };
  return store as unknown as FhirStore<Pick<ResourceMapOf<V>, K>, Ctx>;
}

/** ANDs a policy's search filter into the caller's parameters. */
function mergeFilter(params: SearchParams, filter: SearchParams | undefined): SearchParams {
  if (!filter) return params;
  const merged: Record<string, SearchParams[string]> = { ...params };
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (RESULT_PARAMS.has(key)) throw new Error(`authorize: a search filter can't set ${key}`);
    const mine = merged[key];
    merged[key] =
      mine === undefined
        ? value
        : [...(Array.isArray(mine) ? mine : [mine]), ...(Array.isArray(value) ? value : [value])].map(String);
  }
  return merged;
}

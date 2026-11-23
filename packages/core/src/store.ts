import type { AccessOptions, StoreAuditEvent, AuditOutcome, AuthorizeRequest, StoreAction } from './access.js';
import { FhirError } from './errors.js';
import { extractIndexRows, indexParameter, type SearchPolicy } from './search/index-rows.js';
import { isChainKey, isIncludeKey, MAX_CHAIN_MATCHES, MAX_INCLUDED, splitLinks } from './search/links.js';
import { BLIND_TYPES, blindIndexer } from './search/blind.js';
import { parseSearch, type SearchParams, type SearchQuery } from './search/query.js';
import type { SearchParamType } from './search/types.js';
import {
  atEntry,
  errorResponse,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_SEARCHES,
  parseEntryRequest,
  parseQuery,
  referencesAny,
  resolveReferences,
  statusLine,
  writeResponse,
  type BundleInput,
  type BundleResponse,
  type BundleResponseEntry,
  type EntryRequest,
} from './bundle.js';
import type {
  AuditRow,
  FhirStorage,
  Indexer,
  PendingAuditRow,
  PlannedWrite,
  StoredVersion,
  UpdateResult,
  WriteCondition,
} from './storage.js';
import { createValidator } from './validation/validate.js';
import { encryptedStorage, type EncryptionOptions } from './encryption.js';
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
  /**
   * Enables `expunge` (permanent removal). Off by default: without it, `expunge` fails with 400.
   * `storage` is an optional second storage on the same schema whose database role has
   * `DELETE` on resource and history tables, used only for expunge, so the everyday runtime
   * role never needs `DELETE` on resource data. Without it, the main storage is used.
   */
  expunge?: { storage?: FhirStorage };
  /**
   * Encryption at rest for resource bodies (current and history): envelope encryption with
   * data keys wrapped by your KMS (`keys`), AES-256-GCM. Search index rows are not encrypted:
   * give sensitive parameters the `none` (or, later, `blind`) search policy. Existing plaintext
   * rows stay readable; `reencrypt()` encrypts them.
   */
  encryption?: EncryptionOptions;
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

  /**
   * Deletes a resource, keeping its history. Deleting something absent or already deleted is a no-op.
   * Pass `ifMatch` to fail with 412 unless the current version is the one you read.
   */
  delete<RT extends keyof M & string>(resourceType: RT, id: string, options?: { ifMatch?: string }): Promise<void>;

  /**
   * Creates the resource unless one matching `condition` exists (FHIR `If-None-Exist`).
   * No match: creates it (`created: true`). One match: returns it, writes nothing. More: 412.
   * The condition is search parameters (or a query string), searched as the caller (through
   * the policy). Concurrent conditional writes with the same condition are serialized: a
   * write whose condition changed after it was checked fails with 412.
   */
  conditionalCreate<RT extends keyof M & string>(
    resource: ResourceOf<M, RT>,
    condition: SearchParams | string,
  ): Promise<{ resource: Stored<M[RT]>; created: boolean }>;

  /**
   * Updates the one resource matching `condition`, or creates it if none matches (FHIR
   * `PUT Type?…`). More than one match: 412. The body's `id`, if any, must be the match's
   * (or, with no match, a new id; an existing resource that doesn't match is a 412).
   */
  conditionalUpdate<RT extends keyof M & string>(
    resourceType: RT,
    condition: SearchParams | string,
    resource: ResourceOf<M, RT>,
    options?: { ifMatch?: string },
  ): Promise<{ resource: Stored<M[RT]>; created: boolean }>;

  /** Deletes the one resource matching `condition` (FHIR `DELETE Type?…`). No match: nothing to do. More: 412. */
  conditionalDelete<RT extends keyof M & string>(resourceType: RT, condition: SearchParams | string): Promise<{ deleted: boolean }>;

  /**
   * Permanently removes a resource: every version and every search index row, in one
   * transaction. Works on deleted resources too. Audit rows are kept (they hold ids, not
   * content). It's a separate, explicit operation: `delete` never expunges. The policy
   * decides with action `expunge` on the latest content; denied or missing is 404. Pass
   * `ifMatch` to fail with 412 unless the current version is the one you checked.
   * A `reason` is required and recorded in the audit event; keep PHI out of it.
   * Only available when the store was created with the `expunge` option.
   */
  expunge<RT extends keyof M & string>(resourceType: RT, id: string, options: { reason: string; ifMatch?: string }): Promise<void>;

  /** Every version of a resource, newest first. Throws 404 if it never existed or isn't visible. */
  history<RT extends keyof M & string>(resourceType: RT, id: string): Promise<HistoryEntry<M[RT]>[]>;

  /**
   * FHIR search over current resources, e.g.
   * `search('Patient', { family: 'doe', birthdate: 'ge1970', _sort: '-birthdate', _count: 10 })`.
   * Repeated parameters (arrays) are ANDed; comma-separated values are ORed.
   * Unknown parameters and malformed values throw 400.
   */
  search<RT extends keyof M & string>(
    resourceType: RT,
    params?: SearchParams,
  ): Promise<SearchResult<Stored<M[RT]>, Stored<M[keyof M & string]>>>;

  /**
   * Runs a `transaction` Bundle: every write commits together or none does.
   * Entries get the same validation, `authorize` checks, version guards and
   * audit as single operations; `urn:uuid:` references between entries are
   * resolved to the new ids. GET entries run after the commit. Throws the
   * first failure (with its entry index); returns a `transaction-response`.
   */
  transaction(bundle: BundleInput): Promise<BundleResponse>;

  /**
   * Runs a `batch` Bundle: each entry is an independent single operation, and
   * a failing entry gets its error in its own `response` without affecting the
   * others. Returns a `batch-response`.
   */
  batch(bundle: BundleInput): Promise<BundleResponse>;
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

  /**
   * The search parameters a resource type supports in this store: compiled ones,
   * minus those with search policy `none`. For capability statements (`/metadata`).
   */
  searchParameters<RT extends keyof M & string>(
    resourceType: RT,
  ): readonly { code: string; type: SearchParamType; /** Reference parameters: the types they may point to (omitted = any). */ targets?: readonly string[] }[];

  /** Creates or upgrades storage for the configured resource types. Safe to run on every startup. */
  migrate(): Promise<MigrationResult>;

  /**
   * Re-encrypts stored bodies (current and history): plaintext ones, and with `olderThan`
   * those under data keys created before it (key rotation). One resource per transaction.
   * Needs the `encryption` option. Returns how many resources were rewritten, per type.
   */
  reencrypt<RT extends keyof M & string>(options?: { resourceType?: RT; olderThan?: Date }): Promise<Record<string, number>>;

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

/** Most parameter values in a conditional operation's condition. */
const MAX_CONDITION_PARAMS = 10;

/** Longest `expunge` reason kept in audit events. */
const MAX_REASON_LENGTH = 1000;

/** FHIR id: 1–64 characters of letters, digits, `-` and `.`. */
const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

/** Parameters a search policy filter may not set: they control paging, not which resources match. */
const RESULT_PARAMS = new Set(['_count', '_offset', '_sort']);

interface Scope<Ctx> {
  kind: 'caller' | 'system' | 'unscoped';
  ctx?: Ctx;
  reason?: string;
  /** Set for the entries of a Bundle, so their audit events share the Bundle's operation id. */
  operationId?: string;
}

/** An audit event before the scope's fields (who, when, operation) are added. */
type EventBody<Ctx> = Omit<StoreAuditEvent<Ctx>, 'recorded' | 'ctx' | 'system' | 'reason' | 'operationId'>;

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
  const { fhir, authorize, onAudit, onAuditError } = options;
  // Encryption at rest wraps the storage: bodies are sealed on write and opened on read.
  const storage = options.encryption ? encryptedStorage(options.storage, options.encryption) : options.storage;
  const expungeStorage =
    options.expunge?.storage && options.encryption ? encryptedStorage(options.expunge.storage, options.encryption) : options.expunge?.storage;
  if (options.expunge !== undefined) {
    const extra = options.expunge.storage;
    if (extra !== undefined && typeof extra?.expunge !== 'function') {
      throw new Error('createFhirStore: `expunge.storage` must be a storage adapter (e.g. postgresStorage(adminPool, { schema }))');
    }
  }
  const auditTable = options.audit !== undefined;
  if (auditTable) {
    if (options.audit!.table !== true) throw new Error('createFhirStore: `audit.table` must be true (omit `audit` to run without the table)');
    if (typeof options.audit!.actor !== 'function') {
      throw new Error('createFhirStore: `audit.actor` is required with the audit table (map ctx to a stable, non-secret id)');
    }
  }
  if (authorize !== 'allow-all' && typeof authorize !== 'function') {
    throw new Error("createFhirStore: `authorize` is required: pass a policy function, or 'allow-all' to run without access control");
  }
  const resourceTypes = [...new Set(options.resources)];
  if (resourceTypes.length === 0) throw new Error('createFhirStore: `resources` must list at least one resource type');
  const allowed = new Set<string>(resourceTypes);
  if (!fhir.validation) {
    throw new Error(`createFhirStore: the FHIR ${fhir.fhirVersion} package has no validation rules; the store validates every write`);
  }
  for (const t of resourceTypes) {
    if (!fhir.validation.resources.includes(t)) throw new Error(`createFhirStore: ${String(t)} is not a resource type in FHIR ${fhir.fhirVersion}`);
  }
  const validator = createValidator(fhir.validation);
  /** Rejects a resource that doesn't conform to the base spec (400, one issue per problem, paths only). */
  const validate = (resourceType: string, resource: unknown) => {
    const issues = validator(resource);
    if (issues.length) throw FhirError.validation(resourceType, issues);
  };

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
    if (value === 'blind') {
      if (!options.encryption?.blindIndexKey) throw new Error(`createFhirStore: ${key} is blind, which needs \`encryption.blindIndexKey\``);
      const def = table?.[type]?.find((p) => p.code === code);
      if (!def || !BLIND_TYPES.has(def.type)) throw new Error(`createFhirStore: ${key} can't be blind (only string, token and date parameters)`);
    } else if (value !== 'plaintext' && value !== 'none') {
      throw new Error(`createFhirStore: invalid search policy ${String(value)} for ${key}`);
    }
  }
  const policy = (resourceType: string, code: string): SearchPolicy => policies.get(`${resourceType}.${code}`) ?? 'plaintext';
  const blind = options.encryption?.blindIndexKey && [...policies.values()].includes('blind') ? blindIndexer(options.encryption.blindIndexKey, policy) : undefined;
  const index: Indexer | undefined = table
    ? blind
      ? (resource) => blind.rows(resource.resourceType, extractIndexRows(resource, table, policy))
      : (resource) => extractIndexRows(resource, table, policy)
    : undefined;
  /** Blind parameters are searched by keyed hash; everything else passes through. */
  const prepare = (query: SearchQuery) => (blind ? blind.query(query) : Promise.resolve(query));
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
    const full = { ...request, ctx: scope.ctx as Ctx };
    try {
      result = await authorize(full);
    } catch (err) {
      result = false; // a policy that throws denies
      try {
        options.onPolicyError?.(err, full);
      } catch {
        // The denial stands whatever the hook does.
      }
    }
    if (result === true) return { allowed: true as const };
    if (request.action === 'search' && result && typeof result === 'object' && 'filter' in result) {
      return { allowed: true as const, filter: (result as { filter: SearchParams }).filter };
    }
    return { allowed: false as const };
  };
  const can = async (scope: Scope<Ctx>, request: Omit<AuthorizeRequest<Ctx>, 'ctx'>) => (await decide(scope, request)).allowed;

  // ---- audit ----

  /** The audit table row for an event. Calls the app's `audit.actor` for caller scopes. */
  const rowFor = (scope: Scope<Ctx>, event: EventBody<Ctx>, operationId: string): AuditRow => {
    let actor: string | undefined;
    if (scope.kind === 'caller') {
      actor = options.audit!.actor(scope.ctx as Ctx);
      if (typeof actor !== 'string' || actor === '') throw new Error('fhirforge: audit.actor must return a non-empty string');
    }
    return {
      operationId,
      ...(actor !== undefined ? { actor } : {}),
      system: scope.kind === 'system',
      ...(scope.reason ? { reason: scope.reason } : {}),
      ...event,
    };
  };

  /** Rows to write together with a write (in its transaction), or undefined without the audit table. */
  const pendingRows = (scope: Scope<Ctx>, operationId: string, events: readonly (EventBody<Ctx> & { write?: number })[]) =>
    auditTable ? events.map(({ write, ...event }) => ({ ...rowFor(scope, event, operationId), ...(write !== undefined ? { write } : {}) })) : undefined;

  /**
   * Records one event: in the audit table (unless it was already written with the data,
   * `persisted`) and through `onAudit`. Table failures always propagate.
   */
  const audit = async (scope: Scope<Ctx>, event: EventBody<Ctx>, opts: { operationId?: string; persisted?: boolean } = {}) => {
    const operationId = opts.operationId ?? scope.operationId ?? crypto.randomUUID();
    if (auditTable && !opts.persisted) await storage.recordAudit([rowFor(scope, event, operationId)]);
    if (!onAudit) return;
    const full: StoreAuditEvent<Ctx> = {
      recorded: new Date().toISOString(),
      ctx: scope.kind === 'caller' ? scope.ctx : undefined,
      system: scope.kind === 'system',
      ...(scope.reason ? { reason: scope.reason } : {}),
      ...event,
      operationId,
    };
    try {
      await onAudit(full);
    } catch (err) {
      if (onAuditError) onAuditError(err, full);
      else throw new Error('fhirforge: audit failed; the operation result was withheld', { cause: err });
    }
  };

  /** Audits a failed operation. If auditing fails too, both errors are reported. */
  const auditFailure = async (scope: Scope<Ctx>, event: EventBody<Ctx>, err: unknown, operationId?: string) => {
    try {
      await audit(scope, event, operationId ? { operationId } : {});
    } catch (auditErr) {
      throw new AggregateError([auditErr, err], 'fhirforge: audit failed; the operation had also failed');
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

  /**
   * Runs an operation and audits it, success or failure. Audit failures on success withhold
   * the result. A write passes `withRows(event)` into its storage call, so its success row is
   * written in the same transaction, and returns `persisted: true`.
   */
  const audited = async <T>(
    scope: Scope<Ctx>,
    base: { action: StoreAction; resourceType: string; id?: string; versionId?: string; params?: string[]; expungeReason?: string },
    run: (
      withRows: (event: Partial<EventBody<Ctx>>) => { audit?: readonly PendingAuditRow[] },
    ) => Promise<{ result: T; id?: string; versionId?: string; ids?: string[]; persisted?: boolean }>,
  ): Promise<T> => {
    const operationId = scope.operationId ?? crypto.randomUUID();
    const withRows = (event: Partial<EventBody<Ctx>>) => {
      const rows = pendingRows(scope, operationId, [{ ...base, outcome: 'success', ...event }]);
      return rows ? { audit: rows } : {};
    };
    let done: Awaited<ReturnType<typeof run>>;
    try {
      done = await run(withRows);
    } catch (err) {
      await auditFailure(scope, { ...base, ...outcomeOf(err) }, err, operationId);
      throw err;
    }
    await audit(
      scope,
      {
        ...base,
        outcome: 'success',
        ...(done.id ? { id: done.id } : {}),
        ...(done.versionId ? { versionId: done.versionId } : {}),
        ...(done.ids ? { ids: done.ids } : {}),
      },
      { operationId, persisted: done.persisted === true },
    );
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

  // ---- write planning: validation, policy and version guard, shared by single writes and Bundles ----

  /** Checks a create; returns the write with its server-assigned id. */
  const planCreate = async (scope: Scope<Ctx>, resource: AnyResource, id: string, validated: boolean): Promise<PlannedWrite> => {
    const resourceType = resource.resourceType;
    const { id: _ignored, ...rest } = resource;
    if (!validated) validate(resourceType, rest);
    if (!(await can(scope, { action: 'create', resourceType, resource: rest as AnyResource }))) {
      throw forbidden('create', resourceType);
    }
    return { kind: 'create', resource: { ...rest, id } as AnyResource & { id: string } };
  };

  /**
   * Checks an update: the policy sees both the stored version (may this caller change it?)
   * and the new content. The write is pinned to exactly the version the policy approved.
   */
  const planUpdate = async (
    scope: Scope<Ctx>,
    resource: AnyResource & { id: string },
    ifMatch: string | undefined,
    validated: boolean,
  ): Promise<PlannedWrite> => {
    const { resourceType, id } = resource;
    if (!validated) validate(resourceType, resource);
    const requested = normalizeVersion(ifMatch);
    const existing = await storage.read(resourceType, id);
    const stored = existing && !existing.deleted ? existing.resource ?? undefined : undefined;
    if (stored && !(await can(scope, { action: 'update', resourceType, id, resource: stored }))) {
      throw hidden(resourceType, id);
    }
    if (!(await can(scope, { action: 'update', resourceType, id, resource }))) {
      throw forbidden('update', resourceType);
    }
    const guard =
      requested !== undefined ? { ifMatch: requested } : existing ? { ifMatch: existing.versionId } : { ifNoneExist: true };
    return { kind: 'update', resource, ...guard };
  };

  /** Checks a delete. Returns undefined when there is nothing to delete (a no-op). */
  const planDelete = async (
    scope: Scope<Ctx>,
    resourceType: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<PlannedWrite | undefined> => {
    const requested = normalizeVersion(ifMatch);
    const existing = await storage.read(resourceType, id);
    if (!existing || existing.deleted || !existing.resource) {
      // Nothing to delete. With an explicit ifMatch, storage still checks it (412 if it doesn't match).
      return requested !== undefined ? { kind: 'delete', resourceType, id, ifMatch: requested } : undefined;
    }
    if (!(await can(scope, { action: 'delete', resourceType, id, resource: existing.resource }))) {
      throw hidden(resourceType, id);
    }
    return { kind: 'delete', resourceType, id, ifMatch: requested ?? existing.versionId };
  };

  /** A single update, returning whether it created the resource (for Bundle response codes). */
  const updateOne = (
    scope: Scope<Ctx>,
    resource: AnyResource & { id: string },
    ifMatch: string | undefined,
  ): Promise<UpdateResult> => {
    const resourceType = checkType(resource?.resourceType);
    const id = checkId(resource.id);
    return audited(scope, { action: 'update', resourceType, id }, async (withRows) => {
      const plan = (await planUpdate(scope, resource, ifMatch, false)) as Extract<PlannedWrite, { kind: 'update' }>;
      const { kind: _kind, resource: r, ...guard } = plan;
      const result = await storage.update(r, { ...writeOptions, ...guard, ...withRows({}) });
      return { result, versionId: result.version.versionId, persisted: auditTable };
    });
  };

  // ---- conditional writes ----

  /** Validates a condition: plain search parameters, no paging, sorting, chains or includes. */
  const conditionParams = (condition: SearchParams | string): SearchParams => {
    const params: SearchParams = typeof condition === 'string' ? parseQuery(condition.replace(/^\?/, '')) : condition ?? {};
    const keys = Object.keys(params).filter((k) => params[k] !== undefined);
    if (keys.length === 0) throw FhirError.invalid('A conditional operation needs a condition');
    for (const key of keys) {
      if (RESULT_PARAMS.has(key) || key === '_format' || isChainKey(key) || isIncludeKey(key)) {
        throw FhirError.invalid('A condition can only use search parameters (no _count, _offset, _sort, chains or includes)');
      }
    }
    const count = keys.reduce((n, k) => n + (Array.isArray(params[k]) ? (params[k] as unknown[]).length : 1), 0);
    if (count > MAX_CONDITION_PARAMS) throw FhirError.invalid(`A condition may have at most ${MAX_CONDITION_PARAMS} parameters`);
    return params;
  };

  /**
   * Runs a condition as the caller (a search through the policy, audited), and builds the
   * guard that re-checks it at write time: the same query plus the policy's search filter.
   */
  const findMatches = async (scope: Scope<Ctx>, ops: SingleOperations, resourceType: string, condition: SearchParams) => {
    if (!table) throw FhirError.notSupported(`FHIR ${fhir.fhirVersion} package has no compiled search parameters`);
    const decision = await decide(scope, { action: 'search', resourceType, params: condition });
    if (!decision.allowed) throw forbidden('search', resourceType);
    const query = await prepare(parseSearch(resourceType, mergeFilter(condition, decision.filter), table, policy));
    const page = await ops.search(resourceType, { ...condition, _count: 2 });
    // The canonical form of the parsed clauses: equivalent spellings of a condition share a lock.
    const key = `${resourceType}|${JSON.stringify(query.clauses.map((c) => JSON.stringify(c)).sort())}`;
    return {
      matches: page.resources as (AnyResource & { id: string; meta: { versionId: string; lastUpdated: string } })[],
      key,
      guard: (expect: WriteCondition['expect']): WriteCondition => ({ key, query: { ...query, sort: [], count: 2, offset: 0 }, expect }),
    };
  };

  const multipleMatches = (resourceType: string) =>
    new FhirError(412, 'multiple-matches', `The condition matches more than one ${resourceType}`);

  /** Parameter names of a condition, for audit events (never values). */
  const namesOf = (params: SearchParams) => Object.keys(params).filter((k) => params[k] !== undefined);

  // ---- data operations, per scope ----
  const operations = (scope: Scope<Ctx>): FhirDataOperations<Record<string, AnyResource>> => {
    const ops: SingleOperations = {
    async create(resource) {
      const resourceType = checkType(resource?.resourceType);
      return audited(scope, { action: 'create', resourceType }, async (withRows) => {
        const plan = (await planCreate(scope, resource, crypto.randomUUID(), false)) as Extract<PlannedWrite, { kind: 'create' }>;
        const version = await storage.create(plan.resource, { ...writeOptions, ...withRows({ id: plan.resource.id }) });
        return { result: version.resource as never, id: version.resource!.id, versionId: version.versionId, persisted: auditTable };
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
      const { version } = await updateOne(scope, resource as AnyResource & { id: string }, updateOptions?.ifMatch);
      return version.resource as never;
    },

    async delete(resourceType, id, deleteOptions) {
      checkType(resourceType);
      checkId(id);
      return audited(scope, { action: 'delete', resourceType, id }, async (withRows) => {
        const plan = await planDelete(scope, resourceType, id, deleteOptions?.ifMatch);
        if (!plan) return { result: undefined }; // nothing to delete: audited on its own
        const version = await storage.delete(resourceType, id, { ifMatch: (plan as { ifMatch: string }).ifMatch, ...withRows({}) });
        return { result: undefined, ...(version ? { versionId: version.versionId } : {}), persisted: auditTable };
      });
    },

    async conditionalCreate(resource, condition) {
      const resourceType = checkType(resource?.resourceType);
      const params = conditionParams(condition);
      const found = await findMatches(scope, ops, resourceType, params);
      // One match: return it. Its read was checked and audited by the condition's search.
      if (found.matches.length === 1) return { resource: found.matches[0] as never, created: false };
      return audited(scope, { action: 'create', resourceType, params: namesOf(params) }, async (withRows) => {
        if (found.matches.length > 1) throw multipleMatches(resourceType);
        const plan = (await planCreate(scope, resource, crypto.randomUUID(), false)) as Extract<PlannedWrite, { kind: 'create' }>;
        const version = await storage.create(plan.resource, {
          ...writeOptions,
          condition: found.guard('none'),
          ...withRows({ id: plan.resource.id }),
        });
        return { result: { resource: version.resource as never, created: true }, id: plan.resource.id, versionId: version.versionId, persisted: auditTable };
      });
    },

    async conditionalUpdate(resourceType, condition, resource, updateOptions) {
      checkType(resourceType);
      if (resource?.resourceType !== resourceType) throw FhirError.invalid('resourceType does not match');
      const params = conditionParams(condition);
      const found = await findMatches(scope, ops, resourceType, params);
      return audited(scope, { action: 'update', resourceType, params: namesOf(params) }, async (withRows) => {
        if (found.matches.length > 1) throw multipleMatches(resourceType);
        const match = found.matches[0];
        const body = resource as AnyResource;
        if (match && body.id !== undefined && body.id !== match.id) {
          throw FhirError.invalid('Resource id does not match the resource the condition matched');
        }
        const id = match ? match.id : checkId(body.id ?? crypto.randomUUID());
        const target = { ...body, id };
        const plan = (await planUpdate(scope, target, match ? updateOptions?.ifMatch : undefined, false)) as Extract<
          PlannedWrite,
          { kind: 'update' }
        >;
        // No match: create, and only if nothing has this id yet (an existing resource that doesn't match is a 412).
        const guard = match ? { ifMatch: plan.ifMatch, ifNoneExist: plan.ifNoneExist } : { ifNoneExist: true };
        const result = await storage.update(plan.resource, {
          ...writeOptions,
          ...(guard.ifMatch !== undefined ? { ifMatch: guard.ifMatch } : {}),
          ...(guard.ifNoneExist ? { ifNoneExist: true } : {}),
          condition: found.guard(match ? { id } : 'none'),
          ...withRows({ id }),
        });
        return {
          result: { resource: result.version.resource as never, created: result.created },
          id,
          versionId: result.version.versionId,
          persisted: auditTable,
        };
      });
    },

    async conditionalDelete(resourceType, condition) {
      checkType(resourceType);
      const params = conditionParams(condition);
      const found = await findMatches(scope, ops, resourceType, params);
      return audited(scope, { action: 'delete', resourceType, params: namesOf(params) }, async (withRows) => {
        if (found.matches.length > 1) throw multipleMatches(resourceType);
        const match = found.matches[0];
        if (!match) return { result: { deleted: false } }; // nothing matches: nothing to delete
        const plan = await planDelete(scope, resourceType, match.id, undefined);
        if (!plan) return { result: { deleted: false }, id: match.id };
        const version = await storage.delete(resourceType, match.id, {
          ifMatch: (plan as { ifMatch: string }).ifMatch,
          condition: found.guard({ id: match.id }),
          ...withRows({ id: match.id }),
        });
        return { result: { deleted: version !== undefined }, id: match.id, ...(version ? { versionId: version.versionId } : {}), persisted: auditTable };
      });
    },

    async expunge(resourceType, id, expungeOptions) {
      checkType(resourceType);
      checkId(id);
      const reason = expungeOptions?.reason;
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > MAX_REASON_LENGTH) {
        throw FhirError.invalid(`expunge needs a reason (1-${MAX_REASON_LENGTH} characters)`);
      }
      return audited(scope, { action: 'expunge', resourceType, id, expungeReason: reason }, async (withRows) => {
        if (!options.expunge) throw FhirError.notSupported('expunge is not enabled for this store (createFhirStore({ expunge: {} }))');
        const versions = await storage.history(resourceType, id);
        if (versions.length === 0) throw FhirError.notFound(resourceType, id);
        // The policy decides on the latest content (a deleted resource by its last version), like history.
        const latest = versions.find((v) => v.resource)?.resource ?? undefined;
        if (!(await can(scope, { action: 'expunge', resourceType, id, ...(latest ? { resource: latest } : {}) }))) {
          throw hidden(resourceType, id);
        }
        // Pinned: if the resource changed after the policy saw it, 412.
        const current = versions[0]!.versionId;
        const requested = normalizeVersion(expungeOptions?.ifMatch);
        // Runs on the expunge storage when configured (a role with DELETE), in one transaction there.
        const removed = await (expungeStorage ?? storage).expunge(resourceType, id, { ifMatch: requested ?? current, ...withRows({}) });
        if (!removed) throw FhirError.notFound(resourceType, id); // expunged concurrently
        return { result: undefined, versionId: requested ?? current, persisted: auditTable };
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

        // Chains and includes are split off; the rest (plus the policy's filter) is a plain search.
        const linked = splitLinks(resourceType, params, table, allowed, policy);
        const merged: Record<string, SearchParams[string]> = { ...mergeFilter(linked.params, decision.filter) };

        // Each chained value runs as its own search on the target type, through the policy and
        // audit like any search, so a chain only matches resources this caller may see. Its matches
        // then become an ordinary reference filter (ANDed with the rest).
        for (const chain of linked.chains) {
          const inner = await ops.search(chain.targetType, { [chain.innerKey]: chain.value, _count: MAX_CHAIN_MATCHES + 1 });
          if (inner.resources.length > MAX_CHAIN_MATCHES || inner.next) {
            throw FhirError.invalid(`Chained ${chain.param} matches more than ${MAX_CHAIN_MATCHES} ${chain.targetType} resources; narrow it`);
          }
          if (inner.resources.length === 0) {
            const empty: SearchResult<never, never> = { resources: [], total: 0, ...(linked.includes.length || linked.revIncludes.length ? { included: [] } : {}) };
            return { result: empty, ids: [] };
          }
          const refs = inner.resources.map((r) => `${chain.targetType}/${r.id}`).join(',');
          const mine = merged[chain.param];
          merged[chain.param] = mine === undefined ? refs : [...(Array.isArray(mine) ? mine : [mine]).map(String), refs];
        }

        const query = await prepare(parseSearch(resourceType, merged, table, policy));
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

        // _include / _revinclude: every included resource is a read (or search) of its own, through
        // the policy and audit. A denied or missing target is left out, never revealed.
        const wantsIncludes = linked.includes.length > 0 || linked.revIncludes.length > 0;
        const included: AnyResource[] = [];
        let limited = false;
        const seen = new Set(resources.map((r) => `${r.resourceType}/${r.id}`));
        const add = (r: AnyResource) => {
          const key = `${r.resourceType}/${r.id}`;
          if (seen.has(key)) return;
          if (included.length >= MAX_INCLUDED) {
            limited = true;
            return;
          }
          seen.add(key);
          included.push(r);
        };
        for (const inc of linked.includes) {
          const targets = new Map<string, [string, string]>();
          for (const r of resources) {
            for (const row of indexParameter(r, inc.param)) {
              if (row.kind !== 'reference' || !row.targetType || !row.targetId) continue;
              if (!allowed.has(row.targetType) || (inc.targetType && row.targetType !== inc.targetType)) continue;
              if (!ID_PATTERN.test(row.targetId)) continue;
              const key = `${row.targetType}/${row.targetId}`;
              if (!seen.has(key)) targets.set(key, [row.targetType, row.targetId]);
            }
          }
          for (const [type, id] of targets.values()) {
            if (included.length >= MAX_INCLUDED) {
              limited = true;
              break;
            }
            try {
              add(await ops.read(type, id));
            } catch (err) {
              if (!(err instanceof FhirError)) throw err; // denied, missing or deleted: left out
            }
          }
        }
        for (const rev of linked.revIncludes) {
          const refs = resources.map((r) => `${resourceType}/${r.id}`);
          for (let i = 0; i < refs.length; i += 100) {
            if (included.length >= MAX_INCLUDED) {
              limited = true;
              break;
            }
            const page = await ops.search(rev.resourceType, {
              [rev.param]: refs.slice(i, i + 100).join(','),
              _count: MAX_INCLUDED - included.length + 1,
            });
            for (const r of page.resources) add(r);
            if (page.next) limited = true;
          }
        }

        const result: SearchResult<never, never> = {
          resources: resources as never[],
          ...(filtered ? {} : { total }),
          ...(nextOffset < total ? { next: { ...params, _offset: nextOffset } } : {}),
          ...(wantsIncludes ? { included: included as never[] } : {}),
          ...(limited ? { includeLimitReached: true } : {}),
        };
        return { result, ids: resources.map((r) => r.id!) };
      });
    },
    };
    return {
      ...ops,
      transaction: (bundle) => runTransaction(scope, bundle),
      batch: (bundle) => runBatch(scope, bundle),
    };
  };

  // ---- Bundles ----

  type SingleOperations = Omit<FhirDataOperations<Record<string, AnyResource>>, 'transaction' | 'batch'>;
  type Op = Extract<StoreAction, 'create' | 'update' | 'delete' | 'read' | 'vread' | 'search'>;
  const actionOf = (r: EntryRequest): Op =>
    r.method === 'POST' ? 'create' : r.method === 'PUT' ? 'update' : r.method === 'DELETE' ? 'delete' : r.kind;
  /** Processing order within a transaction (FHIR: DELETE, POST, PUT, then GET). */
  const RANK = { DELETE: 0, POST: 1, PUT: 2, GET: 3 } as const;

  /** Checks the Bundle's shape and size; validates it (batch: without the entries' resources, which are validated per entry). */
  const checkBundle = (scope: Scope<Ctx>, bundle: BundleInput, type: 'transaction' | 'batch') => {
    if (!bundle || typeof bundle !== 'object' || bundle.resourceType !== 'Bundle') throw FhirError.invalid('Expected a Bundle');
    if (bundle.type !== type) throw FhirError.invalid(`Bundle.type must be ${type}`);
    const entries = bundle.entry ?? [];
    if (Array.isArray(entries) && entries.length > MAX_BUNDLE_ENTRIES) {
      throw FhirError.invalid(`A Bundle may have at most ${MAX_BUNDLE_ENTRIES} entries`);
    }
    const shell =
      type === 'batch' && Array.isArray(entries)
        ? { ...bundle, entry: entries.map((e) => (e && typeof e === 'object' ? { ...e, resource: undefined } : e)) }
        : bundle;
    validate('Bundle', shell);
    if (scope.kind === 'unscoped' && authorize !== 'allow-all') {
      throw FhirError.forbidden('No caller context: use store.as(ctx) or store.asSystem(reason)');
    }
    return entries;
  };

  /** Runs `fn`, adding the entry index to a FhirError. */
  const inEntry = async <T>(index: number, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof FhirError ? atEntry(index, err) : err;
    }
  };

  const countSearches = (requests: readonly EntryRequest[]) => {
    if (requests.filter((r) => r.method === 'GET' && r.kind === 'search').length > MAX_BUNDLE_SEARCHES) {
      throw FhirError.invalid(`A Bundle may have at most ${MAX_BUNDLE_SEARCHES} search entries`);
    }
  };

  /** Runs a GET entry through the normal read / vread / search operation (checked and audited like a single call). */
  const runGet = async (ops: SingleOperations, r: Extract<EntryRequest, { method: 'GET' }>): Promise<BundleResponseEntry> => {
    if (r.kind === 'search') {
      const page = await ops.search(r.resourceType, r.params);
      const searchset = {
        resourceType: 'Bundle',
        type: 'searchset',
        ...(page.total !== undefined ? { total: page.total } : {}),
        entry: page.resources.map((resource) => ({ resource })),
      };
      return { resource: searchset as AnyResource, response: { status: statusLine(200) } };
    }
    const resource =
      r.kind === 'read' ? await ops.read(r.resourceType, r.id) : await ops.vread(r.resourceType, r.id, r.versionId);
    return {
      resource,
      response: { status: statusLine(200), etag: `W/"${resource.meta.versionId}"`, lastModified: resource.meta.lastUpdated },
    };
  };

  const bundleEvent = (action: 'transaction' | 'batch', entries: number, err?: unknown): EventBody<Ctx> => ({
    action,
    resourceType: 'Bundle',
    entries,
    ...(err === undefined ? { outcome: 'success' as const } : outcomeOf(err)),
  });

  /** A Bundle's scope: its entries and the Bundle share one audit operation id. */
  const bundleScope = (scope: Scope<Ctx>): Scope<Ctx> => ({ ...scope, operationId: scope.operationId ?? crypto.randomUUID() });

  const runTransaction = async (outer: Scope<Ctx>, bundle: BundleInput): Promise<BundleResponse> => {
    const scope = bundleScope(outer);
    const ops = operations(scope);
    const operationId = scope.operationId!;
    const versions: (string | undefined)[] = [];
    /** Conditional creates that matched an existing resource (no write). */
    const existing: (AnyResource & { id: string; meta: { versionId: string; lastUpdated: string } })[] = [];
    const requests: EntryRequest[] = [];
    const ids: (string | undefined)[] = [];
    let failedAt = -1;
    let entryCount = 0;
    const response: BundleResponseEntry[] = [];
    try {
      const entries = checkBundle(scope, bundle, 'transaction');
      entryCount = entries.length;

      // 1. Parse every request; assign ids to creates.
      const written = new Set<string>();
      const claim = (i: number, resourceType: string, id: string) => {
        const key = `${resourceType}/${id}`;
        if (written.has(key)) throw atEntry(i, FhirError.invalid(`${key} appears in more than one entry`));
        written.add(key);
      };
      for (const [i, entry] of entries.entries()) {
        failedAt = i;
        const r = await inEntry(i, () => {
          const r = parseEntryRequest(entry.request, checkType, checkId);
          if (r.method === 'POST' || r.method === 'PUT') {
            if (!entry.resource) throw FhirError.invalid('resource is required for POST and PUT');
            if (entry.resource.resourceType !== r.resourceType) throw FhirError.invalid('resource type does not match request.url');
            if (r.method === 'PUT' && r.id !== undefined && entry.resource.id !== r.id) throw FhirError.invalid('resource.id must match request.url');
          }
          return r;
        });
        requests.push(r);
        ids.push(r.method === 'POST' ? crypto.randomUUID() : r.method === 'GET' ? ('id' in r ? r.id : undefined) : r.id);
        if ((r.method === 'PUT' || r.method === 'DELETE') && r.id !== undefined) claim(i, r.resourceType, r.id);
      }
      countSearches(requests);

      // 1b. Conditional entries: run each condition as the caller, decide its target, and keep a
      //     guard that the write re-checks under a lock. A conditional create that matches writes
      //     nothing and points its fullUrl at the existing resource.
      const guards: (WriteCondition | undefined)[] = [];
      const createOnly: boolean[] = [];
      const conditionKeys = new Set<string>();
      for (const [i, r] of requests.entries()) {
        if (r.method === 'GET' || !r.condition) continue;
        failedAt = i;
        await inEntry(i, async () => {
          const found = await findMatches(scope, ops, r.resourceType, conditionParams(r.condition!));
          if (conditionKeys.has(found.key)) throw FhirError.invalid('Two entries use the same condition');
          conditionKeys.add(found.key);
          if (found.matches.length > 1) throw multipleMatches(r.resourceType);
          const match = found.matches[0];
          if (r.method === 'POST') {
            if (match) {
              existing[i] = match;
              ids[i] = match.id;
            } else guards[i] = found.guard('none');
            return;
          }
          if (r.method === 'PUT') {
            const bodyId = entries[i]!.resource!.id;
            if (match && bodyId !== undefined && bodyId !== match.id) {
              throw FhirError.invalid('Resource id does not match the resource the condition matched');
            }
            ids[i] = match ? match.id : checkId(bodyId ?? crypto.randomUUID());
            guards[i] = found.guard(match ? { id: match.id } : 'none');
            createOnly[i] = !match;
          } else {
            ids[i] = match?.id;
            if (match) guards[i] = found.guard({ id: match.id });
          }
          if (ids[i]) claim(i, r.resourceType, ids[i]!);
        });
      }

      // Map urn:uuid fullUrls to the Type/id each entry ends up with.
      const targets = new Map<string, string>();
      for (const [i, entry] of entries.entries()) {
        const r = requests[i]!;
        if (!entry.fullUrl?.startsWith('urn:uuid:')) continue;
        if (targets.has(entry.fullUrl)) throw atEntry(i, FhirError.invalid('fullUrl appears in more than one entry'));
        if (r.method === 'POST' || r.method === 'PUT') targets.set(entry.fullUrl, `${r.resourceType}/${ids[i]}`);
      }

      // 2. Resolve references, then check every write with the policy (DELETE, POST, PUT), writing nothing yet.
      const order = requests.map((_, i) => i).sort((a, b) => RANK[requests[a]!.method] - RANK[requests[b]!.method] || a - b);
      const plans: (PlannedWrite | undefined)[] = [];
      for (const i of order) {
        const r = requests[i]!;
        if (r.method === 'GET') continue;
        failedAt = i;
        if (existing[i]) continue; // conditional create that matched: nothing to write
        plans[i] = await inEntry(i, async () => {
          const condition = guards[i] ? { condition: guards[i] } : {};
          if (r.method === 'DELETE') {
            if (!ids[i]) return undefined; // conditional delete without a match: nothing to delete
            const plan = await planDelete(scope, r.resourceType, ids[i]!, entries[i]!.request?.ifMatch);
            return plan ? { ...plan, ...condition } : undefined;
          }
          // The Bundle was validated as a whole; rewriting urn:uuid references keeps it valid.
          const resource = resolveReferences(entries[i]!.resource!, targets);
          if (r.method === 'POST') return { ...(await planCreate(scope, resource, ids[i]!, true)), ...condition };
          const target = { ...resource, id: ids[i]! };
          const plan = (await planUpdate(scope, target, entries[i]!.request?.ifMatch, true)) as Extract<PlannedWrite, { kind: 'update' }>;
          // A conditional update without a match creates, and only if nothing has that id yet.
          return createOnly[i] ? { kind: 'update' as const, resource: plan.resource, ifNoneExist: true, ...condition } : { ...plan, ...condition };
        });
      }
      failedAt = -1;

      // 3. One atomic write. Any guard failure (412) rolls back everything. With the audit table,
      //    every write entry's row and the Bundle's row are written in the same transaction.
      const writeIndexes = requests.map((_, i) => i).filter((i) => plans[i]);
      const rows = pendingRows(scope, operationId, [
        ...requests.flatMap((r, i) => {
          if (r.method === 'GET' || existing[i]) return [];
          const n = writeIndexes.indexOf(i);
          return [{ action: actionOf(r), resourceType: r.resourceType, ...(ids[i] ? { id: ids[i] } : {}), outcome: 'success' as const, ...(n >= 0 ? { write: n } : {}) }];
        }),
        bundleEvent('transaction', entryCount),
      ]);
      const results = await storage.writeAll(
        writeIndexes.map((i) => plans[i]!),
        rows ? { ...writeOptions, audit: rows } : writeOptions,
      );
      for (const [n, i] of writeIndexes.entries()) {
        const result = results[n]!;
        versions[i] = (result.kind === 'update' ? result.result.version : result.version)?.versionId;
        response[i] =
          result.kind === 'create'
            ? writeResponse(result.version, 201)
            : result.kind === 'update'
              ? writeResponse(result.result.version, result.result.created ? 201 : 200)
              : { response: { status: statusLine(204) } };
      }
      for (const [i, r] of requests.entries()) {
        if (r.method === 'DELETE' && !response[i]) response[i] = { response: { status: statusLine(204) } }; // nothing to delete
        const found = existing[i];
        if (found) response[i] = writeResponse({ versionId: found.meta.versionId, lastUpdated: found.meta.lastUpdated, deleted: false, resource: found }, 200);
      }
    } catch (err) {
      // Nothing was written: every entry is audited as failed, the failing one with its own outcome.
      for (const [i, r] of requests.entries()) {
        await auditFailure(
          scope,
          {
            action: actionOf(r),
            resourceType: r.resourceType,
            ...(ids[i] && r.method !== 'POST' ? { id: ids[i] } : {}),
            ...(i === failedAt ? outcomeOf(err) : { outcome: 'error' as const, status: outcomeOf(err).status }),
          },
          err,
        );
      }
      await auditFailure(scope, bundleEvent('transaction', entryCount, err), err);
      throw err;
    }

    // Committed (with its audit rows, if the table is on). Report each write to onAudit, then run
    // the GET entries (each checked and audited as a single read or search).
    const persisted = auditTable;
    for (const [i, r] of requests.entries()) {
      if (r.method === 'GET' || existing[i]) continue;
      await audit(
        scope,
        {
          action: actionOf(r),
          resourceType: r.resourceType,
          ...(ids[i] ? { id: ids[i] } : {}),
          ...(versions[i] ? { versionId: versions[i] } : {}),
          outcome: 'success',
        },
        { persisted },
      );
    }
    for (const [i, r] of requests.entries()) {
      if (r.method !== 'GET') continue;
      // After the commit a failed read can't undo the writes, so it is reported in its entry, like in a batch.
      try {
        response[i] = await runGet(ops, r);
      } catch (err) {
        if (!(err instanceof FhirError)) throw err;
        response[i] = errorResponse(err);
      }
    }
    await audit(scope, bundleEvent('transaction', entryCount), { persisted });
    return { resourceType: 'Bundle', type: 'transaction-response', entry: response };
  };

  const runBatch = async (outer: Scope<Ctx>, bundle: BundleInput): Promise<BundleResponse> => {
    const scope = bundleScope(outer);
    const ops = operations(scope);
    let entries: readonly NonNullable<BundleInput['entry']>[number][];
    try {
      entries = checkBundle(scope, bundle, 'batch');
    } catch (err) {
      await auditFailure(scope, bundleEvent('batch', 0, err), err);
      throw err;
    }
    const fullUrls = new Set(entries.map((e) => e.fullUrl).filter((u): u is string => typeof u === 'string'));
    let searches = 0;
    const response: BundleResponseEntry[] = [];
    for (const [i, entry] of entries.entries()) {
      try {
        const r = parseEntryRequest(entry.request, checkType, checkId);
        if (r.method === 'GET') {
          if (r.kind === 'search' && ++searches > MAX_BUNDLE_SEARCHES) {
            throw FhirError.invalid(`A Bundle may have at most ${MAX_BUNDLE_SEARCHES} search entries`);
          }
          response.push(await runGet(ops, r));
          continue;
        }
        if (r.method === 'DELETE') {
          if (r.condition) await ops.conditionalDelete(r.resourceType, r.condition);
          else await ops.delete(r.resourceType, r.id, { ifMatch: entry.request?.ifMatch });
          response.push({ response: { status: statusLine(204) } });
          continue;
        }
        const resource = entry.resource;
        if (!resource) throw FhirError.invalid('resource is required for POST and PUT');
        if (resource.resourceType !== r.resourceType) throw FhirError.invalid('resource type does not match request.url');
        if (referencesAny(resource, fullUrls)) {
          throw FhirError.invalid('batch entries cannot reference each other (use a transaction)');
        }
        const asVersion = (s: AnyResource & { id?: string; meta?: { versionId?: string; lastUpdated?: string } }) => ({
          versionId: s.meta!.versionId!,
          lastUpdated: s.meta!.lastUpdated!,
          deleted: false,
          resource: s as AnyResource & { id: string },
        });
        if (r.method === 'POST' && r.condition) {
          const { resource: stored, created } = await ops.conditionalCreate(resource as never, r.condition);
          response.push(writeResponse(asVersion(stored), created ? 201 : 200));
        } else if (r.method === 'POST') {
          const created = await ops.create(resource as never);
          response.push(writeResponse(asVersion(created), 201));
        } else if (r.condition) {
          const { resource: stored, created } = await ops.conditionalUpdate(r.resourceType, r.condition, resource as never, {
            ...(entry.request?.ifMatch ? { ifMatch: entry.request.ifMatch } : {}),
          });
          response.push(writeResponse(asVersion(stored), created ? 201 : 200));
        } else {
          if (resource.id !== r.id) throw FhirError.invalid('resource.id must match request.url');
          const { version, created } = await updateOne(scope, resource as AnyResource & { id: string }, entry.request?.ifMatch);
          response.push(writeResponse(version, created ? 201 : 200));
        }
      } catch (err) {
        // Only deliberate errors become an entry's response; infrastructure and audit failures fail the batch.
        if (!(err instanceof FhirError)) throw err;
        response.push(errorResponse(atEntry(i, err)));
      }
    }
    await audit(scope, bundleEvent('batch', entries.length));
    return { resourceType: 'Bundle', type: 'batch-response', entry: response };
  };

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
    searchParameters(resourceType) {
      checkType(resourceType);
      return (table?.[resourceType] ?? [])
        .filter((p) => policy(resourceType, p.code) !== 'none')
        .map((p) => ({ code: p.code, type: p.type, ...(p.targets ? { targets: p.targets } : {}) }));
    },
    async migrate() {
      const { applied, reindex: needsReindex } = await storage.migrate(resourceTypes, { audit: auditTable });
      if (!needsReindex?.length) return { applied };
      return { applied, reindexed: await reindex(needsReindex) };
    },
    async reencrypt(reencryptOptions = {}) {
      if (!options.encryption) throw new Error('reencrypt: the store has no `encryption` option');
      const types = reencryptOptions.resourceType !== undefined ? [checkType(reencryptOptions.resourceType)] : resourceTypes;
      const olderThan = reencryptOptions.olderThan?.toISOString();
      const out: Record<string, number> = {};
      // The wrapped storage fills in open and seal.
      for (const t of types) out[t] = await storage.reencrypt(t, { open: (v) => Promise.resolve(v), seal: undefined as never, ...(olderThan ? { olderThan } : {}) });
      return out;
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
    if (isChainKey(key) || isIncludeKey(key)) throw new Error('authorize: a search filter can\'t use chains or _include / _revinclude');
    const mine = merged[key];
    merged[key] =
      mine === undefined
        ? value
        : [...(Array.isArray(mine) ? mine : [mine]), ...(Array.isArray(value) ? value : [value])].map(String);
  }
  return merged;
}

import type { SearchParams } from './search/query.js';
import type { AnyResource } from './types.js';

/** Every data operation the store performs (`transaction` and `batch` are audited, never sent to `authorize`). */
export type StoreAction = 'create' | 'read' | 'vread' | 'update' | 'delete' | 'history' | 'search' | 'transaction' | 'batch';

/** The actions `authorize` is asked about. Bundles aren't authorized as a whole: each entry is. */
export type AuthorizeAction = Exclude<StoreAction, 'transaction' | 'batch'>;

/**
 * What `authorize` is asked. `resource` is the content the action touches:
 * the new resource for `create`, the stored one for `read` / `vread` /
 * `history` / `delete`, and for `update` the policy is asked twice, once with
 * the stored version (if any) and once with the new content.
 */
export interface AuthorizeRequest<Ctx> {
  ctx: Ctx;
  action: AuthorizeAction;
  resourceType: string;
  id?: string;
  resource?: AnyResource;
  /** For `search`: the query the caller sent (before any policy filter). */
  params?: SearchParams;
}

/**
 * The result of a policy decision. Only `true` allows; anything else
 * (false, undefined, a thrown error) denies. For `search`, a policy can allow
 * with extra search parameters that are ANDed into the caller's query, e.g.
 * `{ filter: { patient: ctx.patientId } }`, so totals and paging stay exact.
 */
export type AuthorizeResult = boolean | { filter: SearchParams } | undefined;

/** An app-supplied access policy. */
export type AuthorizePolicy<Ctx> = (request: AuthorizeRequest<Ctx>) => AuthorizeResult | Promise<AuthorizeResult>;

export type AuditOutcome = 'success' | 'denied' | 'not-found' | 'error';

/**
 * One audit record. It identifies who did what to which resources, never
 * resource content or search values (both can be PHI).
 */
export interface StoreAuditEvent<Ctx> {
  /** ISO 8601 time the operation finished. */
  recorded: string;
  /** The caller context from `store.as(ctx)`; undefined for system and unscoped calls. */
  ctx: Ctx | undefined;
  /** True for `store.asSystem(reason)`. */
  system: boolean;
  /** The reason passed to `asSystem`. */
  reason?: string;
  action: StoreAction;
  resourceType: string;
  id?: string;
  versionId?: string;
  outcome: AuditOutcome;
  /** HTTP status for failures (403, 404, 410, 412, ...). */
  status?: number;
  /** For `search`: names of the parameters used (not their values). */
  params?: string[];
  /** For `search`: ids of the resources returned. */
  ids?: string[];
  /** For `transaction` and `batch`: how many entries the Bundle had (each entry also gets its own event). */
  entries?: number;
}

export type AuditSink<Ctx> = (event: StoreAuditEvent<Ctx>) => void | Promise<void>;

export interface AccessOptions<Ctx> {
  /**
   * Access policy for every data operation. Required: pass a policy function,
   * or the literal `'allow-all'` to run without access control. There is no
   * implicit default, so skipping authorization is always visible in code.
   *
   * With a policy function, calls must go through `store.as(ctx)` (checked)
   * or `store.asSystem(reason)` (bypasses the policy, still audited); calling
   * the store directly throws 403.
   */
  authorize: AuthorizePolicy<Ctx> | 'allow-all';
  /**
   * Receives an audit event for every data operation, including denied and
   * failed ones. If it throws, the operation fails (for writes: after the
   * write committed). Strongly recommended for PHI.
   */
  onAudit?: AuditSink<Ctx>;
  /**
   * Called when `onAudit` throws, instead of failing the operation. Use it
   * only to route audit failures somewhere you will notice (alerting).
   */
  onAuditError?: (error: unknown, event: StoreAuditEvent<Ctx>) => void;
}

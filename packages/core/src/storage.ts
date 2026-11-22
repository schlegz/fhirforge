import type { IndexRow } from './search/index-rows.js';
import type { SearchQuery } from './search/query.js';
import type { AnyResource, MigrationResult } from './types.js';

/** Computes a resource's search index rows. Called by the adapter on the stamped resource, inside the write transaction. */
export type Indexer = (resource: AnyResource & { id: string }) => IndexRow[];

export interface WriteOptions {
  /** When set, the adapter replaces the resource's index rows in the same transaction. */
  index?: Indexer;
}

/**
 * The contract between the store and a storage adapter (e.g. `@fhirforge/pg`).
 * Core never does I/O itself: every read and write goes through this.
 *
 * Adapters own versioning: they assign `versionId` and `lastUpdated` inside
 * the same transaction as the write, and stamp them on the stored resource
 * with `stampMeta`.
 */
export interface FhirStorage {
  /**
   * Creates or upgrades the storage for these resource types. Safe to call
   * repeatedly and concurrently. Lists in `reindex` the types whose index
   * tables were just created, so existing resources need indexing.
   */
  migrate(resourceTypes: readonly string[]): Promise<MigrationResult & { reindex?: string[] }>;

  /** Inserts version 1. Throws FhirError.duplicate if the id exists (even if deleted). */
  create(resource: AnyResource & { id: string }, options?: WriteOptions): Promise<StoredVersion>;

  /**
   * Writes a new version, or version 1 if the resource doesn't exist yet
   * (FHIR update-as-create). With `ifMatch`, throws FhirError.versionConflict
   * unless the current version equals it. With `ifNoneExist`, throws it if the
   * resource exists at all (even deleted). Checked under the row lock.
   */
  update(
    resource: AnyResource & { id: string },
    options?: { ifMatch?: string; ifNoneExist?: boolean } & WriteOptions,
  ): Promise<UpdateResult>;

  /**
   * Records a delete as a new version and removes the resource's index rows.
   * Returns undefined if there was nothing to delete. With `ifMatch`, throws
   * FhirError.versionConflict unless the current version equals it.
   */
  delete(resourceType: string, id: string, options?: { ifMatch?: string }): Promise<StoredVersion | undefined>;

  /** The current version, including a deleted one (with `deleted: true`). */
  read(resourceType: string, id: string): Promise<StoredVersion | undefined>;

  /** A specific version. */
  vread(resourceType: string, id: string, versionId: string): Promise<StoredVersion | undefined>;

  /** Every version, newest first. */
  history(resourceType: string, id: string): Promise<StoredVersion[]>;

  /** Runs a validated search over current, non-deleted resources. `total` counts all matches, not just this page. */
  search(query: SearchQuery): Promise<{ versions: StoredVersion[]; total: number }>;

  /** Rebuilds the index rows of every current resource of a type. Returns how many were indexed. */
  reindex(resourceType: string, index: Indexer): Promise<number>;

  /**
   * Applies every write in one database transaction, all or nothing (Bundle
   * transactions). Each write has the same semantics and guards as the single
   * method of its kind. Rows are locked in a fixed order (resource type, then
   * id) so concurrent calls can't deadlock; the store never passes two writes
   * for the same resource. Any failure rolls back every write and rethrows that
   * write's error. Returns one result per write, in input order.
   */
  writeAll(writes: readonly PlannedWrite[], options?: WriteOptions): Promise<WriteResult[]>;
}

/** One write in a `writeAll` call. */
export type PlannedWrite =
  | { kind: 'create'; resource: AnyResource & { id: string } }
  | { kind: 'update'; resource: AnyResource & { id: string }; ifMatch?: string; ifNoneExist?: boolean }
  | { kind: 'delete'; resourceType: string; id: string; ifMatch?: string };

/** The result of one write, like the single method of its kind returns. */
export type WriteResult =
  | { kind: 'create'; version: StoredVersion }
  | { kind: 'update'; result: UpdateResult }
  | { kind: 'delete'; version?: StoredVersion };

export interface StoredVersion {
  versionId: string;
  /** ISO 8601 instant. */
  lastUpdated: string;
  deleted: boolean;
  /** The resource with its meta stamped; null for a delete version. */
  resource: (AnyResource & { id: string }) | null;
}

export interface UpdateResult {
  version: StoredVersion;
  /** True when the update created the resource. */
  created: boolean;
}

/** Returns a copy of the resource with server-assigned meta (keeps any other meta fields). */
export function stampMeta<T extends AnyResource>(
  resource: T,
  versionId: string,
  lastUpdated: string,
): T & { meta: { versionId: string; lastUpdated: string } } {
  return { ...resource, meta: { ...resource.meta, versionId, lastUpdated } };
}

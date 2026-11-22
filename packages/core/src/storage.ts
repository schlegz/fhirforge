import type { AnyResource, MigrationResult } from './types.js';

/**
 * The contract between the store and a storage adapter (e.g. `@fhirforge/pg`).
 * Core never does I/O itself: every read and write goes through this.
 *
 * Adapters own versioning: they assign `versionId` and `lastUpdated` inside
 * the same transaction as the write, and stamp them on the stored resource
 * with `stampMeta`.
 */
export interface FhirStorage {
  /** Creates or upgrades the storage for these resource types. Safe to call repeatedly and concurrently. */
  migrate(resourceTypes: readonly string[]): Promise<MigrationResult>;

  /** Inserts version 1. Throws FhirError.duplicate if the id exists (even if deleted). */
  create(resource: AnyResource & { id: string }): Promise<StoredVersion>;

  /**
   * Writes a new version, or version 1 if the resource doesn't exist yet
   * (FHIR update-as-create). With `ifMatch`, throws FhirError.versionConflict
   * unless the current version equals it.
   */
  update(resource: AnyResource & { id: string }, options?: { ifMatch?: string }): Promise<UpdateResult>;

  /** Records a delete as a new version. Returns undefined if there was nothing to delete. */
  delete(resourceType: string, id: string): Promise<StoredVersion | undefined>;

  /** The current version, including a deleted one (with `deleted: true`). */
  read(resourceType: string, id: string): Promise<StoredVersion | undefined>;

  /** A specific version. */
  vread(resourceType: string, id: string, versionId: string): Promise<StoredVersion | undefined>;

  /** Every version, newest first. */
  history(resourceType: string, id: string): Promise<StoredVersion[]>;
}

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

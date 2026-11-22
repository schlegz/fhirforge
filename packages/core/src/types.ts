/**
 * The smallest resource shape core relies on. Every generated resource type
 * (e.g. `@fhirforge/r4`'s Patient) is assignable to it.
 */
export interface AnyResource {
  resourceType: string;
  id?: string;
  meta?: { versionId?: string; lastUpdated?: string };
}

/**
 * What a version package (e.g. `r4` from `@fhirforge/r4`) provides. The
 * resource map is a type-only marker: core never reads it at runtime.
 */
export interface FhirVersionPackage<TMap> {
  readonly fhirVersion: string;
  readonly __resources?: TMap;
}

/** Extracts the resource map (resource type name → type) from a version package. */
export type ResourceMapOf<V> = V extends FhirVersionPackage<infer M> ? M : never;

/** A resource as returned by the store: it always has an id and server-assigned meta. */
export type Stored<T> = T & {
  id: string;
  meta: { versionId: string; lastUpdated: string };
};

/** One version of a resource, as kept in its history. */
export interface HistoryEntry<T> {
  versionId: string;
  lastUpdated: string;
  /** True for the version that recorded a delete; it has no resource. */
  deleted: boolean;
  resource?: Stored<T>;
}

export interface MigrationResult {
  /** Migration ids applied by this call, in order. Empty when already up to date. */
  applied: string[];
}

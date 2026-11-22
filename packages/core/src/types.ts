import type { SearchParameterTable } from './search/types.js';
import type { ValidationTable } from './validation/types.js';

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
  /** Compiled search parameters (generated). Without them, the store can't search. */
  readonly searchParameters?: SearchParameterTable;
  /** Compiled validation rules (generated). Required: the store validates every resource it writes. */
  readonly validation?: ValidationTable;
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
  /** Resource type → resources indexed, when a migration added search indexes for existing data. */
  reindexed?: Record<string, number>;
}

/** One page of search results. */
export interface SearchResult<T, I = unknown> {
  resources: T[];
  /**
   * With `_include` / `_revinclude`: the referenced or referencing resources the caller may
   * read (each checked and audited as its own read or search), without duplicates.
   */
  included?: I[];
  /** True when more resources would have been included than the limit (`MAX_INCLUDED`) allows. */
  includeLimitReached?: boolean;
  /**
   * Number of matches across all pages. Omitted when the access policy removed
   * results after the query ran (it would count resources the caller can't see).
   * Use a search `filter` in the policy to keep totals exact.
   */
  total?: number;
  /** Parameters for the next page, or undefined on the last page. */
  next?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>;
}

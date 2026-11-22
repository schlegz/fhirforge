/**
 * Compiled validation rules, as generated into a version package (e.g.
 * `@fhirforge/r4`'s `validation`) by `@fhirforge/codegen`.
 *
 * The rules come from the StructureDefinitions at build time. At runtime the
 * validator only walks this data: no FHIRPath, no expressions, no regexes from
 * the definitions (primitive formats are fixed checks in core).
 */

/** JSON value kind of a FHIR primitive. */
export type PrimitiveKind = 'string' | 'number' | 'boolean';

/** One element of a type, keyed by its JSON property name (`birthDate`, `valueQuantity`). */
export interface ElementRule {
  /**
   * The element's type: a primitive code (`date`), a complex type (`HumanName`),
   * a backbone element path in the same table (`Patient.contact`), or
   * `Resource` for a nested resource (`contained`, `Bundle.entry.resource`).
   */
  t: string;
  /** Minimum count (omitted when 0). For a choice variant, the minimum for the whole choice group. */
  min?: number;
  /** Maximum count. 1 means a single value (not an array); omitted means unbounded (an array). */
  max?: number;
  /** For a choice variant (`valueQuantity`): its choice group (`value[x]`). At most one variant per group may be present. */
  choice?: string;
  /** For a `code` with a required binding: the value set (a key of `ValidationTable.valueSets`). */
  vs?: string;
}

export interface ValidationTable {
  /** Primitive type code → JSON value kind. */
  readonly primitives: Readonly<Record<string, PrimitiveKind>>;
  /** Complex type names, resource type names and backbone element paths → their elements. */
  readonly types: Readonly<Record<string, Readonly<Record<string, ElementRule>>>>;
  /** Value set canonical URL → its codes, for required bindings on `code` elements. */
  readonly valueSets: Readonly<Record<string, readonly string[]>>;
  /** Concrete resource type names (valid `resourceType` values, e.g. in `contained`). */
  readonly resources: readonly string[];
}

/**
 * Compiled search parameter definitions, as generated into a version package
 * (e.g. `@fhirforge/r4`'s `searchParameters`) by `@fhirforge/codegen`.
 *
 * Each parameter's FHIRPath expression is compiled at build time into plain
 * path steps, so the runtime needs no FHIRPath engine and runs no expressions.
 */

export type SearchParamType = 'token' | 'string' | 'date' | 'reference' | 'quantity' | 'number' | 'uri';

/** One step of a compiled path: read field `f` of every current value. */
export interface PathStep {
  /** Field name in the JSON (for a cast choice element, the full name, e.g. `valueQuantity`). */
  f: string;
  /** FHIR type of the field, when it has exactly one. */
  t?: string;
  /** A choice element (`value[x]`) without a cast: JSON key → FHIR type, e.g. `{ effectiveDateTime: 'dateTime' }`. */
  choice?: Record<string, string>;
  /** Keep only values that pass this filter (from a FHIRPath `where(...)`). */
  where?: StepFilter;
}

export type StepFilter =
  /** `where(resolve() is Patient)`: a Reference whose target type is Patient. */
  | { resolveIs: string }
  /** `where(system='phone')`: a child field equal to a literal. */
  | { field: string; equals: string };

export interface CompiledSearchParameter {
  /** The search parameter code used in queries, e.g. `birthdate`. */
  code: string;
  type: SearchParamType;
  /** Alternative paths (the expression's `|` union); values from all of them are indexed. */
  paths: PathStep[][];
  /** For reference parameters: the resource types it may point to. */
  targets?: string[];
}

/** Resource type → its searchable parameters. */
export type SearchParameterTable = Readonly<Record<string, readonly CompiledSearchParameter[]>>;

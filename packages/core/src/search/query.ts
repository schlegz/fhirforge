import { FhirError } from '../errors.js';
import { BUILT_IN_PARAMETERS, type SearchPolicy } from './index-rows.js';
import type { CompiledSearchParameter, SearchParamType, SearchParameterTable } from './types.js';
import { dateRange, normalizeString, numberRange, parseReference } from './values.js';

/** Query parameters as an app passes them: `{ name: 'doe', birthdate: ['ge1970', 'lt1980'], _count: 10 }`. */
export type SearchParams = Readonly<Record<string, string | number | boolean | readonly (string | number)[] | undefined>>;

export type Prefix = 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'sa' | 'eb';

/** One value of a search parameter. Several values of one clause are ORed. */
export type SearchCondition =
  | { kind: 'string'; mode: 'prefix' | 'exact' | 'contains'; value: string }
  /** `system` undefined = any system; null = no system (`|code`). `code` undefined = any code (`system|`). */
  | { kind: 'token'; system?: string | null; code?: string }
  /** The search value's range [low, high), by its precision. */
  | { kind: 'date'; prefix: Prefix; low: string; high: string }
  | { kind: 'reference'; targetType?: string; targetId?: string; reference?: string }
  | { kind: 'number'; prefix: Prefix; value: string; low: string; high: string }
  | { kind: 'quantity'; prefix: Prefix; value: string; low: string; high: string; system?: string | null; code?: string }
  | { kind: 'uri'; value: string }
  /** A blind index lookup: the keyed hash of the search value. */
  | { kind: 'blind'; keyId: string; hash: string };

/** One query parameter. Clauses are ANDed. */
export interface SearchClause {
  param: string;
  /** `id` and `lastUpdated` are answered from the resource table (`_id`, `_lastUpdated`); `blind` from the blind index. */
  type: SearchParamType | 'id' | 'lastUpdated' | 'blind';
  conditions: SearchCondition[];
  /** `:not` (tokens): match resources with no matching value. */
  negate?: boolean;
  /** `:missing=true|false`: match on whether the resource has any value for the parameter. */
  missing?: boolean;
}

export interface SortKey {
  param: string;
  type: SearchParamType | 'id' | 'lastUpdated';
  descending: boolean;
}

/** A validated, typed search, ready for a storage adapter to turn into SQL. */
export interface SearchQuery {
  resourceType: string;
  clauses: SearchClause[];
  sort: SortKey[];
  count: number;
  offset: number;
}

export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 1000;
const MAX_OFFSET = 100_000;
const MAX_VALUES = 100;
const MAX_CLAUSES = 50;

const PREFIXES: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb']);
const SORTABLE: ReadonlySet<string> = new Set(['date', 'string', 'token', 'number', 'quantity', 'uri', 'id', 'lastUpdated']);

/**
 * Parses and validates FHIR search parameters for one resource type. Every
 * value is checked against the parameter's type; unknown parameters,
 * modifiers and malformed values are 400 errors (strict handling), so a typo
 * never silently widens a search. Error messages name the parameter, never
 * the value: search values can be PHI.
 */
export function parseSearch(
  resourceType: string,
  params: SearchParams,
  table: SearchParameterTable,
  policy: (resourceType: string, code: string) => SearchPolicy,
): SearchQuery {
  const defs = new Map((table[resourceType] ?? []).map((p) => [p.code, p]));
  const query: SearchQuery = { resourceType, clauses: [], sort: [], count: DEFAULT_COUNT, offset: 0 };

  for (const [rawKey, rawValue] of Object.entries(params)) {
    if (rawValue === undefined) continue;
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(String);

    if (rawKey === '_count') query.count = intParam('_count', values, 1, MAX_COUNT);
    else if (rawKey === '_offset') query.offset = intParam('_offset', values, 0, MAX_OFFSET);
    else if (rawKey === '_sort') query.sort = parseSort(values, defs, resourceType, policy);
    else {
      const [code, modifier] = splitModifier(rawKey);
      const def = lookup(defs, resourceType, code, policy);
      for (const value of values) query.clauses.push(parseClause(def, modifier, value));
    }
  }
  if (query.clauses.length > MAX_CLAUSES) throw FhirError.invalid(`Too many search parameters (max ${MAX_CLAUSES})`);
  return query;
}

/** Parameter and modifier names go into error messages only if they look like names (never free text). */
function safeName(name: string | undefined): string {
  return name !== undefined && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) ? name : '(invalid name)';
}

function intParam(name: string, values: string[], min: number, max: number): number {
  const v = values[values.length - 1]!;
  if (!/^\d+$/.test(v) || Number(v) < min) throw FhirError.invalid(`${name} must be an integer ≥ ${min}`);
  return Math.min(Number(v), max);
}

function splitModifier(key: string): [string, string | undefined] {
  const i = key.indexOf(':');
  return i === -1 ? [key, undefined] : [key.slice(0, i), key.slice(i + 1)];
}

type Def = Pick<CompiledSearchParameter, 'code' | 'targets'> & { type: SearchParamType | 'id' | 'lastUpdated' };

function lookup(
  defs: Map<string, CompiledSearchParameter>,
  resourceType: string,
  code: string,
  policy: (resourceType: string, code: string) => SearchPolicy,
): Def {
  if (code === '_id') return { code, type: 'id' };
  if (code === '_lastUpdated') return { code, type: 'lastUpdated' };
  const def = defs.get(code);
  if (!def) throw FhirError.invalid(`Unknown search parameter for ${resourceType}: ${safeName(code)}`);
  if (policy(resourceType, code) === 'none') {
    throw FhirError.invalid(`Search parameter ${resourceType}.${code} is not searchable (search policy "none")`);
  }
  return def;
}

function parseSort(
  values: string[],
  defs: Map<string, CompiledSearchParameter>,
  resourceType: string,
  policy: (resourceType: string, code: string) => SearchPolicy,
): SortKey[] {
  return values
    .flatMap((v) => v.split(','))
    .map((raw) => {
      const descending = raw.startsWith('-');
      const def = lookup(defs, resourceType, descending ? raw.slice(1) : raw, policy);
      if (!SORTABLE.has(def.type)) throw FhirError.invalid(`Cannot sort by ${def.code} (${def.type})`);
      return { param: def.code, type: def.type, descending };
    });
}

/** Splits on commas not escaped with a backslash, and unescapes `\,` `\|` `\$` `\\`. */
function splitValues(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  if (parts.length > MAX_VALUES) throw FhirError.invalid(`Too many values (max ${MAX_VALUES})`);
  return parts;
}

/** Splits on unescaped `|` and unescapes each part. */
function splitPipe(value: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '\\' && i + 1 < value.length) {
      current += value[i + 1];
      i++;
    } else if (ch === '|') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

function prefixed(value: string): [Prefix, string] {
  const p = value.slice(0, 2);
  if (PREFIXES.has(p) && value.length > 2 && !/^[a-z]/.test(value.slice(2, 3))) return [p as Prefix, value.slice(2)];
  if (p === 'ap') throw FhirError.invalid('The ap (approximately) prefix is not supported yet');
  return ['eq', value];
}

function parseClause(def: Def, modifier: string | undefined, value: string): SearchClause {
  const clause: SearchClause = { param: def.code, type: def.type, conditions: [] };

  if (modifier === 'missing') {
    if (value !== 'true' && value !== 'false') throw FhirError.invalid(`${def.code}:missing must be true or false`);
    if (def.type === 'id' || def.type === 'lastUpdated') throw FhirError.invalid(`${def.code}:missing is not supported`);
    clause.missing = value === 'true';
    return clause;
  }

  const bad = () => FhirError.invalid(`Modifier :${safeName(modifier)} is not supported for ${def.code} (${def.type})`);
  const parts = splitValues(value);

  switch (def.type) {
    case 'id':
    case 'token': {
      if (modifier === 'not' && def.type === 'token') clause.negate = true;
      else if (modifier !== undefined) throw bad();
      for (const part of parts) {
        const pieces = splitPipe(part);
        if (pieces.length === 1) {
          if (pieces[0] === '') throw FhirError.invalid(`Empty value for ${def.code}`);
          clause.conditions.push({ kind: 'token', code: pieces[0] });
        } else if (pieces.length === 2) {
          const [system, code] = pieces as [string, string];
          if (system === '' && code === '') throw FhirError.invalid(`Empty value for ${def.code}`);
          clause.conditions.push({
            kind: 'token',
            system: system === '' ? null : system,
            ...(code === '' ? {} : { code }),
          });
        } else throw FhirError.invalid(`Invalid token value for ${def.code}`);
      }
      return clause;
    }
    case 'string': {
      const mode = modifier === undefined ? 'prefix' : modifier === 'exact' ? 'exact' : modifier === 'contains' ? 'contains' : undefined;
      if (!mode) throw bad();
      for (const part of parts) {
        const raw = unescape(part);
        if (raw.trim() === '') throw FhirError.invalid(`Empty value for ${def.code}`);
        clause.conditions.push({ kind: 'string', mode, value: mode === 'exact' ? raw : normalizeString(raw) });
      }
      return clause;
    }
    case 'date':
    case 'lastUpdated': {
      if (modifier !== undefined) throw bad();
      for (const part of parts) {
        const [prefix, v] = prefixed(part);
        const range = dateRange(v);
        if (!range) throw FhirError.invalid(`Invalid date for ${def.code}`);
        clause.conditions.push({ kind: 'date', prefix, ...range });
      }
      return clause;
    }
    case 'number': {
      if (modifier !== undefined) throw bad();
      for (const part of parts) {
        const [prefix, v] = prefixed(part);
        const range = numberRange(v);
        if (!range) throw FhirError.invalid(`Invalid number for ${def.code}`);
        clause.conditions.push({ kind: 'number', prefix, ...range });
      }
      return clause;
    }
    case 'quantity': {
      if (modifier !== undefined) throw bad();
      for (const part of parts) {
        const [num, system, code, ...rest] = splitPipe(part);
        if (rest.length) throw FhirError.invalid(`Invalid quantity for ${def.code}`);
        const [prefix, v] = prefixed(num!);
        const range = numberRange(v);
        if (!range) throw FhirError.invalid(`Invalid quantity for ${def.code}`);
        clause.conditions.push({
          kind: 'quantity',
          prefix,
          ...range,
          ...(system === undefined ? {} : { system: system === '' ? null : system }),
          ...(code ? { code } : {}),
        });
      }
      return clause;
    }
    case 'reference': {
      let typeModifier: string | undefined;
      if (modifier !== undefined) {
        if (!/^[A-Z][A-Za-z]+$/.test(modifier)) throw bad();
        if (def.targets && !def.targets.includes(modifier)) {
          throw FhirError.invalid(`${def.code} can't point to ${modifier} (allowed: ${def.targets.join(', ')})`);
        }
        typeModifier = modifier;
      }
      for (const part of parts) {
        const raw = unescape(part).trim();
        if (raw === '') throw FhirError.invalid(`Empty value for ${def.code}`);
        if (raw.startsWith('urn:')) {
          clause.conditions.push({ kind: 'reference', reference: raw });
          continue;
        }
        const parsed = parseReference(raw);
        if (parsed) {
          if (typeModifier && parsed.targetType !== typeModifier) throw FhirError.invalid(`Conflicting types in ${def.code}`);
          clause.conditions.push({ kind: 'reference', ...parsed });
        } else if (/^[A-Za-z0-9\-.]{1,64}$/.test(raw)) {
          // A bare id: of the modifier's type, or the only allowed target type, or any type.
          const only = def.targets?.length === 1 ? def.targets[0] : undefined;
          const targetType = typeModifier ?? only;
          clause.conditions.push({ kind: 'reference', targetId: raw, ...(targetType ? { targetType } : {}) });
        } else {
          throw FhirError.invalid(`Invalid reference for ${def.code}`);
        }
      }
      return clause;
    }
    case 'uri': {
      if (modifier !== undefined) throw bad();
      for (const part of parts) clause.conditions.push({ kind: 'uri', value: unescape(part) });
      return clause;
    }
  }
}

export { BUILT_IN_PARAMETERS };

import type { CompiledSearchParameter, PathStep, SearchParameterTable } from './types.js';
import { dateRange, normalizeString, parseReference } from './values.js';

/**
 * One searchable value of a resource. Storage adapters persist these in
 * index tables, written in the same transaction as the resource.
 *
 * Index rows are copies of resource data and may hold PHI (names, birth dates,
 * identifiers). They must be removed with the resource on expunge.
 */
export type IndexRow =
  | { kind: 'string'; param: string; valueNorm: string; valueExact: string }
  | { kind: 'token'; param: string; system: string | null; code: string }
  | { kind: 'date'; param: string; low: string | null; high: string | null }
  | { kind: 'reference'; param: string; targetType: string | null; targetId: string | null; reference: string }
  | { kind: 'number'; param: string; value: string }
  | { kind: 'quantity'; param: string; value: string; system: string | null; code: string | null }
  | { kind: 'uri'; param: string; value: string };

/** Search policy per parameter, keyed `ResourceType.code` (e.g. `Patient.birthdate`). */
export type SearchPolicy = 'plaintext' | 'blind' | 'none';

/** Parameters answered from the resource table itself, not from index rows. */
export const BUILT_IN_PARAMETERS = new Set(['_id', '_lastUpdated']);

type Value = { value: unknown; type: string | undefined };

/** Evaluates a compiled path over a resource: every value it selects, with its FHIR type. */
export function evaluatePath(resource: unknown, steps: readonly PathStep[]): Value[] {
  let current: Value[] = [{ value: resource, type: undefined }];
  for (const step of steps) {
    const next: Value[] = [];
    for (const { value } of current) {
      if (value === null || typeof value !== 'object') continue;
      const obj = value as Record<string, unknown>;
      const take = (raw: unknown, type: string | undefined) => {
        for (const item of Array.isArray(raw) ? raw : [raw]) {
          if (item === undefined || item === null) continue;
          if (step.where && !passes(item, step.where)) continue;
          next.push({ value: item, type });
        }
      };
      if (step.choice) {
        for (const [key, type] of Object.entries(step.choice)) {
          if (key in obj) take(obj[key], type);
        }
      } else {
        take(obj[step.f], step.t);
      }
    }
    current = next;
  }
  return current;
}

function passes(item: unknown, where: NonNullable<PathStep['where']>): boolean {
  if (item === null || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  if ('resolveIs' in where) {
    const ref = typeof obj.reference === 'string' ? parseReference(obj.reference) : undefined;
    return ref?.targetType === where.resolveIs || obj.type === where.resolveIs;
  }
  return obj[where.field] === where.equals;
}

/** Index rows for one parameter. Values the parameter type can't index are skipped. */
export function indexParameter(resource: unknown, param: CompiledSearchParameter): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const path of param.paths) {
    for (const v of evaluatePath(resource, path)) rows.push(...toRows(param, v));
  }
  return dedupe(rows);
}

/**
 * All index rows for a resource, honoring the search policy. `_id` and
 * `_lastUpdated` are not indexed: storage answers them from its own columns.
 */
export function extractIndexRows(
  resource: { resourceType: string },
  table: SearchParameterTable,
  policy: (resourceType: string, code: string) => SearchPolicy,
): IndexRow[] {
  const params = table[resource.resourceType] ?? [];
  const rows: IndexRow[] = [];
  for (const param of params) {
    if (BUILT_IN_PARAMETERS.has(param.code)) continue;
    if (policy(resource.resourceType, param.code) === 'none') continue;
    rows.push(...indexParameter(resource, param));
  }
  return rows;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.length > 0 ? x : undefined;
}

function toRows(param: CompiledSearchParameter, { value, type }: Value): IndexRow[] {
  const p = param.code;
  const o = (value ?? {}) as Record<string, unknown>;
  switch (param.type) {
    case 'string': {
      const parts: unknown[] =
        type === 'HumanName'
          ? [o.text, o.family, ...arr(o.given), ...arr(o.prefix), ...arr(o.suffix)]
          : type === 'Address'
            ? [o.text, ...arr(o.line), o.city, o.district, o.state, o.postalCode, o.country]
            : [value];
      return parts
        .map(str)
        .filter((s): s is string => s !== undefined)
        .map((s) => ({ kind: 'string', param: p, valueNorm: normalizeString(s), valueExact: s }));
    }
    case 'token': {
      switch (type) {
        case 'Coding':
          return str(o.code) ? [{ kind: 'token', param: p, system: str(o.system) ?? null, code: o.code as string }] : [];
        case 'CodeableConcept':
          return arr(o.coding).flatMap((c) => toRows(param, { value: c, type: 'Coding' }));
        case 'Identifier':
          return str(o.value) ? [{ kind: 'token', param: p, system: str(o.system) ?? null, code: o.value as string }] : [];
        case 'ContactPoint':
          return str(o.value) ? [{ kind: 'token', param: p, system: null, code: o.value as string }] : [];
        default:
          if (typeof value === 'boolean') return [{ kind: 'token', param: p, system: null, code: String(value) }];
          return str(value) ? [{ kind: 'token', param: p, system: null, code: value as string }] : [];
      }
    }
    case 'date': {
      if (type === 'Period') {
        const start = str(o.start) ? dateRange(o.start as string) : undefined;
        const end = str(o.end) ? dateRange(o.end as string) : undefined;
        if (!start && !end) return [];
        return [{ kind: 'date', param: p, low: start?.low ?? null, high: end?.high ?? null }];
      }
      if (type === 'Timing') {
        return arr(o.event).flatMap((e) => toRows(param, { value: e, type: 'dateTime' }));
      }
      const range = str(value) ? dateRange(value as string) : undefined;
      return range ? [{ kind: 'date', param: p, low: range.low, high: range.high }] : [];
    }
    case 'reference': {
      const reference = type === 'Reference' ? str(o.reference) : str(value);
      if (!reference || reference.startsWith('#')) return []; // contained references aren't searchable
      const parsed = parseReference(reference);
      return [
        {
          kind: 'reference',
          param: p,
          targetType: parsed?.targetType ?? null,
          targetId: parsed?.targetId ?? null,
          reference,
        },
      ];
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [{ kind: 'number', param: p, value: String(value) }] : [];
    case 'quantity':
      return typeof o.value === 'number' && Number.isFinite(o.value)
        ? [{ kind: 'quantity', param: p, value: String(o.value), system: str(o.system) ?? null, code: str(o.code) ?? str(o.unit) ?? null }]
        : [];
    case 'uri':
      return str(value) ? [{ kind: 'uri', param: p, value: value as string }] : [];
  }
}

function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : x === undefined || x === null ? [] : [x];
}

function dedupe(rows: IndexRow[]): IndexRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

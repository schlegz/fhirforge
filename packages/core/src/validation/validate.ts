import { checkPrimitive } from './primitives.js';
import type { ElementRule, PrimitiveKind, ValidationTable } from './types.js';

/** One problem found in a resource: where it is and what's wrong. Never contains a value from the resource. */
export interface ValidationIssue {
  /** FHIRPath-style location, e.g. `Patient.name[0].given[1]` or `Observation.value[x]`. */
  path: string;
  message: string;
}

/** Validates a resource and returns its issues (empty when valid). */
export type Validator = (resource: unknown) => ValidationIssue[];

/** Stop after this many issues: enough to fix a resource, bounded for hostile input. */
export const MAX_ISSUES = 100;
/** Deeper nesting than this is rejected (recursive types like Extension and contained resources). */
export const MAX_DEPTH = 64;

/** Names from the input go into paths only if they look like FHIR element names (unknown keys could hold anything). */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const safeName = (name: string) => (SAFE_NAME.test(name) ? name : '(invalid name)');

interface CompiledType {
  rules: Map<string, ElementRule>;
  /** Required non-choice elements. */
  required: string[];
  /** Choice group (`value[x]`) → whether one variant is required. */
  choices: Map<string, boolean>;
}

class TooManyIssues extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Builds a validator from a version package's compiled rules. It checks
 * cardinality, element types, exactly one variant per choice element, required
 * code bindings, unknown elements and primitive formats. Extensions are open:
 * any `url` is accepted, but each extension must be a well-formed Extension.
 *
 * Not checked: invariants (FHIRPath constraints), profiles, reference targets,
 * bindings other than required ones on `code`, and codes from external code systems.
 */
export function createValidator(table: ValidationTable): Validator {
  const types = new Map<string, CompiledType>();
  for (const [name, elements] of Object.entries(table.types)) {
    const rules = new Map(Object.entries(elements));
    const required: string[] = [];
    const choices = new Map<string, boolean>();
    for (const [key, rule] of rules) {
      if (rule.choice) choices.set(rule.choice, (choices.get(rule.choice) ?? false) || (rule.min ?? 0) > 0);
      else if ((rule.min ?? 0) > 0) required.push(key);
    }
    types.set(name, { rules, required, choices });
  }
  const primitives = new Map<string, PrimitiveKind>(Object.entries(table.primitives));
  const valueSets = new Map(Object.entries(table.valueSets).map(([url, codes]) => [url, new Set(codes)]));
  const resources = new Set(table.resources);

  return (resource) => {
    const issues: ValidationIssue[] = [];
    const report = (path: string, message: string) => {
      issues.push({ path, message });
      if (issues.length >= MAX_ISSUES) throw new TooManyIssues();
    };

    /** Validates a resource (anything with a `resourceType`); `path` is where it sits, or empty at the root. */
    const visitResource = (value: unknown, path: string, depth: number) => {
      if (!isObject(value)) return report(path || 'Resource', 'must be a resource (a JSON object)');
      const rt = value.resourceType;
      if (typeof rt !== 'string' || !resources.has(rt)) {
        return report(path ? `${path}.resourceType` : 'resourceType', 'must be a known resource type');
      }
      visitObject(value, rt, path || rt, depth, true);
    };

    const visitObject = (value: unknown, typeName: string, path: string, depth: number, isResource = false) => {
      if (depth > MAX_DEPTH) return report(path, 'is nested too deeply');
      if (!isObject(value)) return report(path, 'must be a JSON object');
      const type = types.get(typeName);
      if (!type) return report(path, 'has a type this FHIR version does not define');

      // Properties set to `undefined` (common in TypeScript objects) are absent, as in JSON.
      const keys = Object.keys(value).filter((key) => value[key] !== undefined);
      if (!isResource && keys.length === 0) return report(path, 'must not be empty (an element needs a value or children)');

      const counts = new Map<string, number>();
      const groups = new Map<string, string[]>();
      for (const key of keys) {
        if (isResource && key === 'resourceType') continue;
        const base = key.startsWith('_') ? key.slice(1) : key;
        const rule = type.rules.get(base);
        const primitive = rule ? primitives.get(rule.t) : undefined;
        if (!rule || (key !== base && !primitive)) {
          report(`${path}.${safeName(key)}`, 'is not a known element');
          continue;
        }
        if (counts.has(base)) continue; // `x` and `_x` are checked together
        const count = primitive
          ? visitPrimitive(value, base, rule, primitive, `${path}.${base}`, depth)
          : visitComplex(value[base], rule, `${path}.${base}`, depth);
        counts.set(base, count);
        if (count > 0 && rule.choice) {
          const present = groups.get(rule.choice) ?? [];
          present.push(base);
          groups.set(rule.choice, present);
        }
      }

      for (const key of type.required) {
        if (!counts.get(key)) report(`${path}.${key}`, 'is required');
      }
      for (const [group, required] of type.choices) {
        const present = groups.get(group)?.length ?? 0;
        if (present > 1) report(`${path}.${group}`, 'must have only one variant');
        else if (present === 0 && required) report(`${path}.${group}`, 'is required');
      }
    };

    /** Checks `x` and its `_x` sibling. Returns how many values are present. */
    const visitPrimitive = (
      parent: Record<string, unknown>,
      name: string,
      rule: ElementRule,
      kind: PrimitiveKind,
      path: string,
      depth: number,
    ): number => {
      const value = parent[name];
      const ext = parent[`_${name}`];
      const single = rule.max === 1;
      const checkValue = (v: unknown, at: string) => {
        const reason = checkPrimitive(rule.t, kind, v);
        if (reason) return report(at, reason);
        if (rule.vs !== undefined && !valueSets.get(rule.vs)?.has(v as string)) {
          report(at, `is not a code from the required value set ${rule.vs}`);
        }
      };

      if (single) {
        if (Array.isArray(value) || Array.isArray(ext)) {
          report(path, 'must be a single value, not an array');
          return 1;
        }
        if (value !== undefined) checkValue(value, path);
        if (ext !== undefined) visitObject(ext, 'Element', path, depth + 1);
        return value !== undefined || ext !== undefined ? 1 : 0;
      }

      if (value !== undefined && !Array.isArray(value)) {
        report(path, 'must be an array');
        return 1;
      }
      if (ext !== undefined && !Array.isArray(ext)) {
        report(path, `extensions (_${name}) must be an array`);
        return 1;
      }
      const values = value as unknown[] | undefined;
      const exts = ext as unknown[] | undefined;
      if (values?.length === 0 || exts?.length === 0) report(path, 'must not be an empty array');
      if (values && exts && values.length !== exts.length) {
        report(path, `values and extensions (_${name}) must have the same length`);
      }
      const length = Math.max(values?.length ?? 0, exts?.length ?? 0);
      for (let i = 0; i < length; i++) {
        const v = values?.[i] ?? null;
        const e = exts?.[i] ?? null;
        const at = `${path}[${i}]`;
        if (v === null && e === null) report(at, 'must have a value or extensions');
        if (v !== null) checkValue(v, at);
        if (e !== null) visitObject(e, 'Element', at, depth + 1);
      }
      if (rule.max !== undefined && length > rule.max) report(path, `must have at most ${rule.max} values`);
      return length;
    };

    /** Checks a complex, backbone or resource element. Returns how many values are present. */
    const visitComplex = (value: unknown, rule: ElementRule, path: string, depth: number): number => {
      const visit = (v: unknown, at: string) =>
        rule.t === 'Resource' ? visitResource(v, at, depth + 1) : visitObject(v, rule.t, at, depth + 1);
      if (rule.max === 1) {
        if (Array.isArray(value)) {
          report(path, 'must be a single value, not an array');
          return 1;
        }
        visit(value, path);
        return 1;
      }
      if (!Array.isArray(value)) {
        report(path, 'must be an array');
        return 1;
      }
      if (value.length === 0) report(path, 'must not be an empty array');
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
      if (rule.max !== undefined && value.length > rule.max) report(path, `must have at most ${rule.max} values`);
      return value.length;
    };

    try {
      visitResource(resource, '', 0);
    } catch (err) {
      if (!(err instanceof TooManyIssues)) throw err;
    }
    return issues;
  };
}

import type { ElementRule, PrimitiveKind, ValidationTable } from '@fhirforge/core';
import {
  buildElementTree,
  type DefinitionSet,
  type ElementDefinitionType,
  type ElementNode,
  type StructureDefinition,
} from '@fhirforge/definitions';
import { capitalize, primitiveJsType, systemTypeToPrimitive } from './naming.js';

const FHIR_TYPE_EXT = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const ABSTRACT_RESOURCE_CODES = new Set(['Resource', 'DomainResource', 'MetadataResource', 'CanonicalResource']);

export interface CompiledValidation {
  table: {
    primitives: Record<string, PrimitiveKind>;
    types: Record<string, Record<string, ElementRule>>;
    valueSets: Record<string, string[]>;
    resources: string[];
  };
  /** `Element.path: reason` for required bindings the validator can't check (value set not expandable locally, or not on a `code`). */
  unvalidatedBindings: string[];
}

/**
 * Compiles the StructureDefinitions into validation rules: per type (complex
 * types, resources and their backbone elements), each JSON property with its
 * type, cardinality, choice group and required binding.
 */
export function compileValidation(defs: DefinitionSet): CompiledValidation {
  const primitives: Record<string, PrimitiveKind> = {};
  for (const sd of defs.primitiveTypes()) primitives[sd.type] = primitiveJsType(sd.type);

  const resources = defs.resources().filter((sd) => !sd.abstract);
  const resourceNames = new Set(resources.map((sd) => sd.type));
  const types: Record<string, Record<string, ElementRule>> = {};
  const valueSets: Record<string, string[]> = {};
  const unvalidated: string[] = [];
  const knownTypes = new Set([...defs.complexTypes().map((sd) => sd.type), ...Object.keys(primitives)]);

  const typeOf = (node: ElementNode, t: ElementDefinitionType, isResourceRoot: boolean): string => {
    const system = systemTypeToPrimitive(t.code);
    if (system) {
      // Resource.id is a FHIRPath string in the R4 definitions; it is an `id`.
      if (isResourceRoot && node.name === 'id' && primitives.id) return 'id';
      const ext = t.extension?.find((e) => e.url === FHIR_TYPE_EXT);
      const fhirType = (ext?.valueUrl ?? ext?.valueUri ?? ext?.valueString ?? system) as string;
      return primitives[fhirType] ? fhirType : system;
    }
    if (ABSTRACT_RESOURCE_CODES.has(t.code) || resourceNames.has(t.code)) return 'Resource';
    if (!knownTypes.has(t.code)) throw new Error(`${node.path}: unknown type ${t.code}`);
    return t.code;
  };

  const binding = (node: ElementNode, type: string): string | undefined => {
    const b = node.element.binding;
    if (b?.strength !== 'required' || !b.valueSet) return undefined;
    const url = b.valueSet.split('|')[0]!;
    if (type !== 'code') {
      unvalidated.push(`${node.path}: required binding on ${type} is not checked`);
      return undefined;
    }
    if (!valueSets[url]) {
      const codes = defs.expandValueSet(url);
      if (!codes?.length) {
        unvalidated.push(`${node.path}: value set ${url} can't be expanded locally`);
        return undefined;
      }
      valueSets[url] = codes;
    }
    return url;
  };

  const emit = (sd: StructureDefinition, isResource: boolean) => {
    const tree = buildElementTree(sd);
    const visit = (node: ElementNode, name: string, isRoot: boolean) => {
      const rules: Record<string, ElementRule> = {};
      for (const child of node.children) {
        const el = child.element;
        if (el.max === '0') continue;
        const min = el.min ?? 0;
        const card: Pick<ElementRule, 'min' | 'max'> = {
          ...(min > 0 ? { min } : {}),
          ...(el.max !== undefined && el.max !== '*' ? { max: Number(el.max) } : {}),
        };

        if (child.name.endsWith('[x]')) {
          const base = child.name.slice(0, -3);
          for (const t of el.type ?? []) {
            const type = typeOf(child, t, false);
            const vs = binding(child, type);
            rules[base + capitalize(t.code)] = { t: type, ...card, max: 1, choice: child.name, ...(vs ? { vs } : {}) };
          }
          continue;
        }
        if (el.contentReference) {
          rules[child.name] = { t: el.contentReference.slice(el.contentReference.indexOf('#') + 1), ...card };
          continue;
        }
        if (child.children.length > 0) {
          rules[child.name] = { t: child.path, ...card };
          visit(child, child.path, false);
          continue;
        }
        const declared = el.type ?? [];
        if (declared.length !== 1) throw new Error(`${child.path}: expected one type, got ${declared.length}`);
        const type = typeOf(child, declared[0]!, isRoot && isResource);
        const vs = binding(child, type);
        rules[child.name] = { t: type, ...card, ...(vs ? { vs } : {}) };
      }
      types[name] = rules;
    };
    visit(tree.root, sd.type, true);
  };

  for (const sd of defs.complexTypes()) emit(sd, false);
  for (const sd of resources) emit(sd, true);

  // Every type a rule points to must exist, or the validator would reject valid data.
  for (const [name, rules] of Object.entries(types)) {
    for (const [key, rule] of Object.entries(rules)) {
      if (rule.t !== 'Resource' && !types[rule.t] && !primitives[rule.t]) {
        throw new Error(`${name}.${key}: type ${rule.t} has no rules`);
      }
    }
  }

  return {
    table: { primitives, types, valueSets, resources: resources.map((sd) => sd.type) },
    unvalidatedBindings: [...new Set(unvalidated)].sort(),
  };
}

/** Renders the compiled rules as a TypeScript module for a version package. */
export function renderValidationModule(compiled: CompiledValidation, header: string): string {
  const { table } = compiled;
  const lines = [
    header,
    '',
    "import type { ValidationTable } from '@fhirforge/core';",
    '',
    '/** Compiled validation rules: primitive kinds, element rules per type, and required value sets. */',
    'export const validation: ValidationTable = {',
    `  primitives: ${JSON.stringify(table.primitives)},`,
    '  types: {',
  ];
  for (const [name, rules] of Object.entries(table.types)) lines.push(`    ${JSON.stringify(name)}: ${JSON.stringify(rules)},`);
  lines.push('  },', '  valueSets: {');
  for (const [url, codes] of Object.entries(table.valueSets).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${JSON.stringify(url)}: ${JSON.stringify(codes)},`);
  }
  lines.push('  },', `  resources: ${JSON.stringify(table.resources)},`, '};', '');
  lines.push("/** Required bindings the validator doesn't check, with the reason. */");
  lines.push(`export const unvalidatedBindings: readonly string[] = ${JSON.stringify(compiled.unvalidatedBindings, null, 2)};`, '');
  return lines.join('\n');
}

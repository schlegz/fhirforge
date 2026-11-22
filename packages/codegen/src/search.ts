import type { CompiledSearchParameter, PathStep, SearchParamType } from '@fhirforge/core';
import { buildElementTree, type DefinitionSet, type ElementTree, type SearchParameter } from '@fhirforge/definitions';
import { parseExpression, UnsupportedExpression, type RawPath } from './fhirpath.js';
import { capitalize, systemTypeToPrimitive } from './naming.js';

const FHIR_TYPE_EXT = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';

/** The FHIR type code of an element type, mapping FHIRPath system types (Resource.id) to their FHIR primitive. */
function typeCode(t: { code: string; extension?: Array<{ url: string; valueUrl?: string; valueUri?: string }> }): string {
  const system = systemTypeToPrimitive(t.code);
  if (!system) return t.code;
  const ext = t.extension?.find((e) => e.url === FHIR_TYPE_EXT);
  return ext?.valueUrl ?? ext?.valueUri ?? system;
}

class UnindexableLeaf extends UnsupportedExpression {}

/** Leaf FHIR types each search parameter type can index. */
const INDEXABLE: Record<SearchParamType, ReadonlySet<string>> = {
  string: new Set(['string', 'markdown', 'HumanName', 'Address']),
  token: new Set(['Coding', 'CodeableConcept', 'Identifier', 'ContactPoint', 'code', 'string', 'id', 'uri', 'boolean', 'canonical']),
  date: new Set(['date', 'dateTime', 'instant', 'Period', 'Timing']),
  reference: new Set(['Reference', 'canonical', 'uri']),
  quantity: new Set(['Quantity', 'Age', 'Duration', 'Distance', 'Count', 'SimpleQuantity']),
  number: new Set(['integer', 'decimal', 'positiveInt', 'unsignedInt']),
  uri: new Set(['uri', 'url', 'canonical', 'oid', 'uuid']),
};

export interface CompiledSearch {
  /** Resource type → compiled parameters, sorted by code. */
  table: Record<string, CompiledSearchParameter[]>;
  /** Resource type → `code: reason` for parameters that could not be compiled. */
  unsupported: Record<string, string[]>;
}

/**
 * Compiles every SearchParameter in the definitions into path steps, per
 * resource type. Parameters (or the parts of an expression) that fall outside
 * the supported FHIRPath subset are reported in `unsupported`, never guessed.
 */
export function compileSearchParameters(defs: DefinitionSet): CompiledSearch {
  const resources = defs.resources().filter((sd) => !sd.abstract);
  const resourceNames = new Set(resources.map((sd) => sd.type));
  // Bundle, Binary and Parameters derive from Resource, not DomainResource.
  const domainResources = resources
    .filter((sd) => sd.baseDefinition === 'http://hl7.org/fhir/StructureDefinition/DomainResource')
    .map((sd) => sd.type);
  const trees = new Map<string, ElementTree>();
  const treeFor = (type: string): ElementTree | undefined => {
    if (!trees.has(type)) {
      const sd = defs.getStructureDefinition(type);
      if (!sd?.snapshot) return undefined;
      trees.set(type, buildElementTree(sd));
    }
    return trees.get(type);
  };

  const table: Record<string, CompiledSearchParameter[]> = {};
  const unsupported: Record<string, string[]> = {};
  const byResource = new Map<string, Map<string, SearchParameter>>();

  // One definition per (resource, code). Later duplicates (e.g. profiles' params) don't override the base ones.
  for (const sp of defs.searchParameters) {
    const bases = sp.base.flatMap((b) =>
      b === 'Resource' ? [...resourceNames] : b === 'DomainResource' ? domainResources : [b],
    );
    for (const base of bases) {
      if (!resourceNames.has(base)) continue;
      let codes = byResource.get(base);
      if (!codes) byResource.set(base, (codes = new Map()));
      if (!codes.has(sp.code)) codes.set(sp.code, sp);
    }
  }

  for (const resourceType of [...byResource.keys()].sort()) {
    const compiled: CompiledSearchParameter[] = [];
    const skipped: string[] = [];
    for (const [code, sp] of [...byResource.get(resourceType)!.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!(sp.type in INDEXABLE)) {
        skipped.push(`${code}: ${sp.type} parameters are not supported yet`);
        continue;
      }
      if (!sp.expression) {
        skipped.push(`${code}: no expression`);
        continue;
      }
      try {
        const parts = parseExpression(sp.expression).filter(
          (p) => p.root === resourceType || p.root === 'Resource' || p.root === 'DomainResource',
        );
        if (parts.length === 0) throw new UnsupportedExpression(`no path applies to ${resourceType}`);
        const type = sp.type as SearchParamType;
        // A part whose value type can't be indexed for this parameter type (e.g. quantity
        // search on SampledData) is dropped and reported; the other parts still work.
        const paths: PathStep[][] = [];
        for (const p of parts) {
          try {
            paths.push(resolvePath(resourceType, p, type, treeFor));
          } catch (err) {
            if (!(err instanceof UnindexableLeaf)) throw err;
            skipped.push(`${code} (partly): ${err.message}`);
          }
        }
        if (paths.length === 0) throw new UnsupportedExpression(`no indexable path for ${resourceType}`);
        const param: CompiledSearchParameter = { code, type, paths };
        // Omit targets when the parameter may point at any resource type. ("Any" lists in the
        // spec leave out Parameters, which can't be the target of a reference.)
        const anyTarget = [...resourceNames].every((r) => r === 'Parameters' || sp.target?.includes(r));
        if (type === 'reference' && sp.target?.length && !anyTarget) {
          param.targets = [...sp.target].sort();
        }
        compiled.push(param);
      } catch (err) {
        if (!(err instanceof UnsupportedExpression)) throw err;
        skipped.push(`${code}: ${err.message}`);
      }
    }
    if (compiled.length) table[resourceType] = compiled;
    if (skipped.length) unsupported[resourceType] = skipped;
  }
  return { table, unsupported };
}

function resolvePath(
  resourceType: string,
  raw: RawPath,
  paramType: SearchParamType,
  treeFor: (type: string) => ElementTree | undefined,
): PathStep[] {
  let tree = treeFor(resourceType)!;
  let at = resourceType; // element path in `tree` of the current context
  const steps: PathStep[] = [];
  let leafTypes: string[] = [resourceType];

  for (let i = 0; i < raw.steps.length; i++) {
    const step = raw.steps[i]!;
    switch (step.kind) {
      case 'field': {
        if (leafTypes.length !== 1) throw new UnsupportedExpression(`field ${step.name} after a choice without a cast`);
        let node = tree.byPath.get(`${at}.${step.name}`);
        if (node?.element.contentReference) {
          const target = node.element.contentReference.slice(node.element.contentReference.indexOf('#') + 1);
          const resolved = tree.byPath.get(target);
          if (!resolved) throw new UnsupportedExpression(`contentReference ${target} not found`);
          steps.push({ f: step.name });
          at = resolved.path;
          leafTypes = [resolved.element.type?.[0]?.code ?? 'BackboneElement'];
          node = undefined;
          break;
        }
        if (node) {
          const types = node.element.type ?? [];
          if (node.children.length > 0) {
            steps.push({ f: step.name });
            at = node.path;
            leafTypes = ['BackboneElement'];
          } else {
            const t = types[0] ? typeCode(types[0]) : undefined;
            if (!t || types.length !== 1) throw new UnsupportedExpression(`${node.path} has ${types.length} types`);
            steps.push({ f: step.name, t });
            leafTypes = [t];
            const dt = treeFor(t);
            if (dt) {
              tree = dt;
              at = t;
            }
          }
          break;
        }
        const choice = tree.byPath.get(`${at}.${step.name}[x]`);
        if (!choice) throw new UnsupportedExpression(`${at}.${step.name} does not exist`);
        const variants = (choice.element.type ?? []).map((t) => t.code);
        const next = raw.steps[i + 1];
        if (next?.kind === 'cast') {
          if (!variants.includes(next.type)) throw new UnsupportedExpression(`${choice.path} has no ${next.type} variant`);
          steps.push({ f: step.name + capitalize(next.type), t: next.type });
          leafTypes = [next.type];
          const dt = treeFor(next.type);
          if (dt) {
            tree = dt;
            at = next.type;
          }
          i++; // the cast is consumed
        } else {
          const map: Record<string, string> = {};
          for (const v of variants) {
            if (INDEXABLE[paramType].has(v)) map[step.name + capitalize(v)] = v;
          }
          if (Object.keys(map).length === 0) throw new UnsupportedExpression(`no ${paramType}-indexable variant of ${choice.path}`);
          steps.push({ f: step.name, choice: map });
          leafTypes = Object.values(map);
        }
        break;
      }
      case 'cast': {
        // A cast on a non-choice field: allowed only when it doesn't change the type.
        if (leafTypes.length === 1 && leafTypes[0] === step.type) break;
        throw new UnsupportedExpression(`cast to ${step.type} here is not supported`);
      }
      case 'where-resolve': {
        const last = steps[steps.length - 1];
        if (!last || leafTypes.some((t) => t !== 'Reference')) throw new UnsupportedExpression('resolve() on a non-Reference');
        last.where = { resolveIs: step.type };
        break;
      }
      case 'where-equals': {
        const last = steps[steps.length - 1];
        if (!last) throw new UnsupportedExpression('where() without a field');
        if (!tree.byPath.has(`${at}.${step.field}`)) throw new UnsupportedExpression(`${at}.${step.field} does not exist`);
        last.where = { field: step.field, equals: step.value };
        break;
      }
    }
  }

  if (steps.length === 0) throw new UnsupportedExpression('expression selects the resource itself');
  const bad = leafTypes.filter((t) => !INDEXABLE[paramType].has(t));
  if (bad.length === leafTypes.length) throw new UnindexableLeaf(`${paramType} search on ${bad.join('/')} is not supported`);
  return steps;
}

/** Renders the compiled table as a TypeScript module for a version package. */
export function renderSearchModule(compiled: CompiledSearch, header: string): string {
  const lines = [
    header,
    '',
    "import type { SearchParameterTable } from '@fhirforge/core';",
    '',
    '/** Compiled search parameters, per resource type. */',
    'export const searchParameters: SearchParameterTable = {',
  ];
  for (const [resourceType, params] of Object.entries(compiled.table)) {
    lines.push(`  ${resourceType}: [`);
    for (const p of params) lines.push(`    ${JSON.stringify(p)},`);
    lines.push('  ],');
  }
  lines.push('};', '');
  lines.push('/** Search parameters in the definitions that are not supported yet, with the reason. */');
  lines.push('export const unsupportedSearchParameters: Readonly<Record<string, readonly string[]>> = {');
  for (const [resourceType, reasons] of Object.entries(compiled.unsupported)) {
    lines.push(`  ${resourceType}: ${JSON.stringify(reasons)},`);
  }
  lines.push('};', '');
  return lines.join('\n');
}

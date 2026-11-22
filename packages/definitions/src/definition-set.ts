import type {
  CodeSystem,
  CodeSystemConcept,
  SearchParameter,
  StructureDefinition,
  ValueSet,
} from './types.js';

/** Strips a `|version` suffix from a canonical URL. */
export function stripVersion(canonical: string): string {
  const i = canonical.indexOf('|');
  return i === -1 ? canonical : canonical.slice(0, i);
}

export interface ExpandOptions {
  /** Give up (return undefined) when the value set has more codes than this. */
  maxCodes?: number;
}

/**
 * An indexed set of FHIR conformance resources for one FHIR version.
 */
export class DefinitionSet {
  readonly structureDefinitions = new Map<string, StructureDefinition>();
  readonly valueSets = new Map<string, ValueSet>();
  readonly codeSystems = new Map<string, CodeSystem>();
  readonly searchParameters: SearchParameter[] = [];
  /** Conformance resources that were skipped because they are malformed (e.g. a SearchParameter with no base). */
  readonly skipped: Array<{ resourceType: string; id?: string; url?: string; reason: string }> = [];
  private readonly byName = new Map<string, StructureDefinition>();

  constructor(readonly fhirVersion: string) {}

  add(resource: { resourceType?: string; [key: string]: unknown }): void {
    switch (resource.resourceType) {
      case 'StructureDefinition': {
        const sd = resource as unknown as StructureDefinition;
        if (!sd.url) return;
        this.structureDefinitions.set(sd.url, sd);
        // Base definitions are addressable by their type name (Patient, HumanName, string).
        if (sd.derivation !== 'constraint' && sd.kind !== 'logical') {
          this.byName.set(sd.type, sd);
        }
        break;
      }
      case 'ValueSet': {
        const vs = resource as unknown as ValueSet;
        if (vs.url) this.valueSets.set(vs.url, vs);
        break;
      }
      case 'CodeSystem': {
        const cs = resource as unknown as CodeSystem;
        if (cs.url) this.codeSystems.set(cs.url, cs);
        break;
      }
      case 'SearchParameter': {
        const sp = resource as unknown as SearchParameter;
        if (!Array.isArray(sp.base) || sp.base.length === 0 || !sp.code) {
          this.skipped.push({ resourceType: 'SearchParameter', id: sp.id, url: sp.url, reason: 'missing base or code' });
          break;
        }
        this.searchParameters.push(sp);
        break;
      }
      default:
        break;
    }
  }

  /** Looks up a StructureDefinition by canonical URL or by base type name. */
  getStructureDefinition(urlOrName: string): StructureDefinition | undefined {
    return this.structureDefinitions.get(stripVersion(urlOrName)) ?? this.byName.get(urlOrName);
  }

  private base(kind: StructureDefinition['kind']): StructureDefinition[] {
    return [...this.byName.values()]
      .filter((sd) => sd.kind === kind)
      .sort((a, b) => a.type.localeCompare(b.type));
  }

  /** Concrete and abstract resource definitions (base spec, not profiles). */
  resources(): StructureDefinition[] {
    return this.base('resource');
  }

  complexTypes(): StructureDefinition[] {
    return this.base('complex-type');
  }

  primitiveTypes(): StructureDefinition[] {
    return this.base('primitive-type');
  }

  /** Profiles: StructureDefinitions that constrain another definition. */
  profiles(): StructureDefinition[] {
    return [...this.structureDefinitions.values()].filter((sd) => sd.derivation === 'constraint');
  }

  searchParametersFor(resourceType: string): SearchParameter[] {
    return this.searchParameters.filter(
      (sp) => sp.base.includes(resourceType) || sp.base.includes('Resource') || sp.base.includes('DomainResource'),
    );
  }

  /**
   * Expands a value set into its codes, using only what ships in the package
   * (no terminology server). Returns undefined when the codes can't be fully
   * determined locally: filters, external code systems, incomplete code systems,
   * or more codes than `maxCodes`.
   */
  expandValueSet(canonical: string, options: ExpandOptions = {}): string[] | undefined {
    const codes = this.expandInner(stripVersion(canonical), new Set());
    if (!codes) return undefined;
    const unique = [...new Set(codes)];
    if (options.maxCodes !== undefined && unique.length > options.maxCodes) return undefined;
    return unique;
  }

  private expandInner(url: string, seen: Set<string>): string[] | undefined {
    if (seen.has(url)) return [];
    seen.add(url);
    const vs = this.valueSets.get(url);
    if (!vs) return undefined;

    if (vs.expansion?.contains?.length) {
      const out: string[] = [];
      const walk = (items: Array<{ code?: string; contains?: unknown[] }>) => {
        for (const item of items) {
          if (item.code) out.push(item.code);
          if (item.contains) walk(item.contains as Array<{ code?: string; contains?: unknown[] }>);
        }
      };
      walk(vs.expansion.contains);
      return out;
    }

    if (!vs.compose?.include?.length) return undefined;
    if (vs.compose.exclude?.length) return undefined;

    const out: string[] = [];
    for (const include of vs.compose.include) {
      if (include.filter?.length) return undefined;
      if (include.valueSet?.length) {
        if (include.system || include.concept) return undefined; // intersection semantics: not supported
        for (const nested of include.valueSet) {
          const codes = this.expandInner(stripVersion(nested), seen);
          if (!codes) return undefined;
          out.push(...codes);
        }
        continue;
      }
      if (include.concept?.length) {
        out.push(...include.concept.map((c) => c.code));
        continue;
      }
      if (!include.system) return undefined;
      const cs = this.codeSystems.get(include.system);
      if (!cs || cs.content !== 'complete' || !cs.concept) return undefined;
      out.push(...flattenConcepts(cs.concept));
    }
    return out;
  }
}

function flattenConcepts(concepts: CodeSystemConcept[]): string[] {
  const out: string[] = [];
  for (const c of concepts) {
    out.push(c.code);
    if (c.concept) out.push(...flattenConcepts(c.concept));
  }
  return out;
}

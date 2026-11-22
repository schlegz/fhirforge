import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DefinitionSet } from './definition-set.js';
import { ensurePackage, type FetchPackageOptions } from './fetch.js';

export type DefinitionSource =
  /** A FHIR package from the registry (cached in ~/.fhir/packages), e.g. hl7.fhir.r4.core@4.0.1. */
  | ({ kind: 'package'; name: string; version: string } & FetchPackageOptions)
  /**
   * A local folder of FHIR JSON: an extracted FHIR package (one resource per file)
   * or the spec's definition bundles (profiles-resources.json, valuesets.json, ...).
   */
  | { kind: 'directory'; path: string; fhirVersion?: string };

const RELEVANT = new Set(['StructureDefinition', 'ValueSet', 'CodeSystem', 'SearchParameter']);

/** Parses `name@version` (e.g. `hl7.fhir.r4.core@4.0.1`). */
export function parsePackageSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) throw new Error(`Expected name@version, got "${spec}"`);
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export async function loadDefinitions(source: DefinitionSource): Promise<DefinitionSet> {
  if (source.kind === 'package') {
    const dir = await ensurePackage(source.name, source.version, source);
    return loadDirectory(dir);
  }
  return loadDirectory(source.path, source.fhirVersion);
}

async function loadDirectory(path: string, fhirVersion?: string): Promise<DefinitionSet> {
  const files = await listJsonFiles(path);
  let version = fhirVersion;
  const resources: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (file.endsWith('package.json') && !json.resourceType) {
      const fv = (json.fhirVersions as string[] | undefined)?.[0] ?? (json['fhir-version-list'] as string[] | undefined)?.[0];
      version ??= fv;
      continue;
    }
    collect(json, resources);
  }

  version ??= resources.find((r) => r.resourceType === 'StructureDefinition' && r.fhirVersion)?.fhirVersion as
    | string
    | undefined;
  const set = new DefinitionSet(version ?? 'unknown');
  for (const r of resources) set.add(r);
  if (set.structureDefinitions.size === 0) {
    throw new Error(`No StructureDefinitions found in ${path}`);
  }
  return set;
}

function collect(json: Record<string, unknown>, out: Array<Record<string, unknown>>): void {
  const type = json.resourceType as string | undefined;
  if (type === 'Bundle') {
    for (const entry of (json.entry as Array<{ resource?: Record<string, unknown> }> | undefined) ?? []) {
      if (entry.resource) collect(entry.resource, out);
    }
    return;
  }
  if (type && RELEVANT.has(type)) out.push(json);
}

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip example folders and nested test data in FHIR packages.
      if (entry.name === 'example' || entry.name === 'examples' || entry.name === 'testing' || entry.name === 'other') continue;
      out.push(...(await listJsonFiles(full)));
    } else if (entry.name.endsWith('.json') && entry.name !== '.index.json') {
      out.push(full);
    }
  }
  return out.sort();
}

import { beforeAll, describe, expect, it } from 'vitest';
import { buildElementTree, loadDefinitions, parsePackageSpec, type DefinitionSet } from '../src/index.js';
import { r4Source } from './source.js';

let defs: DefinitionSet;
beforeAll(async () => {
  defs = await loadDefinitions(r4Source);
});

describe('loadDefinitions (R4)', () => {
  it('reads the FHIR version', () => {
    expect(defs.fhirVersion).toBe('4.0.1');
  });

  it('indexes base resources, datatypes and primitives', () => {
    const resources = defs.resources().map((sd) => sd.type);
    expect(resources).toContain('Patient');
    expect(resources).toContain('Observation');
    expect(resources.length).toBeGreaterThanOrEqual(145);
    expect(defs.complexTypes().map((sd) => sd.type)).toEqual(expect.arrayContaining(['HumanName', 'Reference', 'Quantity']));
    expect(defs.primitiveTypes().map((sd) => sd.type)).toEqual(expect.arrayContaining(['string', 'dateTime', 'boolean']));
  });

  it('finds definitions by name and by canonical URL', () => {
    const byName = defs.getStructureDefinition('Patient');
    const byUrl = defs.getStructureDefinition('http://hl7.org/fhir/StructureDefinition/Patient|4.0.1');
    expect(byName).toBeDefined();
    expect(byUrl).toBe(byName);
  });

  it('skips malformed search parameters instead of failing', () => {
    for (const sp of defs.searchParameters) {
      expect(Array.isArray(sp.base)).toBe(true);
    }
  });

  it('collects search parameters per resource', () => {
    const codes = defs.searchParametersFor('Patient').map((sp) => sp.code);
    expect(codes).toEqual(expect.arrayContaining(['name', 'birthdate', 'identifier', '_id']));
  });

  it('expands required value sets from local code systems', () => {
    expect(defs.expandValueSet('http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1')).toEqual([
      'male',
      'female',
      'other',
      'unknown',
    ]);
    // External code system (ISO 4217): cannot expand locally.
    expect(defs.expandValueSet('http://hl7.org/fhir/ValueSet/currencies')).toBeUndefined();
    expect(defs.expandValueSet('http://hl7.org/fhir/ValueSet/observation-status', { maxCodes: 3 })).toBeUndefined();
  });
});

describe('buildElementTree', () => {
  it('nests backbone elements under their parent', () => {
    const tree = buildElementTree(defs.getStructureDefinition('Patient')!);
    expect(tree.root.path).toBe('Patient');
    const contact = tree.byPath.get('Patient.contact')!;
    expect(contact.children.map((c) => c.name)).toEqual(
      expect.arrayContaining(['relationship', 'name', 'telecom', 'address', 'gender', 'organization', 'period']),
    );
    expect(tree.byPath.get('Patient.deceased[x]')!.element.type!.map((t) => t.code)).toEqual(['boolean', 'dateTime']);
  });
});

describe('parsePackageSpec', () => {
  it('splits name and version', () => {
    expect(parsePackageSpec('hl7.fhir.r4.core@4.0.1')).toEqual({ name: 'hl7.fhir.r4.core', version: '4.0.1' });
    expect(() => parsePackageSpec('hl7.fhir.r4.core')).toThrow();
  });
});

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDefinitions } from '@fhirforge/definitions';
import { r4Source } from '../../definitions/test/source.js';
import { generateTypes, type GeneratedFiles } from '../src/index.js';

const committedDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../r4/src/generated');

let generated: GeneratedFiles;
beforeAll(async () => {
  const defs = await loadDefinitions(r4Source);
  generated = generateTypes(defs);
});

const file = (path: string) => generated.files.get(path) ?? '';

describe('generateTypes (R4)', () => {
  it('emits one module per resource plus shared modules', () => {
    expect(generated.files.has('resources/Patient.ts')).toBe(true);
    expect(generated.files.has('resources/Observation.ts')).toBe(true);
    for (const shared of ['index.ts', 'primitives.ts', 'datatypes.ts', 'helpers.ts', 'resource-map.ts']) {
      expect(generated.files.has(shared)).toBe(true);
    }
    expect(generated.resourceTypes).not.toContain('DomainResource');
  });

  it('types required code bindings as literal unions', () => {
    expect(file('resources/Patient.ts')).toContain("gender?: 'male' | 'female' | 'other' | 'unknown';");
  });

  it('makes choice types exclusive', () => {
    expect(file('resources/Patient.ts')).toMatch(/OptionalOneOf<\{\n[^}]*deceasedBoolean: FhirBoolean;\n\s+deceasedDateTime: FhirDateTime;/);
  });

  it('narrows references to their target profiles', () => {
    expect(file('resources/Observation.ts')).toContain('subject?: Reference<Patient | Group | Device | Location>;');
  });

  it('adds _field siblings for primitives', () => {
    expect(file('resources/Patient.ts')).toContain('_birthDate?: Element;');
  });

  it('makes Reference generic', () => {
    expect(file('datatypes.ts')).toContain('export interface Reference<T extends Resource = Resource> {');
  });

  it('matches the committed output in packages/r4 (run `pnpm gen:r4` if this fails)', async () => {
    for (const [path, contents] of generated.files) {
      const committed = await readFile(join(committedDir, path), 'utf8').catch(() => '(missing)');
      expect(committed, path).toBe(contents);
    }
  });
});

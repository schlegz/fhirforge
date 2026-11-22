import { describe, expect, it } from 'vitest';
import { parseExpression, UnsupportedExpression } from '../src/fhirpath.js';

describe('parseExpression (FHIRPath subset)', () => {
  it('parses paths, unions, casts and where filters', () => {
    expect(parseExpression('Patient.name.family')).toEqual([
      { root: 'Patient', steps: [{ kind: 'field', name: 'name' }, { kind: 'field', name: 'family' }] },
    ]);
    expect(parseExpression('(Observation.value as Quantity) | Observation.component.value.ofType(Quantity)')).toEqual([
      { root: 'Observation', steps: [{ kind: 'field', name: 'value' }, { kind: 'cast', type: 'Quantity' }] },
      {
        root: 'Observation',
        steps: [
          { kind: 'field', name: 'component' },
          { kind: 'field', name: 'value' },
          { kind: 'cast', type: 'Quantity' },
        ],
      },
    ]);
    expect(parseExpression('Observation.subject.where(resolve() is Patient)')[0]!.steps[1]).toEqual({
      kind: 'where-resolve',
      type: 'Patient',
    });
    expect(parseExpression("Patient.telecom.where(system='phone')")[0]!.steps[1]).toEqual({
      kind: 'where-equals',
      field: 'system',
      value: 'phone',
    });
    expect(parseExpression('(Observation.value.ofType(CodeableConcept)).text')[0]!.steps).toEqual([
      { kind: 'field', name: 'value' },
      { kind: 'cast', type: 'CodeableConcept' },
      { kind: 'field', name: 'text' },
    ]);
  });

  it('rejects anything outside the subset instead of guessing', () => {
    for (const expr of [
      'Patient.deceased.exists() and Patient.deceased != false',
      "Patient.extension('http://x')",
      'Observation.value.where(value > 5)',
      'Patient.name.(given)',
    ]) {
      expect(() => parseExpression(expr), expr).toThrow(UnsupportedExpression);
    }
  });
});

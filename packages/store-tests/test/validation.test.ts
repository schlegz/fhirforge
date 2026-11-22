import { createValidator, MAX_DEPTH, MAX_ISSUES, type ValidationIssue } from '@fhirforge/core';
import { r4 } from '@fhirforge/r4';
import { describe, expect, it } from 'vitest';

// Synthetic data only (see CLAUDE.md).
const validator = createValidator(r4.validation!);
const validate = (resource: unknown): ValidationIssue[] => validator(resource);
const paths = (resource: unknown) => validate(resource).map((i) => i.path);
const messageAt = (resource: unknown, path: string) => validate(resource).find((i) => i.path === path)?.message;

describe('runtime validation (R4 rules)', () => {
  it('accepts valid resources', () => {
    expect(validate({ resourceType: 'Patient' })).toEqual([]);
    expect(
      validate({
        resourceType: 'Patient',
        id: 'pat-1',
        meta: { versionId: '3', lastUpdated: '2026-11-20T09:30:00Z' },
        name: [{ family: 'Doe', given: ['Jane', 'Q'] }],
        gender: 'female',
        birthDate: '1974-12-25',
        deceasedBoolean: false,
        telecom: [{ system: 'phone', value: '555-0100' }],
        contact: [{ name: { family: 'Doe' }, relationship: [{ text: 'sibling' }] }],
      }),
    ).toEqual([]);
    expect(
      validate({
        resourceType: 'Observation',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
        valueQuantity: { value: 72, unit: 'beats/minute' },
        effectiveDateTime: '2026-11-20T09:30:00-08:00',
      }),
    ).toEqual([]);
  });

  it('rejects unknown elements, without echoing names that could hold data', () => {
    expect(paths({ resourceType: 'Patient', nickname: 'x' })).toEqual(['Patient.nickname']);
    expect(paths({ resourceType: 'Patient', name: [{ family: 'Doe', surname: 'x' }] })).toEqual(['Patient.name[0].surname']);
    const issues = validate({ resourceType: 'Patient', 'Synthetic Jane Doe 1974': true });
    expect(issues).toEqual([{ path: 'Patient.(invalid name)', message: 'is not a known element' }]);
    expect(JSON.stringify(issues)).not.toContain('Synthetic');
  });

  it("doesn't mistake object prototype keys for elements", () => {
    expect(paths(JSON.parse('{"resourceType":"Patient","__proto__":{"x":1},"constructor":1,"toString":"x"}'))).toEqual([
      'Patient.__proto__',
      'Patient.constructor',
      'Patient.toString',
    ]);
    expect(paths({ resourceType: 'hasOwnProperty' })).toEqual(['resourceType']);
  });

  it('checks the resource type', () => {
    expect(paths({ resourceType: 'Patients' })).toEqual(['resourceType']);
    expect(paths({})).toEqual(['resourceType']);
    expect(paths(null)).toEqual(['Resource']);
    expect(paths([{ resourceType: 'Patient' }])).toEqual(['Resource']);
  });

  it('checks cardinality: required elements, arrays and single values', () => {
    expect(paths({ resourceType: 'Observation' })).toEqual(['Observation.status', 'Observation.code']);
    expect(messageAt({ resourceType: 'Observation', code: { text: 'hr' } }, 'Observation.status')).toBe('is required');
    expect(messageAt({ resourceType: 'Patient', gender: ['female'] }, 'Patient.gender')).toBe('must be a single value, not an array');
    expect(messageAt({ resourceType: 'Patient', name: { family: 'Doe' } }, 'Patient.name')).toBe('must be an array');
    expect(messageAt({ resourceType: 'Patient', name: [] }, 'Patient.name')).toBe('must not be an empty array');
    expect(messageAt({ resourceType: 'Patient', maritalStatus: {} }, 'Patient.maritalStatus')).toMatch(/must not be empty/);
    expect(messageAt({ resourceType: 'Patient', name: [null] }, 'Patient.name[0]')).toBe('must be a JSON object');
  });

  it('treats properties set to undefined as absent', () => {
    expect(validate({ resourceType: 'Patient', gender: undefined, name: [{ family: 'Doe', given: undefined }] })).toEqual([]);
    expect(paths({ resourceType: 'Observation', status: undefined, code: { text: 'hr' } })).toEqual(['Observation.status']);
  });

  it('checks element types', () => {
    expect(messageAt({ resourceType: 'Patient', active: 'true' }, 'Patient.active')).toBe('must be a boolean (boolean)');
    expect(messageAt({ resourceType: 'Patient', birthDate: 19741225 }, 'Patient.birthDate')).toBe('must be a string (date)');
    expect(messageAt({ resourceType: 'Patient', name: ['Jane Doe'] }, 'Patient.name[0]')).toBe('must be a JSON object');
    expect(paths({ resourceType: 'Patient', multipleBirthInteger: 1.5 })).toEqual(['Patient.multipleBirthInteger']);
  });

  it('checks primitive formats', () => {
    expect(messageAt({ resourceType: 'Patient', birthDate: '1974-02-30' }, 'Patient.birthDate')).toMatch(/is not a valid date/);
    expect(paths({ resourceType: 'Patient', id: 'has space' })).toEqual(['Patient.id']);
    expect(paths({ resourceType: 'Patient', deceasedDateTime: '2026-11-20T09:30' })).toEqual(['Patient.deceasedDateTime']);
    expect(paths({ resourceType: 'Patient', name: [{ given: ['Jane', ''] }] })).toEqual(['Patient.name[0].given[1]']);
  });

  it('checks required code bindings', () => {
    const issue = validate({ resourceType: 'Patient', gender: 'synthetic-gender' })[0];
    expect(issue).toEqual({
      path: 'Patient.gender',
      message: 'is not a code from the required value set http://hl7.org/fhir/ValueSet/administrative-gender',
    });
    expect(paths({ resourceType: 'Observation', status: 'done', code: { text: 'hr' } })).toEqual(['Observation.status']);
    expect(paths({ resourceType: 'Patient', telecom: [{ system: 'pager-ish', value: '555-0100' }] })).toEqual([
      'Patient.telecom[0].system',
    ]);
  });

  it('allows only one variant per choice element, and requires one when the choice is required', () => {
    expect(validate({ resourceType: 'Patient', deceasedBoolean: true, deceasedDateTime: '2020' })).toEqual([
      { path: 'Patient.deceased[x]', message: 'must have only one variant' },
    ]);
    expect(paths({ resourceType: 'Patient', deceased: true })).toEqual(['Patient.deceased']);
    const med = { resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/p1' } };
    expect(validate(med)).toEqual([{ path: 'MedicationRequest.medication[x]', message: 'is required' }]);
    expect(validate({ ...med, medicationCodeableConcept: { text: 'synthetic' } })).toEqual([]);
  });

  it('accepts primitive extensions (_field), including aligned arrays with nulls', () => {
    const ext = { extension: [{ url: 'http://example.org/fhir/ext', valueString: 'x' }] };
    expect(validate({ resourceType: 'Patient', _birthDate: ext })).toEqual([]);
    expect(validate({ resourceType: 'Patient', birthDate: '1974', _birthDate: ext })).toEqual([]);
    expect(validate({ resourceType: 'Patient', name: [{ given: [null, 'Jane'], _given: [ext, null] }] })).toEqual([]);
    expect(paths({ resourceType: 'Patient', name: [{ given: [null, 'Jane'] }] })).toEqual(['Patient.name[0].given[0]']);
    expect(paths({ resourceType: 'Patient', name: [{ given: ['Jane'], _given: [null, ext] }] })).toEqual(['Patient.name[0].given']);
    expect(paths({ resourceType: 'Patient', _name: ext })).toEqual(['Patient._name']);
    expect(paths({ resourceType: 'Patient', _birthDate: { bogus: 1 } })).toEqual(['Patient.birthDate.bogus']);
  });

  it('accepts any extension url, but checks the Extension structure', () => {
    expect(
      validate({
        resourceType: 'Patient',
        extension: [
          { url: 'http://example.org/fhir/StructureDefinition/anything', valueCode: 'x' },
          { url: 'urn:example:nested', extension: [{ url: 'part', valueInteger: 2 }] },
        ],
        modifierExtension: [{ url: 'http://example.org/fhir/StructureDefinition/mod', valueBoolean: true }],
      }),
    ).toEqual([]);
    expect(paths({ resourceType: 'Patient', extension: [{ valueString: 'x' }] })).toEqual(['Patient.extension[0].url']);
    expect(paths({ resourceType: 'Patient', extension: [{ url: 'u', valueString: 'x', valueCode: 'y' }] })).toEqual([
      'Patient.extension[0].value[x]',
    ]);
  });

  it('validates contained resources by their own type', () => {
    expect(
      validate({
        resourceType: 'Patient',
        contained: [{ resourceType: 'Practitioner', id: 'gp', name: [{ family: 'Doe' }] }],
        generalPractitioner: [{ reference: '#gp' }],
      }),
    ).toEqual([]);
    expect(paths({ resourceType: 'Patient', contained: [{ resourceType: 'Unknown' }] })).toEqual([
      'Patient.contained[0].resourceType',
    ]);
    expect(paths({ resourceType: 'Patient', contained: [{ resourceType: 'Observation', code: { text: 'x' } }] })).toEqual([
      'Patient.contained[0].status',
    ]);
    expect(paths({ resourceType: 'Patient', contained: [{ resourceType: 'Patient', bogus: 1 }] })).toEqual([
      'Patient.contained[0].bogus',
    ]);
  });

  it('follows backbone elements and content references (Questionnaire.item.item)', () => {
    const q = {
      resourceType: 'Questionnaire',
      status: 'draft',
      item: [{ linkId: '1', type: 'group', item: [{ linkId: '1.1', type: 'string' }, { type: 'string' }] }],
    };
    expect(paths(q)).toEqual(['Questionnaire.item[0].item[1].linkId']);
  });

  it('bounds nesting depth without overflowing the stack', () => {
    let ext: Record<string, unknown> = { url: 'u', valueString: 'leaf' };
    for (let i = 0; i < 20_000; i++) ext = { url: 'u', extension: [ext] };
    const issues = validate({ resourceType: 'Patient', extension: [ext] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe('is nested too deeply');
    // Levels 1..MAX_DEPTH are checked; the first one deeper is reported.
    expect(issues[0]!.path.split('.extension').length - 1).toBe(MAX_DEPTH + 1);
  });

  it('stops after MAX_ISSUES issues', () => {
    const resource: Record<string, unknown> = { resourceType: 'Patient' };
    for (let i = 0; i < 1000; i++) resource[`unknown${i}`] = i;
    expect(validate(resource)).toHaveLength(MAX_ISSUES);
  });

  it('never puts values from the resource into issues', () => {
    const secret = 'Synthetic-Secret-7c1e';
    const issues = validate({
      resourceType: 'Patient',
      gender: secret,
      birthDate: secret,
      id: secret + ' x',
      telecom: [{ system: secret, value: secret }],
      name: [{ family: 1, given: [secret, 2] }],
      extension: [{ url: `${secret} with spaces`, valueString: secret }],
    });
    expect(issues.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(issues)).not.toContain(secret);
  });
});

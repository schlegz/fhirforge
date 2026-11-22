import { createFhirStore, FhirError, type FhirStorage, type FhirVersionPackage } from '@fhirforge/core';
import { r4, type ResourceTypeMap } from '@fhirforge/r4';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md).
const RESOURCES = ['Patient', 'Observation', 'Encounter', 'MedicationRequest'] as const;
const makeStore = (storage: FhirStorage) => createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: RESOURCES });

async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

describe.each(backends)('search on $name', (backend) => {
  let fhir: ReturnType<typeof makeStore>;
  const ids: Record<string, string> = {};
  /** Search and return the ids of the matches, sorted, using the fixture names. */
  const find = async (type: (typeof RESOURCES)[number], params: Record<string, string | string[] | number>) => {
    const result = await fhir.search(type, params);
    const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    return result.resources.map((r) => names[r.id] ?? r.id).sort();
  };

  beforeAll(async () => {
    fhir = makeStore(await backend.storage());
    await fhir.migrate();
    const add = async (key: string, resource: Parameters<typeof fhir.create>[0]) => {
      ids[key] = (await fhir.create(resource)).id;
    };
    await add('jane', {
      resourceType: 'Patient',
      name: [{ family: 'Doe', given: ['Jane', 'Q'] }],
      gender: 'female',
      birthDate: '1974-12-25',
      identifier: [{ system: 'urn:mrn', value: 'A100' }],
      telecom: [
        { system: 'phone', value: '555-0100' },
        { system: 'email', value: 'jane@example.org' },
      ],
      address: [{ city: 'Walnut Creek', state: 'CA' }],
      active: true,
      meta: { profile: ['http://example.org/fhir/StructureDefinition/test-patient'] },
    });
    await add('john', {
      resourceType: 'Patient',
      name: [{ family: 'Doering', given: ['John'] }],
      gender: 'male',
      birthDate: '1980-03',
      identifier: [{ system: 'urn:other', value: 'A100' }],
      address: [{ city: 'Oakland' }],
    });
    await add('bene', {
      resourceType: 'Patient',
      name: [{ family: 'Marché', given: ['Bénédicte'] }],
      gender: 'female',
      birthDate: '1990-06-15',
      identifier: [{ value: 'NOSYS1' }],
    });
    await add('hostile', {
      resourceType: 'Patient',
      name: [{ family: "O'Brien'); DROP TABLE \"Patient\"; --", given: ['50%'] }],
      gender: 'unknown',
    });
    await add('bp', {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
      subject: { reference: `Patient/${ids.jane}` },
      effectiveDateTime: '2026-11-20T09:30:00-08:00',
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 120.2, system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
      ],
    });
    await add('weight', {
      resourceType: 'Observation',
      status: 'amended',
      code: { coding: [{ system: 'http://loinc.org', code: '29463-7' }] },
      subject: { reference: `Patient/${ids.john}` },
      effectivePeriod: { start: '2026-01-01', end: '2026-01-31' },
      valueQuantity: { value: 82.5, unit: 'kg', system: 'http://unitsofmeasure.org', code: 'kg' },
    });
    await add('groupObs', {
      resourceType: 'Observation',
      status: 'final',
      code: { text: 'Group note' },
      subject: { reference: `Group/${ids.jane}` }, // same id, different type
      valueString: 'Weekly summary',
    });
    await add('visit', {
      resourceType: 'Encounter',
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'VR' },
      subject: { reference: `Patient/${ids.jane}` },
      period: { start: '2026-11-20T09:00:00Z', end: '2026-11-20T09:20:00Z' },
    });
    await add('openVisit', {
      resourceType: 'Encounter',
      status: 'in-progress',
      class: { code: 'AMB' },
      subject: { reference: `Patient/${ids.john}` },
      period: { start: '2026-11-21T10:00:00Z' },
    });
    await add('rx', {
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '860975' }] },
      subject: { reference: `Patient/${ids.jane}` },
      encounter: { reference: `Encounter/${ids.visit}` },
      authoredOn: '2026-11-20',
    });
  });
  afterAll(() => backend.close());

  describe('string', () => {
    it('matches prefixes of any name part, ignoring case and accents', async () => {
      expect(await find('Patient', { family: 'doe' })).toEqual(['jane', 'john']);
      expect(await find('Patient', { name: 'jan' })).toEqual(['jane']);
      expect(await find('Patient', { given: 'benedicte' })).toEqual(['bene']);
      expect(await find('Patient', { 'address-city': 'walnut' })).toEqual(['jane']);
    });
    it('supports :exact and :contains', async () => {
      expect(await find('Patient', { 'family:exact': 'Doe' })).toEqual(['jane']);
      expect(await find('Patient', { 'family:exact': 'doe' })).toEqual([]);
      expect(await find('Patient', { 'family:contains': 'oer' })).toEqual(['john']);
    });
    it('treats SQL and LIKE wildcards in values as plain text', async () => {
      expect(await find('Patient', { family: "o'brien'); drop" })).toEqual(['hostile']);
      expect(await find('Patient', { given: '50%' })).toEqual(['hostile']);
      expect(await find('Patient', { given: '5_' })).toEqual([]);
      expect(await find('Patient', { family: '%' })).toEqual([]);
      // The table is still there.
      expect((await fhir.search('Patient', {})).total).toBe(4);
    });
  });

  describe('token', () => {
    it('matches codes, system|code, |code and system|', async () => {
      expect(await find('Patient', { gender: 'female' })).toEqual(['bene', 'jane']);
      expect(await find('Patient', { identifier: 'A100' })).toEqual(['jane', 'john']);
      expect(await find('Patient', { identifier: 'urn:mrn|A100' })).toEqual(['jane']);
      expect(await find('Patient', { identifier: '|NOSYS1' })).toEqual(['bene']);
      expect(await find('Patient', { identifier: 'urn:other|' })).toEqual(['john']);
      expect(await find('Observation', { code: 'http://loinc.org|85354-9' })).toEqual(['bp']);
    });
    it('applies where() filters from the definition (phone vs email)', async () => {
      expect(await find('Patient', { phone: '555-0100' })).toEqual(['jane']);
      expect(await find('Patient', { email: '555-0100' })).toEqual([]);
      expect(await find('Patient', { email: 'jane@example.org' })).toEqual(['jane']);
    });
    it('supports :not and booleans', async () => {
      expect(await find('Patient', { 'gender:not': 'female' })).toEqual(['hostile', 'john']);
      expect(await find('Patient', { active: 'true' })).toEqual(['jane']);
    });
  });

  describe('date', () => {
    it('uses the precision of both values', async () => {
      expect(await find('Patient', { birthdate: '1974' })).toEqual(['jane']);
      expect(await find('Patient', { birthdate: '1974-12-25' })).toEqual(['jane']);
      expect(await find('Patient', { birthdate: '1980-03-10' })).toEqual([]); // resource is the whole month
      expect(await find('Patient', { birthdate: 'ge1980-03-10' })).toEqual(['bene', 'john']);
      expect(await find('Patient', { birthdate: 'lt1980' })).toEqual(['jane']);
      expect(await find('Patient', { birthdate: ['ge1975', 'le1985'] })).toEqual(['john']);
    });
    it('handles periods, open-ended periods and choice types', async () => {
      expect(await find('Encounter', { date: '2026-11-20' })).toEqual(['visit']);
      expect(await find('Encounter', { date: 'gt2026-12-01' })).toEqual(['openVisit']); // no end = ongoing
      expect(await find('Observation', { date: '2026-11-20' })).toEqual(['bp']); // effectiveDateTime in -08:00
      expect(await find('Observation', { date: '2026-01-15' })).toEqual([]); // inside a period, not equal to it
      expect(await find('Observation', { date: 'ge2026-01-15' })).toEqual(['bp', 'weight']);
      expect(await find('MedicationRequest', { authoredon: 'eq2026-11-20' })).toEqual(['rx']);
    });
  });

  describe('reference', () => {
    it('matches Type/id, bare ids and :Type', async () => {
      expect(await find('Observation', { subject: `Patient/${ids.jane}` })).toEqual(['bp']);
      expect(await find('Observation', { subject: ids.jane! })).toEqual(['bp', 'groupObs']);
      expect(await find('Observation', { 'subject:Group': ids.jane! })).toEqual(['groupObs']);
      expect(await find('MedicationRequest', { encounter: ids.visit! })).toEqual(['rx']);
    });
    it('applies resolve() filters (patient only matches Patient subjects)', async () => {
      expect(await find('Observation', { patient: ids.jane! })).toEqual(['bp']);
      expect(await find('Encounter', { patient: ids.john! })).toEqual(['openVisit']);
    });
  });

  describe('quantity', () => {
    it('compares values with prefixes, precision and units', async () => {
      expect(await find('Observation', { 'value-quantity': 'gt80' })).toEqual(['weight']);
      expect(await find('Observation', { 'value-quantity': '82.5|http://unitsofmeasure.org|kg' })).toEqual(['weight']);
      expect(await find('Observation', { 'value-quantity': '82.5|http://unitsofmeasure.org|g' })).toEqual([]);
      expect(await find('Observation', { 'component-value-quantity': '120' })).toEqual(['bp']); // 120.2 is within 120's precision
      expect(await find('Observation', { 'component-value-quantity': '120.0' })).toEqual([]);
    });
  });

  describe('combining, _id, _lastUpdated, :missing', () => {
    it('ORs comma-separated values and ANDs repeated parameters', async () => {
      expect(await find('Patient', { gender: 'male,unknown' })).toEqual(['hostile', 'john']);
      expect(await find('Patient', { gender: 'female', family: 'doe' })).toEqual(['jane']);
    });
    it('supports _id, _lastUpdated, _profile and :missing', async () => {
      expect(await find('Patient', { _id: `${ids.jane},${ids.bene}` })).toEqual(['bene', 'jane']);
      expect((await fhir.search('Patient', { _lastUpdated: 'gt2000-01-01' })).total).toBe(4);
      expect((await fhir.search('Patient', { _lastUpdated: 'lt2000-01-01' })).total).toBe(0);
      expect(await find('Patient', { _profile: 'http://example.org/fhir/StructureDefinition/test-patient' })).toEqual(['jane']);
      expect(await find('Patient', { 'birthdate:missing': 'true' })).toEqual(['hostile']);
      expect(await find('Patient', { 'address:missing': 'false' })).toEqual(['jane', 'john']);
    });
  });

  describe('sorting and paging', () => {
    it('sorts by date, string and _id', async () => {
      const byBirth = await fhir.search('Patient', { _sort: 'birthdate' });
      expect(byBirth.resources.map((r) => r.birthDate)).toEqual(['1974-12-25', '1980-03', '1990-06-15', undefined]);
      const desc = await fhir.search('Patient', { _sort: '-birthdate', 'birthdate:missing': 'false' });
      expect(desc.resources.map((r) => r.birthDate)).toEqual(['1990-06-15', '1980-03', '1974-12-25']);
      const byFamily = await fhir.search('Patient', { _sort: 'family', gender: 'female' });
      expect(byFamily.resources.map((r) => r.name?.[0]?.family)).toEqual(['Doe', 'Marché']);
    });
    it('pages with _count and _offset and reports the total', async () => {
      const page1 = await fhir.search('Patient', { _sort: '_id', _count: 3 });
      expect(page1.resources).toHaveLength(3);
      expect(page1.total).toBe(4);
      expect(page1.next).toEqual({ _sort: '_id', _count: 3, _offset: 3 });
      const page2 = await fhir.search('Patient', page1.next!);
      expect(page2.resources).toHaveLength(1);
      expect(page2.next).toBeUndefined();
      const past = await fhir.search('Patient', { _count: 3, _offset: 10 });
      expect(past).toEqual({ resources: [], total: 4 });
    });
  });

  describe('index maintenance', () => {
    it('reindexes on update and removes deleted resources from results', async () => {
      const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Temporary' }] });
      expect(await find('Patient', { family: 'temporary' })).toEqual([p.id]);
      await fhir.update({ ...p, name: [{ family: 'Renamed' }] });
      expect(await find('Patient', { family: 'temporary' })).toEqual([]);
      expect(await find('Patient', { family: 'renamed' })).toEqual([p.id]);
      await fhir.delete('Patient', p.id);
      expect(await find('Patient', { family: 'renamed' })).toEqual([]);
    });

    it('indexes existing data with reindex()', async () => {
      // A store whose version package has no search parameters writes without indexing.
      const storage = await backend.storage();
      const noSearch: FhirVersionPackage<ResourceTypeMap> = { fhirVersion: '4.0.1', validation: r4.validation };
      const plain = createFhirStore({ authorize: 'allow-all', storage, fhir: noSearch, resources: ['Patient'] });
      await plain.migrate();
      await plain.create({ resourceType: 'Patient', name: [{ family: 'Unindexed' }] });

      const store = createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'] });
      expect((await store.search('Patient', { family: 'unindexed' })).total).toBe(0);
      expect(await store.reindex()).toEqual({ Patient: 1 });
      expect((await store.search('Patient', { family: 'unindexed' })).total).toBe(1);
    });
  });

  describe('validation and policy', () => {
    it('rejects unknown parameters, modifiers and malformed values with 400', async () => {
      for (const params of [
        { famly: 'doe' },
        { 'family:sounds-like': 'doe' },
        { birthdate: 'not-a-date' },
        { birthdate: 'ap1974' },
        { 'value-quantity': 'abc' },
        { 'subject:Practitioner': 'x' },
        { _count: '0' },
        { _sort: 'telecom,-nope' },
      ]) {
        const err = await fhirError(() => fhir.search('Observation' as 'Patient', params));
        expect(err.status, JSON.stringify(params)).toBe(400);
      }
      expect((await fhirError(() => fhir.search('Patient', { famly: 'doe' }))).message).toMatch(/Unknown search parameter/);
    });

    it('never echoes search values (possible PHI) in errors', async () => {
      const secret = 'Jane-Doe-1974-12-25';
      for (const params of [
        { birthdate: secret },
        { 'value-quantity': secret },
        { subject: `${secret} x` },
        { 'family:sounds-like': secret },
      ]) {
        const err = await fhirError(() => fhir.search('Observation' as 'Patient', params));
        expect(err.message).not.toContain(secret);
        expect(JSON.stringify(err.outcome)).not.toContain(secret);
      }
    });

    it('does not index or search parameters with policy "none"', async () => {
      const storage = await backend.storage();
      const store = createFhirStore({
        authorize: 'allow-all',
        storage,
        fhir: r4,
        resources: ['Patient'],
        search: { policy: { 'Patient.birthdate': 'none' } },
      });
      await store.migrate();
      await store.create({ resourceType: 'Patient', birthDate: '2001-01-01', name: [{ family: 'Policy' }] });
      expect((await fhirError(() => store.search('Patient', { birthdate: '2001' }))).status).toBe(400);
      expect((await store.search('Patient', { family: 'policy' })).total).toBe(1);
    });

    it('rejects blind indexing (planned) and unknown policy keys at creation', async () => {
      const storage = await backend.storage();
      expect(() =>
        createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.name': 'blind' } } }),
      ).toThrow(/not implemented/);
      expect(() =>
        createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.nope': 'none' } } }),
      ).toThrow(/unknown parameter/);
    });
  });
});

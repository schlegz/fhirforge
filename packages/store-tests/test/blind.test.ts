import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, FhirError, type FhirStorage, type KeyProvider } from '@fhirforge/core';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md). Keys are fixed test values.

const kms: KeyProvider = {
  async wrap(dataKey) {
    return { keyId: 'test-master', wrapped: new Uint8Array(dataKey) }; // test-only: no real wrapping
  },
  async unwrap(_keyId, wrapped) {
    return new Uint8Array(wrapped);
  },
};
let blindKey = { id: 'blind-1', key: new Uint8Array(32).fill(3) };
const blindIndexKey = async () => blindKey;
const MRN = 'urn:oid:1.2.36.1.2001.1003.0';

const POLICY = {
  'Patient.family': 'blind',
  'Patient.given': 'blind',
  'Patient.name': 'none',
  'Patient.phonetic': 'none',
  'Patient.birthdate': 'blind',
  'Patient.identifier': 'blind',
} as const;

async function fhirError(fn: () => Promise<unknown>): Promise<FhirError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FhirError) return err;
    throw err;
  }
  throw new Error('expected a FhirError');
}

const makeStore = (storage: FhirStorage) =>
  createFhirStore({
    storage,
    fhir: r4,
    resources: ['Patient', 'Observation'],
    authorize: 'allow-all',
    encryption: { keys: kms, blindIndexKey },
    search: { policy: POLICY },
  });

describe('blind indexes (PGlite)', () => {
  const db = new PGlite();
  const schema = 'fhir_blind';
  let fhir: ReturnType<typeof makeStore>;
  const ids: Record<string, string> = {};
  const find = async (params: Record<string, string | string[]>) =>
    (await fhir.search('Patient', params)).resources.map((r) => Object.entries(ids).find(([, v]) => v === r.id)?.[0]).sort();

  beforeAll(async () => {
    fhir = makeStore(pgliteStorage(db, { schema }));
    await fhir.migrate();
    const add = async (key: string, resource: Record<string, unknown>) => {
      ids[key] = (await fhir.create({ resourceType: 'Patient', ...resource } as never)).id;
    };
    await add('jane', { name: [{ family: 'Doé', given: ['Jane'] }], birthDate: '1974-12-25', identifier: [{ system: MRN, value: 'SYN-A100' }] });
    await add('john', { name: [{ family: 'Doering', given: ['John'] }], birthDate: '1974', identifier: [{ value: 'SYN-B200' }] });
    await add('ann', { name: [{ family: 'Smith', given: ['Ann'] }], birthDate: '1980-03-01', gender: 'female' });
  });
  afterAll(() => db.close());

  it('stores keyed hashes for blind parameters, and no plaintext anywhere', async () => {
    const tables = ['string', 'token', 'date', 'reference', 'number', 'quantity', 'uri', 'blind'];
    const dump = JSON.stringify(
      await Promise.all(tables.map(async (k) => (await db.query(`SELECT * FROM ${schema}."Patient_${k}"`)).rows)),
    ) + JSON.stringify((await db.query(`SELECT * FROM ${schema}."Patient"`)).rows);
    // Distinctive values only (case-sensitive): random hashes and UUIDs can contain short strings by chance.
    expect(dump).not.toMatch(/Doé|Doering|Smith|SYN-A100|SYN-B200|1974-12-25|1980-03-01/);
    const { rows } = await db.query<{ param: string; key_id: string }>(`SELECT DISTINCT param, key_id FROM ${schema}."Patient_blind" ORDER BY param`);
    expect(rows).toEqual([
      { param: 'birthdate', key_id: 'blind-1' },
      { param: 'family', key_id: 'blind-1' },
      { param: 'given', key_id: 'blind-1' },
      { param: 'identifier', key_id: 'blind-1' },
    ]);
    // Plaintext parameters still work as before.
    expect(await find({ gender: 'female' })).toEqual(['ann']);
  });

  it('matches the whole normalized value: case- and accent-insensitive, no prefixes', async () => {
    expect(await find({ family: 'doe' })).toEqual(['jane']);
    expect(await find({ family: 'DOÉ' })).toEqual(['jane']);
    expect(await find({ family: 'do' })).toEqual([]); // no prefix match
    expect(await find({ family: 'doe,smith' })).toEqual(['ann', 'jane']);
    expect(await find({ family: 'doe', given: 'jane' })).toEqual(['jane']);
  });

  it('matches tokens with and without the system, and dates at their own precision', async () => {
    expect(await find({ identifier: `${MRN}|SYN-A100` })).toEqual(['jane']);
    expect(await find({ identifier: 'SYN-A100' })).toEqual(['jane']);
    expect(await find({ identifier: '|SYN-B200' })).toEqual(['john']); // no system
    expect(await find({ identifier: `${MRN}|SYN-B200` })).toEqual([]);
    expect(await find({ birthdate: '1974-12-25' })).toEqual(['jane']);
    expect(await find({ birthdate: 'eq1974' })).toEqual(['john']); // the stored precision only
  });

  it("refuses what a blind index can't answer, without echoing values", async () => {
    for (const [params, what] of [
      [{ family: 'Synthetic-x', 'family:contains': 'x' }, ':contains'],
      [{ 'family:exact': 'Synthetic-Doe' }, ':exact'],
      [{ birthdate: 'ge1970' }, 'the ge prefix'],
      [{ identifier: `${MRN}|` }, 'system|'],
      [{ 'identifier:not': 'Synthetic-x' }, ':not'],
      [{ 'family:missing': 'true' }, ':missing'],
      [{ _sort: 'family' }, '_sort'],
    ] as const) {
      const err = await fhirError(() => fhir.search('Patient', params as never));
      expect([err.status, err.message], JSON.stringify(params)).toEqual([400, expect.stringContaining(what)]);
      expect(err.message).not.toContain('Synthetic');
    }
  });

  it('works for conditional creates, chains and includes', async () => {
    const again = await fhir.conditionalCreate({ resourceType: 'Patient' }, { identifier: `${MRN}|SYN-A100` });
    expect([again.created, again.resource.id]).toEqual([false, ids.jane]);
    await fhir.create({ resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: `Patient/${ids.jane}` } });
    expect((await fhir.search('Observation', { 'subject.family': 'doe', _include: 'Observation:subject' })).included).toHaveLength(1);
  });

  it('only matches hashes under the current key: after rotating it, reindex', async () => {
    blindKey = { id: 'blind-2', key: new Uint8Array(32).fill(4) };
    const rotated = makeStore(pgliteStorage(db, { schema }));
    expect((await rotated.search('Patient', { family: 'doe' })).resources).toEqual([]);
    await rotated.reindex('Patient');
    expect((await rotated.search('Patient', { family: 'doe' })).resources.map((r) => r.id)).toEqual([ids.jane]);
    const { rows } = await db.query<{ key_id: string }>(`SELECT DISTINCT key_id FROM ${schema}."Patient_blind"`);
    expect(rows).toEqual([{ key_id: 'blind-2' }]);
    blindKey = { id: 'blind-1', key: new Uint8Array(32).fill(3) };
  });

  it('is only allowed with a key, and only for string, token and date parameters', () => {
    const storage = pgliteStorage(db, { schema });
    expect(() =>
      createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize: 'allow-all', encryption: { keys: kms }, search: { policy: { 'Patient.family': 'blind' } } }),
    ).toThrow(/needs `encryption.blindIndexKey`/);
    expect(() =>
      createFhirStore({
        storage,
        fhir: r4,
        resources: ['Patient'],
        authorize: 'allow-all',
        encryption: { keys: kms, blindIndexKey },
        search: { policy: { 'Patient.general-practitioner': 'blind' } },
      }),
    ).toThrow(/can't be blind/);
  });
});

describe.each(backends)('blind indexes on $name', (backend) => {
  afterAll(() => backend.close());

  it('indexes and finds by exact match', async () => {
    const fhir = makeStore(await backend.storage());
    await fhir.migrate();
    const p = await fhir.create({ resourceType: 'Patient', name: [{ family: 'Doe' }], identifier: [{ system: MRN, value: 'SYN-1' }] });
    expect((await fhir.search('Patient', { family: 'doe' })).resources.map((r) => r.id)).toEqual([p.id]);
    expect((await fhir.search('Patient', { identifier: `${MRN}|SYN-1` })).resources.map((r) => r.id)).toEqual([p.id]);
  });
});

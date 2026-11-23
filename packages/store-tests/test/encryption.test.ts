import { webcrypto } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, type FhirStorage, type KeyProvider } from '@fhirforge/core';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { backends } from './backends.js';

// Synthetic data only (see CLAUDE.md). The "KMS" is a fixed AES key: test-only.

/** A stand-in for a KMS: wraps data keys with AES-GCM under a master key, and counts calls. */
function testKms(keyId = 'test-master-1', seed = 7) {
  const master = webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(seed), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const calls = { wrap: 0, unwrap: 0 };
  const kms: KeyProvider & { keyId: string } = {
    keyId,
    async wrap(dataKey) {
      calls.wrap++;
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, await master, new Uint8Array(dataKey)));
      return { keyId: kms.keyId, wrapped: new Uint8Array([...iv, ...ct]) };
    },
    async unwrap(_keyId, wrapped) {
      calls.unwrap++;
      return new Uint8Array(
        await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(wrapped.subarray(0, 12)) }, await master, new Uint8Array(wrapped.subarray(12))),
      );
    },
  };
  return { kms, calls };
}

const synthetic = (family: string) => ({ resourceType: 'Patient' as const, name: [{ family, given: ['Synthetic-Given'] }], birthDate: '1974-12-25' });

describe('encryption at rest (PGlite, raw rows)', () => {
  const db = new PGlite();
  let n = 0;
  let schema: string;
  const storeWith = (kms?: KeyProvider, extra: Record<string, unknown> = {}) =>
    createFhirStore({
      storage: pgliteStorage(db, { schema }),
      fhir: r4,
      resources: ['Patient', 'Observation'],
      authorize: 'allow-all',
      ...(kms ? { encryption: { keys: kms, ...extra } } : {}),
    });
  const raw = async (sql: string) => (await db.query<Record<string, unknown>>(sql.replaceAll('$S', `"${schema}"`))).rows;

  beforeEach(async () => {
    schema = `fhir_enc_${n++}`;
  });
  afterAll(() => db.close());

  it('stores bodies encrypted, current and history, and reads them back intact', async () => {
    const { kms } = testKms();
    const fhir = storeWith(kms);
    await fhir.migrate();
    const p = await fhir.create(synthetic('Synthetic-Doe'));
    const updated = await fhir.update({ ...p, active: true });

    const rows = await raw(`SELECT content, enc IS NOT NULL AS encrypted FROM $S."Patient" UNION ALL SELECT content, enc IS NOT NULL FROM $S."Patient_history"`);
    expect(rows).toEqual([
      { content: null, encrypted: true },
      { content: null, encrypted: true },
      { content: null, encrypted: true },
    ]);
    const dump = JSON.stringify(await raw(`SELECT encode(enc, 'escape') AS e FROM $S."Patient_history"`));
    // Distinctive values only: random ciphertext bytes can spell short strings like "1974".
    expect(dump).not.toMatch(/Synthetic-Doe|Synthetic-Given|1974-12-25/);
    expect(await raw(`SELECT key_id FROM $S."_data_keys"`)).toEqual([{ key_id: 'test-master-1' }]);

    expect(await fhir.read('Patient', p.id)).toEqual(updated);
    expect((await fhir.vread('Patient', p.id, '1')).active).toBeUndefined();
    expect((await fhir.history('Patient', p.id)).map((h) => h.resource?.meta.versionId)).toEqual(['2', '1']);
    // Search still works: index rows are computed from the plaintext (left plaintext by policy here).
    const found = await fhir.search('Patient', { family: 'synthetic-doe' });
    expect(found.resources).toEqual([updated]);
  });

  it('reuses a data key within its window and caches unwrapped keys for reads', async () => {
    const { kms, calls } = testKms();
    const fhir = storeWith(kms, { dataKeyMaxUses: 5 });
    await fhir.migrate();
    for (let i = 0; i < 12; i++) await fhir.create(synthetic(`Doe${i}`));
    expect(calls.wrap).toBe(3); // 12 writes, 5 per data key
    const fresh = storeWith(kms); // a new process: nothing cached
    expect((await fresh.search('Patient', { _count: 50 })).resources).toHaveLength(12);
    expect(calls.unwrap).toBe(3); // one unwrap per data key, not per row
  });

  it('refuses a ciphertext moved to another row, or the wrong master key, without leaking content', async () => {
    const { kms } = testKms();
    const fhir = storeWith(kms);
    await fhir.migrate();
    const a = await fhir.update({ ...synthetic('Synthetic-A'), id: 'a' });
    await fhir.update({ ...synthetic('Synthetic-B'), id: 'b' });
    await fhir.update({ ...a, active: true });
    await db.query(`UPDATE "${schema}"."Patient" SET enc = (SELECT enc FROM "${schema}"."Patient" WHERE id = 'a') WHERE id = 'b'`);
    const moved = await fhir.read('Patient', 'b').catch((e: Error) => e);
    expect(moved).toBeInstanceOf(Error);
    expect((moved as Error).message).toBe('fhirforge: could not decrypt Patient/b');
    // An older version's ciphertext replayed into the current row fails too (the version is bound).
    await db.query(`UPDATE "${schema}"."Patient" SET enc = (SELECT enc FROM "${schema}"."Patient_history" WHERE id = 'a' AND version_id = 1) WHERE id = 'a'`);
    await expect(fhir.read('Patient', 'a')).rejects.toThrow('could not decrypt Patient/a');

    const other = storeWith(testKms('test-master-1', 9).kms);
    const wrongKey = await other.vread('Patient', 'a', '1').catch((e: Error) => e);
    expect((wrongKey as Error).message).toBe('fhirforge: could not decrypt Patient/a');
    expect(JSON.stringify(wrongKey, Object.getOwnPropertyNames(wrongKey))).not.toContain('Synthetic');
  });

  it('reads plaintext rows written before encryption, and reencrypt() encrypts them', async () => {
    const plain = storeWith();
    await plain.migrate();
    const old = await plain.create(synthetic('Synthetic-Old'));
    await plain.update({ ...old, active: true });

    const { kms } = testKms();
    const fhir = storeWith(kms);
    await fhir.migrate();
    const fresh = await fhir.create(synthetic('Synthetic-New'));
    expect((await fhir.read('Patient', old.id)).active).toBe(true); // mixed mode
    expect(await raw(`SELECT count(*)::int AS n FROM $S."Patient_history" WHERE content IS NOT NULL`)).toEqual([{ n: 2 }]);

    expect(await fhir.reencrypt()).toEqual({ Observation: 0, Patient: 1 });
    expect(await raw(`SELECT count(*)::int AS n FROM $S."Patient_history" WHERE content IS NOT NULL OR enc IS NULL`)).toEqual([{ n: 0 }]);
    expect((await fhir.vread('Patient', old.id, '1')).name?.[0]?.family).toBe('Synthetic-Old');
    expect((await fhir.read('Patient', fresh.id)).id).toBe(fresh.id);
    expect(await fhir.reencrypt()).toEqual({ Observation: 0, Patient: 0 }); // nothing left to do
  });

  it('keeps rotating data keys during a long reencrypt', async () => {
    const plain = storeWith();
    await plain.migrate();
    for (let i = 0; i < 6; i++) await plain.create(synthetic(`Synthetic-${i}`));
    const { kms, calls } = testKms();
    const fhir = storeWith(kms, { dataKeyMaxUses: 2 });
    await fhir.migrate();
    expect(await fhir.reencrypt()).toEqual({ Observation: 0, Patient: 6 });
    expect(calls.wrap).toBe(3); // 6 encryptions, 2 per data key
  });

  it('rotates: reencrypt({ olderThan }) moves every version to a key under the new master key', async () => {
    const { kms } = testKms();
    const fhir = storeWith(kms);
    await fhir.migrate();
    const p = await fhir.create(synthetic('Synthetic-Doe'));
    await fhir.update({ ...p, active: true });

    kms.keyId = 'test-master-2'; // the KMS rotated its master key
    const rotated = storeWith(kms); // a new data key on the next write
    expect(await rotated.reencrypt({ olderThan: new Date(Date.now() + 1000) })).toEqual({ Observation: 0, Patient: 1 });
    expect(
      await raw(`SELECT DISTINCT d.key_id FROM $S."Patient_history" h JOIN $S."_data_keys" d ON d.id = h.dek_id`),
    ).toEqual([{ key_id: 'test-master-2' }]);
    expect((await rotated.history('Patient', p.id)).length).toBe(2);
  });

  it('fails a write when the KMS fails, and writes nothing', async () => {
    const fhir = storeWith({
      wrap: () => Promise.reject(new Error('KMS unavailable')),
      unwrap: () => Promise.reject(new Error('KMS unavailable')),
    });
    await fhir.migrate();
    await expect(fhir.create(synthetic('Synthetic-Doe'))).rejects.toThrow('KMS unavailable');
    expect(await raw(`SELECT count(*)::int AS n FROM $S."Patient"`)).toEqual([{ n: 0 }]);
  });

  it('works with reindex, Bundles and conditional operations', async () => {
    const { kms } = testKms();
    const fhir = storeWith(kms);
    await fhir.migrate();
    const res = await fhir.transaction({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { fullUrl: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01', resource: synthetic('Synthetic-Tx'), request: { method: 'POST', url: 'Patient' } },
        {
          resource: { resourceType: 'Observation', status: 'final', code: { text: 'hr' }, subject: { reference: 'urn:uuid:9a3c1f4e-2b7d-4c1a-8e5f-0d6b7a8c9e01' } } as never,
          request: { method: 'POST', url: 'Observation' },
        },
      ],
    });
    expect(res.entry.map((e) => e.response.status)).toEqual(['201 Created', '201 Created']);
    expect(await fhir.reindex()).toEqual({ Observation: 1, Patient: 1 });
    expect((await fhir.search('Observation', { 'subject.name': 'synthetic-tx' })).resources).toHaveLength(1);
    const again = await fhir.conditionalCreate(synthetic('Synthetic-Tx'), { family: 'synthetic-tx' });
    expect(again.created).toBe(false);
    expect(await raw(`SELECT count(*)::int AS n FROM $S."Observation" WHERE content IS NOT NULL`)).toEqual([{ n: 0 }]);
  });
});

describe.each(backends)('encryption round trip on $name', (backend) => {
  let storage: FhirStorage;
  afterAll(() => backend.close());
  beforeEach(async () => {
    storage = await backend.storage();
  });

  it('writes, reads, searches and re-encrypts', async () => {
    const { kms } = testKms();
    const fhir = createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize: 'allow-all', encryption: { keys: kms } });
    await fhir.migrate();
    const p = await fhir.create(synthetic('Synthetic-Doe'));
    await fhir.update({ ...p, active: true });
    expect((await fhir.read('Patient', p.id)).name?.[0]?.family).toBe('Synthetic-Doe');
    expect((await fhir.search('Patient', { family: 'synthetic' })).total).toBe(1);
    expect((await fhir.history('Patient', p.id)).length).toBe(2);
    kms.keyId = 'test-master-2';
    const rotated = createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize: 'allow-all', encryption: { keys: kms } });
    expect(await rotated.reencrypt({ olderThan: new Date(Date.now() + 1000) })).toEqual({ Patient: 1 });
    expect((await rotated.vread('Patient', p.id, '1')).active).toBeUndefined();
  });
});

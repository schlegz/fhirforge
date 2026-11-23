import { stampMeta, type FhirStorage, type Opener, type Sealer, type StoredVersion } from './storage.js';
import type { AnyResource } from './types.js';

// Web Crypto and text encoding are globals in Node 20+, Deno, Bun and browsers. Declared here
// (only what's used) so core needs neither the DOM lib nor @types/node.
interface AesKey {
  readonly type: string;
}
declare const crypto: {
  randomUUID(): string;
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: {
    importKey(format: 'raw', key: Uint8Array, algorithm: { name: 'AES-GCM' }, extractable: false, usages: ('encrypt' | 'decrypt')[]): Promise<AesKey>;
    encrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array }, key: AesKey, data: Uint8Array): Promise<ArrayBuffer>;
    decrypt(algorithm: { name: 'AES-GCM'; iv: Uint8Array; additionalData: Uint8Array }, key: AesKey, data: Uint8Array): Promise<ArrayBuffer>;
  };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label?: string, options?: { fatal?: boolean }) => { decode(input: Uint8Array): string };
declare function btoa(data: string): string;
declare function atob(data: string): string;

/**
 * The app's key management (AWS KMS, GCP KMS, Vault Transit, ...). fhirforge generates data
 * keys and asks this to wrap and unwrap them; master keys never leave the KMS.
 */
export interface KeyProvider {
  /** Wraps a fresh 256-bit data key with the current master key. `keyId` identifies that master key (version). */
  wrap(dataKey: Uint8Array): Promise<{ keyId: string; wrapped: Uint8Array }>;
  /** Unwraps a data key that `wrap` produced, with the master key `keyId`. */
  unwrap(keyId: string, wrapped: Uint8Array): Promise<Uint8Array>;
}

export interface EncryptionOptions {
  keys: KeyProvider;
  /** A data key encrypts new versions for at most this long. Default 5 minutes, at most 24 hours. */
  dataKeyMaxAgeMs?: number;
  /** ...or at most this many encryptions, whichever comes first. Default 100,000. */
  dataKeyMaxUses?: number;
  /** Unwrapped data keys kept in memory for reads. Default 1,000. */
  dataKeyCacheSize?: number;
  /**
   * Refuse plaintext bodies on read (they're an error, not data). Turn it on once
   * `reencrypt()` returns 0 for every type: then nobody with write access to the database
   * can substitute plaintext for a ciphertext. `reencrypt()` itself still reads plaintext.
   */
  requireEncrypted?: boolean;
  /**
   * The key for `blind` search parameters (HMAC-SHA-256, at least 32 bytes): a separate secret
   * from the data keys, e.g. from your secrets manager. Its `id` is stored on each blind index
   * row; after rotating it, run `reindex()`. Required to use the `blind` search policy.
   */
  blindIndexKey?: () => Promise<{ id: string; key: Uint8Array }>;
}

/** Longest data key window: `removeUnusedDataKeys` relies on no process writing with a key older than this. */
export const MAX_DATA_KEY_AGE_MS = 24 * 60 * 60 * 1000;
/** Data keys younger than this are never removed (twice the longest window). */
export const DATA_KEY_RETENTION_MS = 2 * MAX_DATA_KEY_AGE_MS;

/** Format byte of an encrypted body: AES-256-GCM, 96-bit nonce, 128-bit tag. */
const FORMAT_AES_GCM = 1;
const NONCE_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Binds a ciphertext to its row: copying it to another resource or version makes it fail to decrypt. */
const aadFor = (resourceType: string, id: string, versionId: string) => encoder.encode(`${resourceType}/${id}/_history/${versionId}`);

interface CurrentKey {
  id: string;
  keyId: string;
  wrapped: string;
  key: AesKey;
  created: number;
  uses: number;
}

/** Data keys: one current key for writes (rotated by age and use), and a bounded cache of unwrapped keys for reads. */
class Keyring {
  private current: CurrentKey | undefined;
  private rotating: Promise<CurrentKey> | undefined;
  private readonly cache = new Map<string, Promise<AesKey>>();
  private readonly maxAge: number;
  private readonly maxUses: number;
  private readonly cacheSize: number;

  constructor(
    private readonly provider: KeyProvider,
    options: EncryptionOptions,
  ) {
    this.maxAge = options.dataKeyMaxAgeMs ?? 5 * 60 * 1000;
    this.maxUses = options.dataKeyMaxUses ?? 100_000;
    this.cacheSize = options.dataKeyCacheSize ?? 1000;
  }

  private fresh(k: CurrentKey | undefined): k is CurrentKey {
    return k !== undefined && Date.now() - k.created < this.maxAge && k.uses < this.maxUses;
  }

  /** Makes sure a usable data key exists. Called before a write transaction, so KMS calls stay out of it. */
  async prepare(): Promise<void> {
    if (this.fresh(this.current)) return;
    this.rotating ??= this.rotate().finally(() => (this.rotating = undefined));
    await this.rotating;
  }

  private async rotate(): Promise<CurrentKey> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const { keyId, wrapped } = await this.provider.wrap(raw.slice());
      if (typeof keyId !== 'string' || keyId === '' || !(wrapped instanceof Uint8Array)) {
        throw new Error('fhirforge: KeyProvider.wrap must return { keyId, wrapped: Uint8Array }');
      }
      const current: CurrentKey = { id: crypto.randomUUID(), keyId, wrapped: toBase64(wrapped), key, created: Date.now(), uses: 0 };
      this.remember(current.id, Promise.resolve(key));
      this.current = current;
      return current;
    } finally {
      raw.fill(0);
    }
  }

  /** The key for the next encryption. Inside a transaction, a key just past its window is still used rather than calling the KMS. */
  async forWrite(): Promise<CurrentKey> {
    if (!this.current) await this.prepare();
    const current = this.current!;
    current.uses++;
    return current;
  }

  async forRead(dekId: string, lookup: () => Promise<{ keyId: string; wrapped: string } | undefined>): Promise<AesKey> {
    let key = this.cache.get(dekId);
    if (!key) {
      key = (async () => {
        const found = await lookup();
        if (!found) throw new Error('fhirforge: data key not found');
        const raw = await this.provider.unwrap(found.keyId, fromBase64(found.wrapped));
        try {
          return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
        } finally {
          raw.fill(0);
        }
      })();
      key.catch(() => this.cache.delete(dekId)); // don't cache failures
      this.remember(dekId, key);
    } else {
      // Least recently used goes first: move to the end.
      this.cache.delete(dekId);
      this.cache.set(dekId, key);
    }
    return key;
  }

  private remember(id: string, key: Promise<AesKey>) {
    this.cache.set(id, key);
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
  }
}

/** The body without server meta: the adapter stamps `versionId` and `lastUpdated` from its columns. */
function withoutServerMeta(resource: AnyResource): AnyResource {
  if (!resource.meta) return resource;
  const { versionId: _v, lastUpdated: _l, ...meta } = resource.meta as Record<string, unknown>;
  const { meta: _meta, ...rest } = resource;
  return Object.keys(meta).length ? { ...rest, meta } as AnyResource : (rest as AnyResource);
}

/**
 * Wraps a storage adapter so resource bodies are encrypted at rest (envelope encryption,
 * AES-256-GCM, a random 96-bit nonce per encryption, the row's `Type/id/_history/version` as
 * additional authenticated data). Reads decrypt; plaintext rows (written before encryption
 * was turned on) stay readable until `reencrypt` rewrites them.
 */
export function encryptedStorage(inner: FhirStorage, options: EncryptionOptions): FhirStorage {
  if (!options || typeof options.keys?.wrap !== 'function' || typeof options.keys?.unwrap !== 'function') {
    throw new Error('createFhirStore: `encryption.keys` must be a KeyProvider with wrap() and unwrap()');
  }
  const maxAge = options.dataKeyMaxAgeMs;
  if (maxAge !== undefined && (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > MAX_DATA_KEY_AGE_MS)) {
    throw new Error('createFhirStore: `encryption.dataKeyMaxAgeMs` must be between 1 ms and 24 hours');
  }
  const keyring = new Keyring(options.keys, options);

  const seal: Sealer = async (resource) => {
    const dek = await keyring.forWrite();
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const plaintext = encoder.encode(JSON.stringify(withoutServerMeta(resource)));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aadFor(resource.resourceType, resource.id, resource.meta.versionId) },
        dek.key,
        plaintext,
      ),
    );
    const bytes = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
    bytes[0] = FORMAT_AES_GCM;
    bytes.set(nonce, 1);
    bytes.set(ciphertext, 1 + NONCE_BYTES);
    return { enc: toBase64(bytes), dekId: dek.id, keyId: dek.keyId, wrapped: dek.wrapped };
  };

  /** Decrypts; plaintext bodies pass through (mixed mode, and what `reencrypt` needs). */
  const openAny: Opener = async (v) => {
    if (!v.sealed) return v;
    const { resourceType, id, enc, dekId, key: known } = v.sealed;
    try {
      const bytes = fromBase64(enc);
      if (bytes[0] !== FORMAT_AES_GCM) throw new Error('unknown format');
      const key = await keyring.forRead(dekId, async () => known ?? (await inner.dataKeys([dekId]))[0]);
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(1, 1 + NONCE_BYTES), additionalData: aadFor(resourceType, id, v.versionId) },
        key,
        bytes.subarray(1 + NONCE_BYTES),
      );
      const body = JSON.parse(decoder.decode(new Uint8Array(plaintext))) as AnyResource & { id: string };
      const { sealed: _sealed, ...rest } = v;
      return { ...rest, resource: stampMeta(body, v.versionId, v.lastUpdated) };
    } catch (err) {
      // Never include key material or ciphertext; the type and id are fine (CLAUDE.md §1).
      throw new Error(`fhirforge: could not decrypt ${resourceType}/${id}`, { cause: err });
    }
  };
  /** Decrypts; with `requireEncrypted`, a plaintext body is an error. */
  const open: Opener = async (v) => {
    if (!v.sealed && v.resource && options.requireEncrypted) {
      // Type and id only: never the content (CLAUDE.md §1).
      throw new Error(
        `fhirforge: ${v.resource.resourceType}/${v.resource.id} is stored in plaintext, but encryption.requireEncrypted is on (run reencrypt())`,
      );
    }
    return openAny(v);
  };
  const openAll = (versions: StoredVersion[]) => Promise.all(versions.map(open));
  const maybe = async (v: StoredVersion | undefined) => (v ? open(v) : undefined);

  return {
    ...inner,
    migrate: (types, o) => inner.migrate(types, { ...o, encryption: true }),
    async create(resource, o = {}) {
      await keyring.prepare();
      return inner.create(resource, { ...o, seal });
    },
    async update(resource, o = {}) {
      await keyring.prepare();
      return inner.update(resource, { ...o, seal });
    },
    async writeAll(writes, o = {}) {
      await keyring.prepare();
      return inner.writeAll(writes, { ...o, seal });
    },
    read: async (type, id) => maybe(await inner.read(type, id)),
    vread: async (type, id, versionId) => maybe(await inner.vread(type, id, versionId)),
    history: async (type, id) => openAll(await inner.history(type, id)),
    async search(query) {
      const { versions, total } = await inner.search(query);
      return { versions: await openAll(versions), total };
    },
    reindex: (type, index, o) => inner.reindex(type, index, { ...o, open }),
    reencrypt: (type, o) => inner.reencrypt(type, { ...o, open: openAny, seal, prepare: () => keyring.prepare() }),
  };
}

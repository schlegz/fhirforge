import { FhirError } from '../errors.js';
import type { IndexRow, SearchPolicy } from './index-rows.js';
import type { SearchClause, SearchCondition, SearchQuery } from './query.js';
import type { SearchParamType } from './types.js';

// Web Crypto (HMAC) and text encoding are globals in Node 20+, Deno, Bun and browsers.
interface HmacKey {
  readonly type: string;
}
declare const crypto: {
  subtle: {
    importKey(format: 'raw', key: Uint8Array, algorithm: { name: 'HMAC'; hash: 'SHA-256' }, extractable: false, usages: ['sign']): Promise<HmacKey>;
    sign(algorithm: 'HMAC', key: HmacKey, data: Uint8Array): Promise<ArrayBuffer>;
  };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare function btoa(data: string): string;

/** The parameter types that can be `blind`: exact match on a normalized value makes sense for them. */
export const BLIND_TYPES: ReadonlySet<SearchParamType> = new Set(['string', 'token', 'date']);

/** The app's blind index key: a separate secret from the data keys, with an id stored on each row. */
export type BlindIndexKey = () => Promise<{ id: string; key: Uint8Array }>;

const encoder = new TextEncoder();

/**
 * Blind indexes: a `blind` parameter is indexed as HMAC-SHA-256(key, parameter + normalized value)
 * instead of the value, and searched by hashing the search value the same way. Only exact
 * matches work; anything else is a 400 (never a silent scan or a wrong answer).
 */
export function blindIndexer(getKey: BlindIndexKey, policy: (resourceType: string, code: string) => SearchPolicy) {
  let loaded: Promise<{ id: string; key: HmacKey }> | undefined;
  const key = () =>
    (loaded ??= (async () => {
      const { id, key: raw } = await getKey();
      if (typeof id !== 'string' || id === '' || !(raw instanceof Uint8Array) || raw.length < 32) {
        throw new Error('fhirforge: blindIndexKey must return { id, key } with a key of at least 32 bytes');
      }
      return { id, key: await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
    })().catch((err) => {
      loaded = undefined; // retry next time
      throw err;
    }));

  const hash = async (param: string, text: string) => {
    const { id, key: k } = await key();
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(`${param}\u0000${text}`)));
    return { keyId: id, hash: btoa(String.fromCharCode(...mac)) };
  };

  /** What gets hashed for one index row (several for tokens: with and without the system). */
  const inputsForRow = (row: IndexRow): string[] => {
    switch (row.kind) {
      case 'string':
        return [`s:${row.valueNorm}`];
      case 'token':
        return [`c:${row.code}`, row.system === null ? `n:${row.code}` : `sc:${row.system}|${row.code}`];
      case 'date':
        return [`d:${row.low ?? ''}|${row.high ?? ''}`];
      default:
        return [];
    }
  };

  const unsupported = (resourceType: string, param: string, what: string) =>
    FhirError.invalid(`${resourceType}.${param} is a blind index (exact match only): ${what} is not supported`);

  /** What gets hashed for one search condition, or a 400 when a blind index can't answer it. */
  const inputForCondition = (resourceType: string, param: string, c: SearchCondition): string => {
    switch (c.kind) {
      case 'string':
        if (c.mode !== 'prefix') throw unsupported(resourceType, param, `:${c.mode}`);
        return `s:${c.value}`; // the whole normalized value, not a prefix
      case 'token':
        if (c.code === undefined) throw unsupported(resourceType, param, 'system| (any code)');
        if (c.system === undefined) return `c:${c.code}`;
        return c.system === null ? `n:${c.code}` : `sc:${c.system}|${c.code}`;
      case 'date':
        if (c.prefix !== 'eq') throw unsupported(resourceType, param, `the ${c.prefix} prefix`);
        return `d:${c.low}|${c.high}`;
      default:
        throw unsupported(resourceType, param, 'this search');
    }
  };

  return {
    /** Replaces the plaintext index rows of blind parameters with keyed hashes. */
    async rows(resourceType: string, rows: IndexRow[]): Promise<IndexRow[]> {
      const out: IndexRow[] = [];
      for (const row of rows) {
        if (row.kind === 'blind' || policy(resourceType, row.param) !== 'blind') {
          out.push(row);
          continue;
        }
        for (const input of inputsForRow(row)) out.push({ kind: 'blind', param: row.param, ...(await hash(row.param, input)) });
      }
      return out;
    },

    /** Rewrites the clauses of blind parameters into hash lookups; refuses what they can't answer. */
    async query(query: SearchQuery): Promise<SearchQuery> {
      const isBlind = (param: string) => policy(query.resourceType, param) === 'blind';
      for (const key of query.sort) if (isBlind(key.param)) throw unsupported(query.resourceType, key.param, '_sort');
      const clauses: SearchClause[] = [];
      for (const clause of query.clauses) {
        if (!isBlind(clause.param)) {
          clauses.push(clause);
          continue;
        }
        if (clause.missing !== undefined) throw unsupported(query.resourceType, clause.param, ':missing');
        if (clause.negate) throw unsupported(query.resourceType, clause.param, ':not');
        const conditions: SearchCondition[] = [];
        for (const c of clause.conditions) {
          conditions.push({ kind: 'blind', ...(await hash(clause.param, inputForCondition(query.resourceType, clause.param, c))) });
        }
        clauses.push({ param: clause.param, type: 'blind', conditions });
      }
      return { ...query, clauses };
    },
  };
}

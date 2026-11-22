import { FhirError } from '../errors.js';
import type { SearchPolicy } from './index-rows.js';
import type { SearchParams } from './query.js';
import type { CompiledSearchParameter, SearchParameterTable } from './types.js';

/** Most chained parameter values per search (each one runs its own search on the target type). */
export const MAX_CHAINS = 3;
/** A chained parameter may match at most this many target resources; more is a 400 (narrow the chain). */
export const MAX_CHAIN_MATCHES = 100;
/** Most `_include` + `_revinclude` values per search. */
export const MAX_INCLUDE_PARAMS = 5;
/** Most included resources returned per page (the result says when the limit cut some off). */
export const MAX_INCLUDED = 100;

/** `subject:Patient.name=doe`: search Patient by `name`, then Observations whose `subject` points to a match. */
export interface Chain {
  /** The reference parameter on the searched type, e.g. `subject`. */
  param: string;
  targetType: string;
  /** The parameter (with any modifier) on the target type, e.g. `name:exact`. */
  innerKey: string;
  value: string;
}

/** `_include=Observation:subject[:Patient]`: also return what the results' `subject` points to. */
export interface Include {
  param: CompiledSearchParameter;
  /** Only targets of this type (`:Patient`), or every configured type. */
  targetType?: string;
}

/** `_revinclude=Observation:subject`: also return Observations whose `subject` points to a result. */
export interface RevInclude {
  resourceType: string;
  param: string;
}

export interface LinkedSearch {
  /** The parameters with chains and includes removed. */
  params: Record<string, SearchParams[string]>;
  chains: Chain[];
  includes: Include[];
  revIncludes: RevInclude[];
}

const TYPE = /^[A-Z][A-Za-z]{0,63}$/;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const safe = (name: string, pattern: RegExp) => (pattern.test(name) ? name : '(invalid name)');

/** True when a parameter key is a chain (`subject.name`, `subject:Patient.name:exact`). */
export const isChainKey = (key: string) => !key.startsWith('_') && key.includes('.');
export const isIncludeKey = (key: string) => key === '_include' || key === '_revinclude' || key.startsWith('_include:') || key.startsWith('_revinclude:');

/**
 * Splits chained parameters and `_include` / `_revinclude` out of a search and
 * validates them against the compiled parameters and the configured resource
 * types. Only one chain level and no `:iterate` or `*`; anything else is a 400
 * that names parameters, never values.
 */
export function splitLinks(
  resourceType: string,
  params: SearchParams,
  table: SearchParameterTable,
  configured: ReadonlySet<string>,
  policy: (resourceType: string, code: string) => SearchPolicy,
): LinkedSearch {
  const out: LinkedSearch = { params: {}, chains: [], includes: [], revIncludes: [] };
  const referenceParam = (type: string, code: string): CompiledSearchParameter => {
    const def = table[type]?.find((p) => p.code === code);
    if (!def) throw FhirError.invalid(`Unknown search parameter for ${type}: ${safe(code, CODE)}`);
    if (def.type !== 'reference') throw FhirError.invalid(`${type}.${code} is not a reference parameter`);
    if (policy(type, code) === 'none') throw FhirError.invalid(`Search parameter ${type}.${code} is not searchable (search policy "none")`);
    return def;
  };
  const targetOf = (def: CompiledSearchParameter, type: string, explicit: string | undefined): string | undefined => {
    if (explicit !== undefined) {
      if (!TYPE.test(explicit)) throw FhirError.invalid(`Invalid resource type in ${def.code}`);
      if (def.targets && !def.targets.includes(explicit)) throw FhirError.invalid(`${type}.${def.code} can't point to ${explicit}`);
      if (!configured.has(explicit)) throw FhirError.notSupported(`Resource type ${explicit} is not managed by this store`);
      return explicit;
    }
    return undefined;
  };

  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined) continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map(String);

    if (isIncludeKey(key)) {
      if (key !== '_include' && key !== '_revinclude') {
        throw FhirError.notSupported(`${key.startsWith('_include') ? '_include' : '_revinclude'} modifiers (:iterate) are not supported`);
      }
      for (const value of values) {
        if (value === '*' || value.endsWith(':*')) throw FhirError.notSupported(`${key}=* is not supported`);
        const [type, code, target, ...extra] = value.split(':');
        if (!type || !code || extra.length) throw FhirError.invalid(`${key} must be Type:parameter or Type:parameter:TargetType`);
        if (!TYPE.test(type)) throw FhirError.invalid(`Invalid resource type in ${key}`);
        if (key === '_include') {
          if (type !== resourceType) throw FhirError.invalid(`_include must start with ${resourceType}`);
          const def = referenceParam(type, code);
          out.includes.push({ param: def, ...(target !== undefined ? { targetType: targetOf(def, type, target) } : {}) });
        } else {
          if (!configured.has(type)) throw FhirError.notSupported(`Resource type ${type} is not managed by this store`);
          const def = referenceParam(type, code);
          if (target !== undefined && target !== resourceType) throw FhirError.invalid(`_revinclude target type must be ${resourceType}`);
          if (def.targets && !def.targets.includes(resourceType)) throw FhirError.invalid(`${type}.${code} can't point to ${resourceType}`);
          out.revIncludes.push({ resourceType: type, param: code });
        }
      }
      continue;
    }

    if (isChainKey(key)) {
      const dot = key.indexOf('.');
      const outer = key.slice(0, dot);
      const innerKey = key.slice(dot + 1);
      const innerCode = innerKey.split(':')[0]!;
      if (innerCode.includes('.') || innerKey === '') {
        throw FhirError.notSupported('Chained search deeper than one level is not supported');
      }
      if (innerCode.startsWith('_') && innerCode !== '_id' && innerCode !== '_lastUpdated') {
        throw FhirError.invalid(`${safe(innerCode, /^_[A-Za-z]{1,30}$/)} can't be used in a chain`);
      }
      const [code, modifier] = outer.split(':') as [string, string | undefined];
      const def = referenceParam(resourceType, code);
      let targetType = targetOf(def, resourceType, modifier);
      if (targetType === undefined) {
        const candidates = (def.targets ?? []).filter((t) => configured.has(t));
        if (def.targets === undefined || candidates.length !== 1) {
          throw FhirError.invalid(`Chained ${code} needs a target type, e.g. ${code}:${candidates[0] ?? 'Patient'}.${safe(innerKey.split(':')[0]!, CODE)}`);
        }
        targetType = candidates[0]!;
      }
      if (!configured.has(targetType)) throw FhirError.notSupported(`Resource type ${targetType} is not managed by this store`);
      for (const value of values) out.chains.push({ param: code, targetType, innerKey, value });
      continue;
    }

    out.params[key] = raw;
  }
  if (out.chains.length > MAX_CHAINS) throw FhirError.invalid(`Too many chained parameters (max ${MAX_CHAINS})`);
  if (out.includes.length + out.revIncludes.length > MAX_INCLUDE_PARAMS) {
    throw FhirError.invalid(`Too many _include / _revinclude parameters (max ${MAX_INCLUDE_PARAMS})`);
  }
  return out;
}

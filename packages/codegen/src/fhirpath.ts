/**
 * A parser for the small FHIRPath subset used by base FHIR search parameter
 * expressions. Anything outside the subset is rejected (the parameter is then
 * reported as unsupported), never guessed at.
 *
 * Supported:
 *   A.b.c                         field paths
 *   x | y                         unions
 *   (A.value as Quantity)         casts, also A.value.as(Quantity) and A.value.ofType(Quantity)
 *   (... ).text                   field access after a parenthesized cast
 *   x.where(resolve() is Patient) reference target filter
 *   x.where(system='phone')       child field equals a string literal
 */

export type RawStep =
  | { kind: 'field'; name: string }
  | { kind: 'cast'; type: string }
  | { kind: 'where-resolve'; type: string }
  | { kind: 'where-equals'; field: string; value: string };

export interface RawPath {
  /** First segment: a resource type, `Resource` or `DomainResource`. */
  root: string;
  steps: RawStep[];
}

export class UnsupportedExpression extends Error {}

export function parseExpression(expression: string): RawPath[] {
  return splitTopLevel(expression, '|').map((part) => parsePart(part.trim()));
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && s[i - 1] !== '\\') quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*/;

function parsePart(input: string): RawPath {
  let s = input.trim();
  let path: RawPath;

  if (s.startsWith('(')) {
    const close = matchingParen(s, 0);
    const inner = s.slice(1, close).trim();
    s = s.slice(close + 1).trim();
    const asMatch = /^(.*)\s+as\s+([A-Za-z]+)$/.exec(inner);
    path = asMatch ? parsePart(asMatch[1]!) : parsePart(inner);
    if (asMatch) path.steps.push({ kind: 'cast', type: asMatch[2]! });
    if (s === '') return path;
    if (!s.startsWith('.')) throw new UnsupportedExpression(`unexpected "${s}"`);
    s = s.slice(1);
  } else {
    const m = IDENT.exec(s);
    if (!m) throw new UnsupportedExpression(`expected a path in "${input}"`);
    path = { root: m[0], steps: [] };
    s = s.slice(m[0].length);
    if (s === '') return path;
    if (!s.startsWith('.')) throw new UnsupportedExpression(`unexpected "${s}"`);
    s = s.slice(1);
  }

  while (s.length > 0) {
    const m = IDENT.exec(s);
    if (!m) throw new UnsupportedExpression(`unexpected "${s}"`);
    const name = m[0];
    s = s.slice(name.length);
    if (s.startsWith('(')) {
      const close = matchingParen(s, 0);
      const arg = s.slice(1, close).trim();
      s = s.slice(close + 1);
      path.steps.push(parseFunction(name, arg));
    } else {
      path.steps.push({ kind: 'field', name });
    }
    if (s === '') break;
    if (!s.startsWith('.')) throw new UnsupportedExpression(`unexpected "${s}"`);
    s = s.slice(1);
  }
  return path;
}

function parseFunction(name: string, arg: string): RawStep {
  if ((name === 'as' || name === 'ofType') && /^[A-Za-z]+$/.test(arg)) {
    return { kind: 'cast', type: arg };
  }
  if (name === 'where') {
    const resolve = /^resolve\(\)\s+is\s+([A-Za-z]+)$/.exec(arg);
    if (resolve) return { kind: 'where-resolve', type: resolve[1]! };
    const eq = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*'([^'\\]*)'$/.exec(arg);
    if (eq) return { kind: 'where-equals', field: eq[1]!, value: eq[2]! };
  }
  throw new UnsupportedExpression(`function ${name}(${arg}) is not supported`);
}

function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && s[i - 1] !== '\\') quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new UnsupportedExpression(`unbalanced parentheses in "${s}"`);
}

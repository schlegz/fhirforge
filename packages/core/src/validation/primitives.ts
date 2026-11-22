import type { PrimitiveKind } from './types.js';

/**
 * Format checks for FHIR primitive values, by primitive type code.
 *
 * These are fixed, reviewed patterns (equivalent to or stricter than the
 * spec's regexes), not the regexes from the definitions: patterns from data
 * could backtrack badly on hostile input. Every pattern here runs in linear time.
 * Each check returns a short reason (no value) or undefined when the value is valid.
 */

/** FHIR caps strings at 1 MB. */
export const MAX_STRING_LENGTH = 1024 * 1024;
/** Types without the cap: binary data (attachments) and narrative XHTML aren't strings in FHIR's sense. */
const UNCAPPED = new Set(['base64Binary', 'xhtml']);

const YEAR = '([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)';
const MONTH = '(0[1-9]|1[0-2])';
const DAY = '(0[1-9]|[1-2][0-9]|3[0-1])';
const TIME = '([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\\.[0-9]+)?';
const ZONE = '(Z|(\\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))';

const DATE = new RegExp(`^${YEAR}(-${MONTH}(-${DAY})?)?$`);
const DATE_TIME = new RegExp(`^${YEAR}(-${MONTH}(-${DAY}(T${TIME}${ZONE})?)?)?$`);
const INSTANT = new RegExp(`^${YEAR}-${MONTH}-${DAY}T${TIME}${ZONE}$`);
const TIME_ONLY = new RegExp(`^${TIME}$`);
const CODE = /^\S+(\s\S+)*$/;
const ID = /^[A-Za-z0-9\-.]{1,64}$/;
const URI = /^\S+$/;
const OID = /^urn:oid:[0-2](\.(0|[1-9][0-9]*))+$/;
const UUID = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^[A-Za-z0-9+/=]+$/;
const WHITESPACE = /\s+/g;
// C0 control characters other than tab, LF and CR (the spec says strings SHOULD NOT contain them).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

/** Days in a month, with leap years. */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The regexes accept day 31 in every month; this rejects e.g. 2023-02-30. */
function realDay(value: string): boolean {
  if (value.length < 10) return true;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return day <= daysIn(year, month);
}

function pattern(re: RegExp, reason: string): (v: string) => string | undefined {
  return (v) => (re.test(v) ? undefined : reason);
}

const STRING_CHECKS: Record<string, (v: string) => string | undefined> = {
  string: (v) => (CONTROL.test(v) ? 'contains control characters' : undefined),
  markdown: (v) => (CONTROL.test(v) ? 'contains control characters' : undefined),
  code: pattern(CODE, 'is not a valid code (no leading, trailing or repeated whitespace)'),
  id: pattern(ID, 'is not a valid id (1-64 letters, digits, "-" or ".")'),
  uri: pattern(URI, 'is not a valid uri'),
  url: pattern(URI, 'is not a valid url'),
  canonical: pattern(URI, 'is not a valid canonical'),
  oid: pattern(OID, 'is not a valid oid (urn:oid:...)'),
  uuid: pattern(UUID, 'is not a valid uuid (urn:uuid:..., lowercase)'),
  date: (v) => (DATE.test(v) && realDay(v) ? undefined : 'is not a valid date (YYYY, YYYY-MM or YYYY-MM-DD)'),
  dateTime: (v) =>
    DATE_TIME.test(v) && realDay(v) ? undefined : 'is not a valid dateTime (a time needs seconds and a time zone)',
  instant: (v) => (INSTANT.test(v) && realDay(v) ? undefined : 'is not a valid instant (full date, time and time zone)'),
  time: pattern(TIME_ONLY, 'is not a valid time (hh:mm:ss)'),
  base64Binary: (v) => {
    const compact = v.replace(WHITESPACE, '');
    return compact.length > 0 && compact.length % 4 === 0 && BASE64.test(compact) ? undefined : 'is not valid base64';
  },
  xhtml: (v) => (v.trimStart().startsWith('<div') ? undefined : 'must be an XHTML <div> element'),
};

const NUMBER_CHECKS: Record<string, (v: number) => string | undefined> = {
  decimal: () => undefined,
  integer: (v) => (Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX ? undefined : 'is not a 32-bit integer'),
  unsignedInt: (v) => (Number.isInteger(v) && v >= 0 && v <= INT32_MAX ? undefined : 'is not an integer ≥ 0'),
  positiveInt: (v) => (Number.isInteger(v) && v >= 1 && v <= INT32_MAX ? undefined : 'is not an integer ≥ 1'),
};

/** Checks one primitive JSON value. Returns a reason without the value, or undefined when valid. */
export function checkPrimitive(code: string, kind: PrimitiveKind, value: unknown): string | undefined {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `must be a boolean (${code})`;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `must be a number (${code})`;
      return Object.hasOwn(NUMBER_CHECKS, code) ? NUMBER_CHECKS[code]!(value) : undefined;
    }
    case 'string': {
      if (typeof value !== 'string') return `must be a string (${code})`;
      if (value.length === 0) return 'must not be empty';
      if (value.length > MAX_STRING_LENGTH && !UNCAPPED.has(code)) return 'is longer than 1 MB';
      return Object.hasOwn(STRING_CHECKS, code) ? STRING_CHECKS[code]!(value) : undefined;
    }
  }
}

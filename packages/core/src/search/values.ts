/**
 * Value helpers shared by index extraction and query parsing, so a stored
 * value and a search value are always normalized the same way.
 */

/** Lowercase, strip accents, collapse whitespace: "  Bénédicte  " → "benedicte". */
export function normalizeString(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Date.UTC, but years 0–99 mean themselves (Date.UTC maps them to 1900–1999). */
function utc(year: number, month: number, day = 1, h = 0, mi = 0, s = 0, ms = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(h, mi, s, ms);
  return d.getTime();
}

const DATE_RE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/**
 * A FHIR date, dateTime or instant as a half-open range [low, high) of ISO
 * instants, by its precision: "1974" covers the whole year, "1974-12-25" the day.
 * A dateTime without a timezone is treated as UTC. Returns undefined if invalid.
 */
export function dateRange(value: string): { low: string; high: string } | undefined {
  const m = DATE_RE.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const year = Number(y);
  const month = mo ? Number(mo) - 1 : 0;
  const day = d ? Number(d) : 1;
  if (month > 11 || day < 1 || day > 31) return undefined;
  if (h !== undefined && (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59))) return undefined;

  let offsetMinutes = 0;
  if (tz && tz !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    offsetMinutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  }
  const ms = frac ? Math.round(Number(`0${frac}`) * 1000) : 0;
  const lowMs =
    utc(year, month, day, h ? Number(h) : 0, mi ? Number(mi) : 0, s ? Number(s) : 0, ms) - offsetMinutes * 60_000;
  const low = new Date(lowMs);
  if (Number.isNaN(low.getTime())) return undefined;

  let high: Date;
  if (!mo) high = new Date(utc(year + 1, 0) - offsetMinutes * 60_000);
  else if (!d) high = new Date(utc(year, month + 1) - offsetMinutes * 60_000);
  else if (h === undefined) high = new Date(lowMs + 86_400_000);
  else if (s === undefined) high = new Date(lowMs + 60_000);
  else if (!frac) high = new Date(lowMs + 1_000);
  else high = new Date(lowMs + 1);
  return { low: low.toISOString(), high: high.toISOString() };
}

const NUMBER_RE = /^[+-]?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A decimal search value and the range its precision implies:
 * "100" → [99.5, 100.5), "100.0" → [99.95, 100.05). Values are decimal strings
 * (no floating-point rounding); Postgres compares them as numeric.
 */
export function numberRange(value: string): { value: string; low: string; high: string } | undefined {
  const v = value.trim();
  const m = NUMBER_RE.exec(v);
  if (!m) return undefined;
  const decimals = (m[2]?.length ?? 0) - (m[3] ? Number(m[3]) : 0);
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  // half a unit in the last significant place
  const halfDigits = Math.max(decimals + 1, 0);
  const half = 5 * 10 ** -(decimals + 1);
  return {
    value: v,
    low: (n - half).toFixed(halfDigits),
    high: (n + half).toFixed(halfDigits),
  };
}

const REFERENCE_RE = /(?:^|\/)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/;

/** Splits a literal reference into type and id: `Patient/1`, `https://x/fhir/Patient/1`, `Patient/1/_history/2`. */
export function parseReference(reference: string): { targetType: string; targetId: string } | undefined {
  const m = REFERENCE_RE.exec(reference.trim());
  return m ? { targetType: m[1]!, targetId: m[2]! } : undefined;
}

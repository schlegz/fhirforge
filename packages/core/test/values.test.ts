import { describe, expect, it } from 'vitest';
import { dateRange, normalizeString, numberRange, parseReference } from '../src/search/values.js';

describe('dateRange', () => {
  it('covers the precision of the value', () => {
    expect(dateRange('1974')).toEqual({ low: '1974-01-01T00:00:00.000Z', high: '1975-01-01T00:00:00.000Z' });
    expect(dateRange('1980-02')).toEqual({ low: '1980-02-01T00:00:00.000Z', high: '1980-03-01T00:00:00.000Z' });
    expect(dateRange('1974-12-25')).toEqual({ low: '1974-12-25T00:00:00.000Z', high: '1974-12-26T00:00:00.000Z' });
    expect(dateRange('2026-11-20T09:30:00-08:00')).toEqual({ low: '2026-11-20T17:30:00.000Z', high: '2026-11-20T17:30:01.000Z' });
    expect(dateRange('2026-11-20T09:30:00.123Z')?.high).toBe('2026-11-20T09:30:00.124Z');
  });
  it('handles years below 100 and rejects invalid values', () => {
    expect(dateRange('0050')?.low).toBe('0050-01-01T00:00:00.000Z');
    for (const bad of ['1974-13', '1974-12-32', 'yesterday', '1974-12-25T25:00:00Z', "1974'; DROP"]) {
      expect(dateRange(bad), bad).toBeUndefined();
    }
  });
});

describe('numberRange', () => {
  it('uses the precision implied by significant digits', () => {
    expect(numberRange('100')).toEqual({ value: '100', low: '99.5', high: '100.5' });
    expect(numberRange('100.0')).toEqual({ value: '100.0', low: '99.95', high: '100.05' });
    expect(numberRange('-2.5')).toEqual({ value: '-2.5', low: '-2.55', high: '-2.45' });
    expect(numberRange('1e2')).toBeDefined();
    expect(numberRange('12abc')).toBeUndefined();
  });
});

describe('normalizeString and parseReference', () => {
  it('normalizes case, accents and whitespace', () => {
    expect(normalizeString('  Bénédicte   du  Marché ')).toBe('benedicte du marche');
  });
  it('parses relative, absolute and versioned references', () => {
    expect(parseReference('Patient/123')).toEqual({ targetType: 'Patient', targetId: '123' });
    expect(parseReference('https://example.org/fhir/Patient/123')).toEqual({ targetType: 'Patient', targetId: '123' });
    expect(parseReference('Patient/123/_history/4')).toEqual({ targetType: 'Patient', targetId: '123' });
    expect(parseReference('urn:uuid:61ebe359-bfdc-4613-8bf2-c5e300945f0a')).toBeUndefined();
    expect(parseReference('#contained')).toBeUndefined();
  });
});

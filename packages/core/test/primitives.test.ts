import { describe, expect, it } from 'vitest';
import { checkPrimitive, MAX_STRING_LENGTH } from '../src/validation/primitives.js';

const valid = (code: string, kind: 'string' | 'number' | 'boolean', value: unknown) => checkPrimitive(code, kind, value) === undefined;

describe('checkPrimitive', () => {
  it('checks the JSON kind', () => {
    expect(valid('boolean', 'boolean', true)).toBe(true);
    expect(valid('boolean', 'boolean', 'true')).toBe(false);
    expect(valid('decimal', 'number', 1.5)).toBe(true);
    expect(valid('decimal', 'number', '1.5')).toBe(false);
    expect(valid('decimal', 'number', Number.POSITIVE_INFINITY)).toBe(false);
    expect(valid('string', 'string', 1)).toBe(false);
    expect(valid('string', 'string', '')).toBe(false);
  });

  it('checks integer ranges', () => {
    expect(valid('integer', 'number', -5)).toBe(true);
    expect(valid('integer', 'number', 1.5)).toBe(false);
    expect(valid('integer', 'number', 2 ** 31)).toBe(false);
    expect(valid('unsignedInt', 'number', 0)).toBe(true);
    expect(valid('unsignedInt', 'number', -1)).toBe(false);
    expect(valid('positiveInt', 'number', 1)).toBe(true);
    expect(valid('positiveInt', 'number', 0)).toBe(false);
  });

  it('checks dates, including the calendar', () => {
    for (const ok of ['1974', '1974-12', '1974-12-25', '2024-02-29']) expect(valid('date', 'string', ok), ok).toBe(true);
    for (const bad of ['74', '1974-13', '1974-12-32', '2023-02-29', '2023-04-31', '0000', '1974-12-25T10:00:00Z']) {
      expect(valid('date', 'string', bad), bad).toBe(false);
    }
  });

  it('checks dateTime, instant and time', () => {
    for (const ok of ['2026', '2026-11', '2026-11-20', '2026-11-20T09:30:00Z', '2026-11-20T09:30:00.123-08:00']) {
      expect(valid('dateTime', 'string', ok), ok).toBe(true);
    }
    for (const bad of ['2026-11-20T09:30Z', '2026-11-20T09:30:00', '2026-11-20 09:30:00Z', '2026-11-20T24:00:00Z']) {
      expect(valid('dateTime', 'string', bad), bad).toBe(false);
    }
    expect(valid('instant', 'string', '2026-11-20T09:30:00.5Z')).toBe(true);
    expect(valid('instant', 'string', '2026-11-20')).toBe(false);
    expect(valid('time', 'string', '09:30:00')).toBe(true);
    expect(valid('time', 'string', '9:30')).toBe(false);
  });

  it('checks codes, ids, uris, oids and uuids', () => {
    expect(valid('code', 'string', 'in progress')).toBe(true);
    for (const bad of [' final', 'final ', 'a  b']) expect(valid('code', 'string', bad), bad).toBe(false);
    expect(valid('id', 'string', 'abc-123.x')).toBe(true);
    for (const bad of ['a_b', 'a/b', 'x'.repeat(65)]) expect(valid('id', 'string', bad), bad).toBe(false);
    expect(valid('uri', 'string', 'http://example.org/fhir')).toBe(true);
    expect(valid('uri', 'string', 'http://example.org/a b')).toBe(false);
    expect(valid('oid', 'string', 'urn:oid:1.2.36.1')).toBe(true);
    expect(valid('oid', 'string', '1.2.36.1')).toBe(false);
    expect(valid('uuid', 'string', 'urn:uuid:c757873d-ec9a-4326-a141-556f43239520')).toBe(true);
    expect(valid('uuid', 'string', 'urn:uuid:C757873D-EC9A-4326-A141-556F43239520')).toBe(false);
  });

  it('checks base64, xhtml and string content', () => {
    expect(valid('base64Binary', 'string', 'SGVsbG8=')).toBe(true);
    expect(valid('base64Binary', 'string', 'SGVs\nbG8=')).toBe(true);
    expect(valid('base64Binary', 'string', 'SGVsbG8')).toBe(false);
    expect(valid('base64Binary', 'string', 'SGV$bG8=')).toBe(false);
    expect(valid('xhtml', 'string', '<div xmlns="http://www.w3.org/1999/xhtml">x</div>')).toBe(true);
    expect(valid('xhtml', 'string', '<p>x</p>')).toBe(false);
    expect(valid('string', 'string', 'line\nbreak\ttab')).toBe(true);
    expect(valid('string', 'string', 'bell\u0007')).toBe(false);
  });

  it('caps strings at 1 MB, except binary data and narrative', () => {
    const big = 'a'.repeat(MAX_STRING_LENGTH + 4);
    expect(valid('string', 'string', big)).toBe(false);
    expect(valid('base64Binary', 'string', big)).toBe(true);
  });

  it('runs in linear time on hostile input', () => {
    const started = Date.now();
    const long = '1'.repeat(200_000);
    for (const code of ['date', 'dateTime', 'instant', 'time', 'code', 'oid', 'base64Binary']) {
      checkPrimitive(code, 'string', `${long}x`);
      checkPrimitive(code, 'string', `${' a'.repeat(100_000)} `);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('never includes the value in the reason', () => {
    const reason = checkPrimitive('date', 'string', 'Synthetic-Secret-1974');
    expect(reason).toBeDefined();
    expect(reason).not.toContain('Synthetic-Secret');
  });
});

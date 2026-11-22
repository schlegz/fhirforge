import { assertSecureTransport, inspectPoolTransport, postgresStorage } from '@fhirforge/pg';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const pool = (options: Record<string, unknown>) => ({ options }) as unknown;

describe('TLS enforcement', () => {
  it('allows local connections without TLS', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '/var/run/postgresql']) {
      expect(() => assertSecureTransport(pool({ host }))).not.toThrow();
    }
    expect(() => assertSecureTransport(pool({ connectionString: 'postgres://u:p@localhost:5432/db' }))).not.toThrow();
  });

  it('refuses a remote host without TLS', () => {
    expect(() => assertSecureTransport(pool({ host: 'db.example.com' }))).toThrow(/refusing a non-TLS/);
    expect(() => assertSecureTransport(pool({ connectionString: 'postgres://u:p@db.example.com/db' }))).toThrow();
    // sslmode=prefer does not guarantee encryption.
    expect(() => assertSecureTransport(pool({ connectionString: 'postgres://u:p@db.example.com/db?sslmode=prefer' }))).toThrow();
  });

  it('accepts a remote host with TLS', () => {
    expect(() => assertSecureTransport(pool({ host: 'db.example.com', ssl: true }))).not.toThrow();
    expect(() => assertSecureTransport(pool({ host: 'db.example.com', ssl: { ca: 'x' } }))).not.toThrow();
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      expect(() => assertSecureTransport(pool({ connectionString: `postgres://u:p@db.example.com/db?sslmode=${mode}` }))).not.toThrow();
    }
  });

  it('can be overridden for development', () => {
    expect(() => assertSecureTransport(pool({ host: 'db.example.com' }), { allowInsecure: true })).not.toThrow();
  });

  it('never puts the password in the error', () => {
    try {
      assertSecureTransport(pool({ connectionString: 'postgres://user:s3cret@db.example.com/db' }));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('s3cret');
    }
  });

  it('is applied by postgresStorage to a real pg Pool', async () => {
    const remote = new pg.Pool({ host: 'db.example.com' });
    expect(() => postgresStorage(remote)).toThrow(/refusing a non-TLS/);
    expect(() => postgresStorage(remote, { allowInsecure: true })).not.toThrow();
    expect(inspectPoolTransport(new pg.Pool({ host: 'db.example.com', ssl: true }))?.tls).toBe(true);
    await remote.end();
  });
});

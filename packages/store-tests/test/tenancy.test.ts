import { PGlite } from '@electric-sql/pglite';
import { createFhirStore, FhirError, tenantStores, type FhirStorage } from '@fhirforge/core';
import { createFhirHandler } from '@fhirforge/http';
import { postgresStorage } from '@fhirforge/pg';
import { pgliteStorage } from '@fhirforge/pglite';
import { r4 } from '@fhirforge/r4';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Synthetic data only (see CLAUDE.md).
interface Session {
  user: string;
  tenant?: string;
}

const run = process.pid.toString(36);
const url = process.env.FHIRFORGE_TEST_DATABASE_URL;

/** Each backend: a factory for a tenant's storage (its own schema), raw SQL, and cleanup. */
const setups: { name: string; init(): { storage: (schema: string) => FhirStorage; sql: (q: string) => Promise<unknown[]>; close(): Promise<void> } }[] = [
  {
    name: 'PGlite',
    init() {
      const db = new PGlite();
      return {
        storage: (schema) => pgliteStorage(db, { schema }),
        sql: async (q) => (await db.query(q)).rows,
        close: () => db.close(),
      };
    },
  },
  ...(url
    ? [
        {
          name: 'Postgres',
          init() {
            const pool = new pg.Pool({ connectionString: url, max: 4 });
            const used = new Set<string>();
            return {
              storage: (schema: string) => (used.add(schema), postgresStorage(pool, { schema })),
              sql: async (q: string) => (await pool.query(q)).rows,
              async close() {
                for (const s of used) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
                await pool.end();
              },
            };
          },
        },
      ]
    : []),
];

describe.each(setups)('schema per tenant on $name', (setup) => {
  let env: ReturnType<(typeof setups)[number]['init']>;
  const schemaOf = (tenant: string) => `t_${run}_${tenant}`;
  const makeTenants = () =>
    tenantStores((tenant) =>
      createFhirStore({
        storage: env.storage(schemaOf(tenant)),
        fhir: r4,
        resources: ['Patient', 'Observation'],
        authorize: () => true,
        audit: { table: true, actor: (ctx: Session) => ctx.user },
      }),
    );
  let tenants: ReturnType<typeof makeTenants>;

  beforeAll(async () => {
    env = setup.init();
    tenants = makeTenants();
    const results = await tenants.migrate(['acme', 'globex']);
    expect(Object.keys(results)).toEqual(['acme', 'globex']);
    expect(results.acme!.applied).toContain('audit:1');
  });
  afterAll(() => env.close());

  it('keeps tenants apart: same ids, separate searches, histories and audit tables', async () => {
    const acme = tenants.get('acme').as({ user: 'u-acme' });
    const globex = tenants.get('globex').as({ user: 'u-globex' });
    await acme.update({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Doe' }] });
    await globex.update({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Roe' }] });
    await globex.update({ resourceType: 'Patient', id: 'p1', name: [{ family: 'Roe' }], active: true });

    expect((await acme.read('Patient', 'p1')).name?.[0]?.family).toBe('Doe');
    expect((await globex.read('Patient', 'p1')).meta.versionId).toBe('2');
    expect((await acme.search('Patient', { family: 'roe' })).total).toBe(0);
    expect((await acme.history('Patient', 'p1')).length).toBe(1);
    const actors = await env.sql(`SELECT DISTINCT actor FROM "${schemaOf('acme')}"."_audit"`);
    expect(actors).toEqual([{ actor: 'u-acme' }]);
  });

  it('validates tenant ids without echoing them, and caches one store per tenant', () => {
    expect(tenants.get('acme')).toBe(tenants.get('acme'));
    for (const bad of ['Acme', '../acme', 'acme;drop', '', 'a'.repeat(41), 'synthetic-tenant']) {
      let err: unknown;
      try {
        tenants.get(bad);
      } catch (e) {
        err = e;
      }
      expect(err, bad).toBeInstanceOf(FhirError);
      expect((err as FhirError).message).toBe('Invalid tenant id');
    }
    const small = tenantStores((t) => ({ t, migrate: async () => ({ applied: [] }) }), { maxCached: 2 });
    const a = small.get('a');
    small.get('b');
    small.get('a'); // a is now the most recent
    small.get('c'); // evicts b
    expect(small.size).toBe(2);
    expect(small.get('a')).toBe(a);
    small.forget('a');
    expect(small.get('a')).not.toBe(a);
  });

  it('offboards a tenant by dropping its schema, leaving the others intact', async () => {
    const temp = tenants.get('initech');
    await temp.migrate();
    await temp.as({ user: 'u' }).create({ resourceType: 'Patient' });
    await env.sql(`DROP SCHEMA "${schemaOf('initech')}" CASCADE`);
    tenants.forget('initech');
    // Its tables (and audit table) are gone: the search fails, and so does its audit row; both are reported.
    const gone = await tenants.get('initech').as({ user: 'u' }).search('Patient', {}).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(AggregateError);
    expect(((gone as AggregateError).errors[1] as Error).message).toMatch(/Run store\.migrate\(\) first/);
    expect((await tenants.get('acme').as({ user: 'u' }).read('Patient', 'p1')).id).toBe('p1');
  });

  it('serves every tenant from one REST handler, with the store picked from the caller', async () => {
    const handler = createFhirHandler<never, Session>({
      store: (_request, ctx) => (ctx.tenant ? (tenants.get(ctx.tenant) as never) : undefined),
      basePath: '/fhir',
      // Test-only auth: the tenant comes from the (trusted) session, never from the URL.
      context: (req) => {
        const user = req.headers.get('x-test-user');
        return user ? { user, tenant: req.headers.get('x-test-tenant') ?? undefined } : undefined;
      },
    });
    const get = (path: string, headers: Record<string, string>) => handler(new Request(`https://app.example.org${path}`, { headers }));
    const json = async (path: string, headers: Record<string, string>) => (await (await get(path, headers)).json()) as Record<string, any>;
    const acme = { 'x-test-user': 'u1', 'x-test-tenant': 'acme' };
    expect((await json('/fhir/Patient/p1', acme)).name[0].family).toBe('Doe');
    expect((await get('/fhir/Patient/p1', { 'x-test-user': 'u2', 'x-test-tenant': 'globex' })).status).toBe(200);
    expect((await json('/fhir/Patient?family=roe', acme)).total).toBe(0);
    expect((await get('/fhir/Patient/p1', { 'x-test-user': 'u3' })).status).toBe(403); // no tenant: no store
    expect((await get('/fhir/Patient/p1', { 'x-test-user': 'u4', 'x-test-tenant': 'Bad-Tenant' })).status).toBe(400);
    expect((await get('/fhir/metadata', {})).status).toBe(401); // per-caller store: metadata needs a caller
    expect((await get('/fhir/metadata', acme)).status).toBe(200);
  });
});

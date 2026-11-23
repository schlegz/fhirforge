// Type-level tests for the store API, checked by `pnpm test:types`. Lines with a
// ts-expect-error directive must fail to compile, or the build fails.
import { createFhirStore, tenantStores, type BundleResponse, type FhirStorage, type Stored } from '@fhirforge/core';
import { r4, type Bundle, type Observation, type Patient } from '@fhirforge/r4';
import { createFhirHandler, type FhirHandler } from '@fhirforge/http';
import { expectTypeOf } from 'expect-type';

declare const storage: FhirStorage;
const fhir = createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient', 'Observation'] });

export function httpHandler(): void {
  interface Session {
    userId: string;
  }
  const guarded = createFhirStore({ storage, fhir: r4, resources: ['Patient'], authorize: (_req: { ctx: Session }) => true });
  const handler = createFhirHandler({ store: guarded, basePath: '/fhir', context: (): Session | undefined => ({ userId: 'u1' }) });
  expectTypeOf(handler).toEqualTypeOf<FhirHandler>();
  // Next.js route handlers are (request, context) => Response: the handler fits.
  const GET: (request: Request, context: { params: Promise<{ path?: string[] }> }) => Promise<Response> = handler;
  void GET;
  // @ts-expect-error the context must match the store's Ctx
  createFhirHandler({ store: guarded, basePath: '/fhir', context: () => ({ role: 'x' }) });

  // Multi-tenancy: the store can be picked per caller, typed by the same context.
  const tenants = tenantStores(() => guarded);
  const perTenant = createFhirHandler({
    store: (_request, ctx: Session) => (ctx.userId ? tenants.get('acme') : undefined),
    basePath: '/fhir',
    context: (): Session | undefined => ({ userId: 'u1' }),
  });
  expectTypeOf(perTenant).toEqualTypeOf<FhirHandler>();
  expectTypeOf(tenants.get('acme')).toEqualTypeOf<typeof guarded>();
}

export async function bundles(): Promise<void> {
  // An R4 Bundle is accepted as is; the result is a response Bundle.
  const bundle: Bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [{ resource: { resourceType: 'Patient', gender: 'female' }, request: { method: 'POST', url: 'Patient' } }],
  };
  expectTypeOf(await fhir.transaction(bundle)).toEqualTypeOf<BundleResponse>();
  expectTypeOf(await fhir.batch(bundle)).toEqualTypeOf<BundleResponse>();
  // @ts-expect-error not a Bundle
  await fhir.transaction({ resourceType: 'Patient' });

  // delete takes an optional If-Match.
  await fhir.delete('Patient', '1', { ifMatch: 'W/"2"' });

  // expunge always needs a reason.
  await fhir.expunge('Patient', '1', { reason: 'erasure request' });
  // @ts-expect-error a reason is required
  await fhir.expunge('Patient', '1');
}

export async function includes(): Promise<void> {
  const page = await fhir.search('Observation', { _include: 'Observation:subject' });
  expectTypeOf(page.resources).toEqualTypeOf<Stored<Observation>[]>();
  // Included resources can be any configured type.
  expectTypeOf(page.included).toEqualTypeOf<(Stored<Patient> | Stored<Observation>)[] | undefined>();
}

export async function typed(): Promise<void> {
  // read() returns the version package's type for that resource.
  expectTypeOf(await fhir.read('Patient', '1')).toEqualTypeOf<Stored<Patient>>();
  expectTypeOf(await fhir.read('Observation', '1')).toEqualTypeOf<Stored<Observation>>();

  // Stored<T> guarantees id and server meta.
  const p = await fhir.read('Patient', '1');
  expectTypeOf(p.id).toEqualTypeOf<string>();
  expectTypeOf(p.meta.versionId).toEqualTypeOf<string>();

  // create() infers the resource type from resourceType.
  const created = await fhir.create({ resourceType: 'Patient', gender: 'female' });
  expectTypeOf(created).toEqualTypeOf<Stored<Patient>>();

  // The generated types still apply to input.
  // @ts-expect-error not an AdministrativeGender code
  await fhir.create({ resourceType: 'Patient', gender: 'F' });

  // Only the configured resource types are accepted.
  // @ts-expect-error Encounter is not in `resources`
  await fhir.read('Encounter', '1');
  // @ts-expect-error Encounter is not in `resources`
  await fhir.create({ resourceType: 'Encounter', status: 'planned', class: { code: 'AMB' } });

  // update() needs an id.
  // @ts-expect-error id is required for update
  await fhir.update({ resourceType: 'Patient' });

  // search() returns the stored resource type.
  const found = await fhir.search('Patient', { family: 'doe', _count: 10 });
  expectTypeOf(found.resources).toEqualTypeOf<Stored<Patient>[]>();
  expectTypeOf(found.total).toEqualTypeOf<number | undefined>();

  // Search policy keys are checked against the configured resource types.
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'none' } } });
  // @ts-expect-error Observation is not configured
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Observation.code': 'none' } } });
  // @ts-expect-error not a policy
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patient'], search: { policy: { 'Patient.birthdate': 'hidden' } } });

  // authorize is required: a policy or the explicit 'allow-all'.
  // @ts-expect-error authorize missing
  createFhirStore({ storage, fhir: r4, resources: ['Patient'] });

  // The policy's ctx type flows to as().
  interface Session {
    userId: string;
    patientId?: string;
  }
  const guarded = createFhirStore({
    storage,
    fhir: r4,
    resources: ['Patient'],
    authorize: ({ ctx }: { ctx: Session }) => ctx.userId !== '',
  });
  await guarded.as({ userId: 'u1' }).read('Patient', '1');
  // @ts-expect-error ctx must be a Session
  guarded.as({ user: 'u1' });

  // resources must be real resource types of the version.
  // @ts-expect-error Patiant is not an R4 resource type
  createFhirStore({ authorize: 'allow-all', storage, fhir: r4, resources: ['Patiant'] });
}

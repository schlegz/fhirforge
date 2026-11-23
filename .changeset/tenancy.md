---
"@fhirforge/core": minor
"@fhirforge/http": minor
---

Multi-tenancy, schema per tenant: `tenantStores((tenant) => createFhirStore({ storage: postgresStorage(pool, { schema: `t_${tenant}` }), … }))` validates tenant ids (safe in schema names, never echoed in errors), caches one store per tenant (bounded, least recently used first), and runs `migrate()` across tenants. The REST handler's `store` can now be a function of the request and context, so one handler serves every tenant (no store is a 403). Stores of the same version package now share their compiled validation rules.

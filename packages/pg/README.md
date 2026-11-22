# @fhirforge/pg

Postgres storage for fhirforge: resources as JSONB with full history and search index tables in their own schema, migrations with an advisory lock, optimistic locking, and TLS enforcement for remote connections.

```ts
import pg from 'pg';
import { postgresStorage, migrationSql } from '@fhirforge/pg';

const storage = postgresStorage(new pg.Pool({ connectionString, ssl: true }));
const sql = migrationSql(['Patient', 'Observation']); // plain SQL for your own migration tool
```

A Pool pointing at a non-local host must use TLS (`ssl`, or `sslmode=require` / `verify-ca` / `verify-full`); `{ allowInsecure: true }` overrides it for development only.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.

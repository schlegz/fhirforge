---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

Encryption at rest for resource bodies: `createFhirStore({ encryption: { keys } })`, where `keys` is your KMS as a `KeyProvider` (`wrap` / `unwrap`).
- Every body, current and history, is envelope-encrypted with AES-256-GCM, a random nonce and data keys wrapped by your master key. The ciphertext is bound to its row, so a body copied to another resource or version won't decrypt.
- Data keys are reused for a bounded window (5 minutes or 100,000 encryptions) and cached for reads, so KMS calls stay off the write path and out of transactions.
- Existing plaintext rows stay readable. `store.reencrypt()` encrypts them, and `reencrypt({ olderThan })` rotates to new data keys.
- Search index rows are not encrypted yet (use the `none` policy; `blind` is next).
- New migrations: `resource:<Type>:3` (nullable `enc` / `dek_id` columns) and `crypto:1` (`_data_keys`, only with encryption). The runtime role needs `SELECT, INSERT` on `_data_keys`.
- Breaking for custom storage adapters: new `dataKeys` and `reencrypt` methods, `WriteOptions.seal`, `StoredVersion.sealed`, `reindex(type, index, { open })` and `migrate(types, { encryption })`.

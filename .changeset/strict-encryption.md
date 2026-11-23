---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

Encryption: `encryption.requireEncrypted: true` makes a plaintext body an error on read, so someone with write access to the database can't substitute plaintext for a ciphertext. `reencrypt()` still converts plaintext rows in strict mode. New `store.removeUnusedDataKeys()` deletes data keys older than 48 hours that no row in the schema references. It checks every table with encrypted bodies, so keys used by other stores are kept, and it needs `DELETE` on `_data_keys`. `dataKeyMaxAgeMs` is now capped at 24 hours. For custom storage adapters: a new `removeDataKeys` method.

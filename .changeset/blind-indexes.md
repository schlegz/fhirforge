---
"@fhirforge/core": minor
"@fhirforge/pg": minor
---

The `blind` search policy: a `blind` parameter is indexed as a keyed hash (HMAC-SHA-256) of its normalized value, in a new `<Type>_blind` table, instead of a readable copy. It stays searchable by exact match: string by the whole value (case- and accent-insensitive), token by `code`, `system|code` or `|code`, date at its stored precision. Everything else on a blind parameter (prefix matching, `:contains`, `:exact`, date prefixes, `:not`, `:missing`, `_sort`) is a 400. It needs `encryption.blindIndexKey` (a separate secret with an id stored on each row) and works for string, token and date parameters. After rotating the key, run `reindex()`. New migration `resource:<Type>:4` (the blind table). The runtime role needs `SELECT, INSERT, UPDATE, DELETE` on it, like the other index tables. For custom adapters: `IndexRow` has a `blind` kind, search conditions have a `blind` kind, and `Indexer` may return a promise.

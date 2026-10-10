---
"@ue-shed/game-text": patch
---

Add the package-text layer to the shared string store, with occurrence ID columns, per-package
coverage and gap samples, signature-keyed refresh, parallel cold preparation, and a reusable corpus
oracle adapter. Preserve unchanged packages and publish affected shards together atomically.

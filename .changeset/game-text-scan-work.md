---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": patch
---

Reduce Game Text scan work by deferring native pin diagnostic formatting, skipping projection paths
that produce no text evidence, preparing immutable path columns alongside query indexes, reusing
formatted identities and folder facts, and avoiding redundant trigram-table work and column copies.
Decoded values, coverage diagnostics, query results and persisted snapshot formats remain stable.

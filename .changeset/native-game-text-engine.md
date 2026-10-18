---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

Move Game Text indexing and query execution into the Rust engine. Queries, counts, facets,
groups, focus and exports use scoped native readers; mixed authored-source, String Table and
localization-file updates publish incremental snapshots while existing readers remain pinned.

Game Text query methods now return Effects. Full corpus and localization evidence are explicit
bulk reads, and interactive localization detail is paged in Rust. Remove the public in-memory
query factories, TypeScript index builder, synchronous indexed projections and search worker.
The native executable must support protocol 1.15 and game_text_engine_v1; unavailable or
incompatible native readers produce typed failures without a JavaScript query fallback.

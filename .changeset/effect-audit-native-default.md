---
"@ue-shed/protocol": minor
"@ue-shed/unreal-connection": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/engine": minor
"@ue-shed/cameras": minor
"@ue-shed/game-text": minor
"@ue-shed/localization": patch
"@ue-shed/plugin-distribution": minor
"@ue-shed/map-history": patch
"@ue-shed/config-explorer": minor
"@ue-shed/niagara": minor
"@ue-shed/enhanced-input": minor
---

Complete the TypeScript Effect/error audit and integrate native Game Text indexing in production
hosts. Public schema parsers now return domain errors with the original parse issues. All production
tagged errors carry recovery, retry safety and next-step guidance, with deliberate classification
and cause retention at adapter boundaries. All eight reviewed SDKs enforce named public entry
points and caller documentation, with no grandfathered raw decoder factories. Nested cause
stringification, direct error translations and helper adapters are covered by regression guards.

Use the new `GameTextIndexBuilderLive` layer with the host's `AssetReader`; CLI, Workbench and packed
consumer conformance use the same native implementation. The TypeScript builder remains an explicit
reference choice. Native worker/capability failures do not silently fall back. Scoped cancellation
releases staging, writer leases and processes; native failures use stable codes independent of prose.
PO provenance changes no longer force an otherwise eligible native join to rebuild fully.

Obsolete public `*Shape` aliases are removed from connection, asset reader/Project Index and camera
entry points; use their `*Api` names. Private `columnarTextCorpusQuery` and
`makeGameTextSearchWorker` constructors are no longer exported. See the
[migration guide](../docs/engineering/effect-audit-migration.md) for error and composition changes.

AssetReader test layers now require a complete explicit port, including configuration and projection
operations; omitted operations no longer install runtime "not stubbed" failures. Protocol transport
budget/validator helpers are private to the asset-reader adapter.

Game Text and Enhanced Input distinguish `reader_failed` from `invalid_project`; Game Text workspace
index failures use `index_failed`. Reader recovery guidance and structured causes survive these
translations. Portable localization failures keep installation candidates, authored payloads and
secret configuration private through explicitly sanitized causes.

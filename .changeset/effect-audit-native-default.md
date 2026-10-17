---
"@ue-shed/protocol": minor
"@ue-shed/unreal-connection": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/engine": minor
"@ue-shed/cameras": minor
"@ue-shed/game-text": minor
"@ue-shed/localization": patch
"@ue-shed/plugin-distribution": patch
"@ue-shed/map-history": patch
"@ue-shed/config-explorer": patch
"@ue-shed/niagara": patch
---

Complete the TypeScript Effect/error audit and integrate native Game Text indexing in production
hosts. Public schema parsers now return domain errors with the original parse issues. All production
tagged errors carry recovery, retry safety and next-step guidance, with deliberate classification
and cause retention at adapter boundaries. Entry points list intentional exports and the first
documented API tiers are enforced without grandfathered raw decoders.

Use the new `GameTextIndexBuilderLive` layer with the host's `AssetReader`; CLI, Workbench and packed
consumer conformance use the same native implementation. The TypeScript builder remains an explicit
reference choice. Native worker/capability failures do not silently fall back. Scoped cancellation
releases staging, writer leases and processes; native failures use stable codes independent of prose.
PO provenance changes no longer force an otherwise eligible native join to rebuild fully.

Obsolete public `*Shape` aliases are removed from connection, asset reader/Project Index and camera
entry points; use their `*Api` names. Private `columnarTextCorpusQuery` and
`makeGameTextSearchWorker` constructors are no longer exported. See the
[migration guide](../docs/engineering/effect-audit-migration.md) for error and composition changes.

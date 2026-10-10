---
"@ue-shed/protocol": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/unreal-assets": minor
---

Saved-world reads now produce contract 2.1, which only adds optional fields. Each actor reports
`decode` (`complete` or `partial`), its saved `parentComponent`, and `heldBy` when a child-actor
component that names it in `ChildActor` belongs to another saved actor. The result lists every
unreadable package or export in `packageErrors`, with its category, detail and whether an actor was
lost, instead of only counting them in a diagnostic. 2.0 documents still decode; consumers that
pin `minor: 0` must accept `1`.

The reader decodes `FIntPoint`, `FColor`, `FLinearColor`, `FBox2D` and `FMatrix` inside arrays,
sets and maps, where they are always binary. An unknown struct inside a container that does not
decode as a tagged stream now skips only its property, with the reason recorded, rather than
failing the export. Landscape heightmap edge-fixup exports, which hold only native binary, are
skipped instead of reported as failures.

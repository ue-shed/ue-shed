---
"@ue-shed/protocol": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/unreal-assets": minor
---

Saved-world reads now produce contract 2.1, which only adds optional fields. Each actor reports
`decode` (`partial` when its export or a subobject failed or kept a property value undecoded), its
saved `parentComponent`, and `heldBy` when a child-actor component that names it in `ChildActor`
belongs to another saved actor. The result lists every unreadable package or export in
`packageErrors`, with its category, detail and whether an actor may have been lost, instead of only
counting them in a diagnostic. Exports that decoded with undecoded property values are listed with
category `skipped_property`; they do not make the package partial. 2.0 documents still decode; consumers that
pin `minor: 0` must accept `1`.

The reader decodes `FIntPoint`, `FColor`, `FLinearColor`, `FBox2D` and `FMatrix` inside arrays,
sets and maps, where they are always binary. An unknown struct inside a container decodes as a
tagged stream only when the container's tag proves it; otherwise only its property is skipped, with
the reason recorded, rather than failing the export or guessing. Landscape heightmap edge-fixup exports, which hold only native binary, are
skipped instead of reported as failures.

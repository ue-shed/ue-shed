# `uasset-parser`

The portable saved-package parser for UE Shed. It provides the `uasset` Rust library and the native
CLI used by `@ue-shed/unreal-assets` for editor-free `inspect` and `authoring` operations.

The parser remains behind a versioned JSON process boundary. TypeScript packages consume that
contract rather than Rust implementation details, and the crate has no Workbench dependency. The
library is also required to compile for `wasm32-unknown-unknown`; package bytes, not filesystem or
process authority, are its reusable input boundary.

## What it decodes

Every classic saved package, including levels. `.umap` and `.uasset` are the same container, and
`scan`/`catalog` enumerate both. Class-specific decoders in `src/asset.rs` handle DataTable,
CompositeDataTable, CurveTable, DataAsset, StringTable, UserDefinedEnum, UserDefinedStruct, and
Skeleton; **every other class falls through to the generic UObject tagged-property decoder.** The
class constants at the top of `asset.rs` are dispatch targets, not a supported-type allowlist —
`is_generic_uobject_class` is a permissive default. Reading that list as the scope of the parser is
wrong: `uasset inspect Content/.../L_CameraLoad.umap` decodes 16,525 exports across 29 classes
(actors, components, `Level`, `World`, `WorldSettings`) with no level-specific code, and
`pnpm test:uasset-conformance` pins that decode against Unreal's own serializer.

The real boundary is native serialization, not asset type. Classes with a custom `UObject::Serialize`
append binary after their tagged properties, which the parser preserves as `tail_bytes` instead of
decoding — `UModel`'s BSP arrays are the clearest example. A non-zero `tail_bytes` therefore means
"undecoded native payload", not "failed parse", and `status: "ok"` is still correct alongside it.

## Saved maps

`uasset saved-world <project-root> <map-path> --format json` is a narrow projection for offline map
review. A conventional level is read from its single `.umap`; a World Partition map derives and
reads only its matching `Content/__ExternalActors__/...` subtree. It resolves actor root-component
positions from saved scene-component properties and attachment references. It does not scan
unrelated packages and never launches Unreal.

The output is authority-tagged as `project_files` and distinguishes resolved positions from missing
roots, missing attachment parents, cycles, ambiguous component paths, and unsupported absolute
rotation/scale composition. It intentionally does not claim live bounds, live actor IDs, focus, or
camera framing authority. The default 100,000-package limit is explicit and can be reduced or raised
with `--maximum-assets`.

This code was extracted from the pre-publication `ue-parser` development repository after UAsset
and UTrace grew into separate products. UTrace parsing and dashboards are intentionally not part of
this crate. The extracted parser code retains its MIT license.

Build the CLI from the repository root:

```text
cargo build --release -p uasset-parser
```

The executable is written to `target/release/uasset` (`uasset.exe` on Windows).

Verify the portable library target with:

```text
rustup target add wasm32-unknown-unknown
cargo check --locked -p uasset-parser --lib --target wasm32-unknown-unknown
```

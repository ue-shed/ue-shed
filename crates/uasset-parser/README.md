# `uasset-parser`

The portable saved-package parser for UE Shed. It accepts bounded package bytes and produces
parsed Unreal package structures and parser diagnostics. It does not open paths, discover a
project, start processes, schedule work, or choose product projections.

`uasset-inspection` interprets these parsed structures as generic inspection, authoring, text,
texture, and saved-world results. `uasset-io` owns filesystem access, project discovery,
concurrency, cache participation, and the native `uasset` process/protocol boundary. TypeScript
packages consume the versioned protocol rather than Rust implementation details.

## What it decodes

Every classic saved package, including levels. `.umap` and `.uasset` use the same package
container. Class-specific decoders in `src/asset.rs` handle DataTable, CompositeDataTable,
CurveTable, DataAsset, StringTable, UserDefinedEnum, UserDefinedStruct, and Skeleton; every other
class falls through to the generic UObject tagged-property decoder. The class constants at the
top of `asset.rs` are dispatch targets, not a supported-type allowlist: level packages can decode
thousands of exports across many classes without level-specific parser code.

The boundary is native serialization, not asset type. Classes with a custom `UObject::Serialize`
append binary after their tagged properties; the parser preserves that data as `tail_bytes` rather
than pretending to decode it. A non-zero `tail_bytes` therefore means "undecoded native payload",
not "failed parse".

## Portable boundary

The library compiles for `wasm32-unknown-unknown`. Package bytes, not filesystem or process
authority, are its reusable input boundary:

```text
cargo check --locked -p uasset-parser --lib --target wasm32-unknown-unknown
```

The `uasset-inspection-wasm` binding accepts those bytes from its host and returns the same
schema-versioned inspection evidence as the native inspection layer. It does not own filesystem
discovery, scanning, caching, or subprocess authority.

Build the native diagnostic executable from the repository root with:

```text
cargo build --release -p uasset-io
```

The executable is written to `target/release/uasset` (`uasset.exe` on Windows).

# `uasset-parser`

The portable saved-package parser for UE Shed. It accepts bounded package bytes and produces
parsed Unreal package structures and parser diagnostics. It does not open paths, discover a
project, start processes, schedule work, or choose product projections.

`uasset-inspection` interprets these parsed structures as generic inspection, authoring, text,
texture, and saved-world results. `uasset-io` owns filesystem access, project discovery,
concurrency, cache participation, and the native `uasset` process/protocol boundary. TypeScript
packages consume the versioned protocol rather than Rust implementation details.

Native inspection, project IO, Blueprint inspection, and WASM use the embedded UE 5.7 source model
by default. The analyzer derives class inheritance and native serialization layouts from configured
Unreal source; runtime decoding consumes the committed model without an engine installation.
Explicit `SchemaProvider` inputs can extend project-native class coverage. Classes outside that
model retain compatibility decoding and explicit opaque evidence. See
[`uasset-source-gen`](../uasset-source-gen/README.md) for regeneration and conformance.

## What it decodes

Every classic saved package, including levels. `.umap` and `.uasset` use the same package
container. Class-specific decoders in `src/asset.rs` handle DataTable, CompositeDataTable,
CurveTable, DataAsset, StringTable, UserDefinedEnum, UserDefinedStruct, and Skeleton; every other
class falls through to the generic UObject tagged-property decoder. The class constants at the
top of `asset.rs` are dispatch targets, not a supported-type allowlist: level packages can decode
thousands of exports across many classes without level-specific parser code.

`AnimSequence` has a narrow UE 5.7 uncooked-editor decoder. It preserves the tagged properties and
consumes the native trailer containing the object GUID, skeleton GUID, strip flags, empty deprecated
raw-track array, and compressed-data presence flag. UE 5.7 source tracks remain in the separately
exported animation data model and are still available through generic inspection. Cooked compressed
streams and legacy inline raw tracks are rejected explicitly rather than partially interpreted.

The boundary is native serialization, not asset type. Classes with a custom `UObject::Serialize`
append binary after their tagged properties; the parser preserves that data as `tail_bytes` rather
than pretending to decode it. A non-zero `tail_bytes` therefore means "undecoded native payload",
not "failed parse".

UE 5.7 inspection also decodes rich keys in CurveFloat/CurveVector/CurveLinearColor, Skeleton raw
reference transforms and name indices, float/double Sequencer channels, bounded InstancedStruct
values, and saved package/object annotations. Numeric layouts reuse the source model's common
native reader. Unknown InstancedStruct payloads preserve type and byte-size evidence. These are
saved values, without curve evaluation or an editing contract. See the
[source-model coverage matrix](../uasset-source-gen/README.md#expanded-native-coverage).

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

# `@ue-shed/uasset-inspection-wasm`

Portable WebAssembly inspection for classic, uncooked, versioned Unreal package bytes. The package
accepts a `Uint8Array` and a display path; it does not discover files, read project roots, run
processes, maintain caches, or write assets.

The first public contract is deliberately small:

- generic inspection returns schema 8;
- `extractText`, `extractTextures`, `extractLevelSequences`, `extractBlueprints`, and `extractAnimations` return compact
  schema-1 envelopes;
  LevelSequence records use schema 4 and include saved scalar/transform channels, nested-sequence and cinematic-shot semantics plus
  a recursive inventory of every decoded object, soft-object, and DataTable-row reference in the
  package;
- malformed, unsupported, partial, and resource-limited packages are represented as typed result
  values;
- cooked, unversioned, IoStore/Zen, swapped-endian, and native bulk-data decoding remain outside
  the parser boundary.

Level Sequence reference inventory walks structs, arrays, sets, and map keys and values. Every
reference records its owning object/class, precise property path, target, kind, and whether the
target is internal to the package or external. `reference_coverage_gaps` identifies raw property
values, native object tails, or unresolved package indices that could conceal or prevent resolving
a reference; an empty list means the inventory is complete for the saved package's decoded property
surface. It does not recursively load referenced packages or evaluate Sequencer bindings.

Scalar float/double and 3D transform sections expose `numeric_channels`: section-local frame keys,
values, interpolation/tangent modes, weighted tangents, nullable defaults, extrapolation, channel tick
resolution, and ShowCurve. Indexed paths such as `Translation[0]` preserve axis identity. `enabled`
is true for scalar channels, or the saved transform mask bit (null when unavailable). Missing channels and unsupported
sections remain explicit coverage gaps; no editor defaults or evaluated world transforms are invented.
Consumers upgrading from schema 3 must accept the new track kinds and required channel arrays.
The language-neutral record schema is published at
`@ue-shed/uasset-inspection-wasm/contracts/level-sequence.v4.schema.json`.

`extractAnimations` joins AnimSequence exports to their saved AnimationSequencerDataModel and FK
Control Rig section. Schema-1 records include duration, frame rate/count, rate scale, looping,
skeleton references, bone tracks, float-curve names/key counts, absolute notify timing, and
root-motion settings. Absent saved properties stay null with coverage gaps; unknown data models
and unsupported notify timing make the summary partial. It does not load dependencies or evaluate
poses. The record contract is published as `contracts/animation.v1.schema.json`. The same method
is available on Node/browser runtimes and their convenience exports; native CLI parity is checked
with `uasset animation <path> --format json`.

Generic inspection also decodes InstancedPropertyBag descriptors and bounded values through the
existing `native_struct` representation: `CustomVersion`, `HasData`, and, for populated bags,
`Descriptors` and `Value`. Descriptors retain GUIDs, value types, references, container types and
saved metadata. UE 5.8 adds property flags and map key descriptors. Empty bags have no value field;
unknown custom versions remain explicit unsupported evidence. These values are parameters as saved,
without StateTree/PCG evaluation.

The default input and serialized-output limit is 64 MiB. The Rust adapter also bounds package
exports and compact projection records. JavaScript rejects an oversized `Uint8Array` before
wasm-bindgen copies it into WebAssembly linear memory, and Rust stops JSON serialization when the
output cap is reached instead of first constructing an oversized string.

These public limits compose with the parser's own `ArchiveLimits`: declared table/container counts
are rejected before allocation, and nested property types, values, and struct fields are bounded by
the parser. The WASM adapter calls the same `Package::parse` and `decode_export` paths; it adds host
input/output, export, and projection caps rather than duplicating parser nesting or allocation
policy.

## Node

```js
import {
	createNodeRuntime,
	inspect,
	extractText,
	extractTextures,
	extractLevelSequences,
	extractBlueprints
} from "@ue-shed/uasset-inspection-wasm/node";

const runtime = createNodeRuntime();
const bytes = new Uint8Array(await readFile("Content/Fixture/Example.uasset"));
const inspection = runtime.inspect("Content/Fixture/Example.uasset", bytes);
const text = runtime.extractText("Content/Fixture/Example.uasset", bytes);
const sequences = runtime.extractLevelSequences("Content/Fixture/Example.uasset", bytes);
const blueprints = runtime.extractBlueprints("Content/Fixture/Example.uasset", bytes);

// The root Node entry exposes the same operations when a configured runtime is not needed.
const sameInspection = inspect("Content/Fixture/Example.uasset", bytes);
void extractTextures;
void extractLevelSequences;
void extractBlueprints;
void sequences;
void blueprints;
void sameInspection;
```

## Browser

Use the explicit browser entry so bundlers do not select the Node loader:

```js
import { createBrowserRuntime } from "@ue-shed/uasset-inspection-wasm/browser";

const runtime = await createBrowserRuntime();
const bytes = new Uint8Array(await (await fetch("/assets/Example.uasset")).arrayBuffer());
const inspection = runtime.inspect("Example.uasset", bytes);
```

The browser entry loads its adjacent `.wasm` file using `import.meta.url`. Servers should serve
`.wasm` with `application/wasm`; the generated loader falls back to an ordinary fetch when
streaming instantiation is unavailable.

`WasmInputLimitError`, `WasmOutputLimitError`, `WasmProtocolError`, and
`WasmInitializationError` are thrown for host/runtime failures. Parser failures are returned as
`status: "error"` values with schema-specific `kind` fields, so malformed input does not require
exception-based control flow.

The npm package is MIT licensed. It is a read-only bytes-to-evidence adapter and does not publish
the private Rust crate to crates.io.

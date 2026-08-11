# `@ue-shed/uasset-inspection-wasm`

Portable WebAssembly inspection for classic, uncooked, versioned Unreal package bytes. The package
accepts a `Uint8Array` and a display path; it does not discover files, read project roots, run
processes, maintain caches, or write assets.

The first public contract is deliberately small:

- generic inspection returns schema 8;
- `extractText`, `extractTextures`, and `extractLevelSequences` return compact schema-1 envelopes;
  LevelSequence records use schema 3 and include nested-sequence and cinematic-shot semantics plus
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
	extractLevelSequences
} from "@ue-shed/uasset-inspection-wasm/node";

const runtime = createNodeRuntime();
const bytes = new Uint8Array(await readFile("Content/Fixture/Example.uasset"));
const inspection = runtime.inspect("Content/Fixture/Example.uasset", bytes);
const text = runtime.extractText("Content/Fixture/Example.uasset", bytes);
const sequences = runtime.extractLevelSequences("Content/Fixture/Example.uasset", bytes);

// The root Node entry exposes the same operations when a configured runtime is not needed.
const sameInspection = inspect("Content/Fixture/Example.uasset", bytes);
void extractTextures;
void extractLevelSequences;
void sequences;
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

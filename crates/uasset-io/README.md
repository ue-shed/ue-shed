# `uasset-io`

Filesystem and process-facing execution for saved Unreal packages. This crate owns project
discovery, bounded file reads, cache/signature work, concurrency, protocol framing, and the
native `uasset` executable boundary. It delegates package meaning to `uasset-parser` and portable
projections to `uasset-inspection`.

The Project Index uses an immutable binary Catalog with no database engine in the default build.
Native IO requires Rust 1.89. `cargo test -p uasset-io --features catalog-oracle` additionally runs
the SQLite adapter and differential tests. See
[the storage guide](../../docs/engineering/binary-project-index.md) for persistence, recovery, and limits.

The `uasset protocol` command accepts one bounded JSON request on stdin and emits validated
newline-delimited events on stdout. The contract and shared fixtures live in
`packages/protocol/contracts/uasset-io/v1/`. Human commands remain diagnostic compatibility
commands; the public TypeScript reader uses the protocol mode.

`uasset protocol-session` accepts one bounded request per input line and completes each response
before reading the next. It supports inspection, authoring, and Project Index queries so a scoped
client can amortize process startup without allowing unbounded concurrent decode work. Batched scans
continue to use the one-request `protocol` command.

Every protocol operation runs through the typed Rust executor: inspection, authoring, header/full
scans, filters, cache, inventory, text/texture extraction, and saved-world inspection. The
protocol adapter serializes typed result frames directly at the stdout boundary, without an
intermediate dynamic JSON tree. Typed inspection projects from the parser's decoded model directly
into the protocol model instead of constructing and recursively adapting the separate generic
inspection DTO. Human commands are thin diagnostic adapters over the same executors.

```sh
cargo test -p uasset-io
cargo run -p uasset-io -- protocol < request.json
```

`uasset animation <asset.uasset|-> --format json` emits schema-1 animation summaries from the
portable inspection library. Exit 0 means complete saved evidence; exit 6 means partial coverage.
This diagnostic CLI command accepts bounded file/stdin bytes. It does not add a protocol operation.

DataTable authoring and typed inspection now delegate to `uasset-inspection::authoring` and
`uasset-inspection::saved_inspection`. `protocol_result` re-exports their existing wire models.
IO owns file reads, cancellation tokens and failure mapping; portable projection calls receive
small checkpoint closures. No NDJSON or TypeScript protocol schema changed. Native fixture tests
compare the portable snapshot's JSON structurally with the file-reading authoring wrapper.

Text, texture and saved-world wire models and their pure conversions now belong to
`uasset-inspection::text_wire`, `texture_wire` and `saved_world_wire`. These modules sit beside the
portable evidence projections because they preserve the native protocol's serde contract without
changing the evidence models serialized by WASM. `protocol_result` re-exports all moved types,
including the saved-world contract, authority, diagnostics and summary family.

`direct_executor/project_io` retains the text/texture event builders and package/status envelopes,
scanning, filters, header-cache adaptation, roots, limits, signatures, manifests, saved-world
filesystem enumeration and progress. These operations frame or describe native IO.
Projection diagnostics, error vocabulary and failure mapping remain here because they report
native execution failures; the WASM adapter does not need these mappings.

The remaining adapter audit found:

- `project_index_io::to_protocol_*` and dictionary-page encoding adapt Catalog query/refresh results,
  so they remain with the filesystem-backed index and its protocol seam.
- `direct_executor::summary_diagnostics` adapts scan diagnostics, so it remains with scan framing.
- The `protocol_adapter` event/contract helpers remain process framing. Its test-only generic
  inspection adapter remains an independent oracle for typed-inspection parity.
- `legacy` retains CLI argument, human-text and JSON event presentation; it defines command output
  framing rather than portable saved-asset meaning.
- Blueprint and Level Sequence executors already return portable projection models directly;
  their reads, cancellation and diagnostic handling remain IO.

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

The remaining pure text/texture and saved-world conversion helpers in `direct_executor/project_io`
adapt already-portable projections into IO protocol result/event models. Moving those requires
moving their protocol model families too; they remain at this boundary. Scanning, filtering,
Catalog/index work and saved-world filesystem enumeration stay in IO.

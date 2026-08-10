# `uasset-io`

Filesystem and process-facing execution for saved Unreal packages. This crate owns project
discovery, bounded file reads, cache/signature work, concurrency, compact projections, and the
native `uasset` executable boundary. It delegates package meaning to `uasset-parser` and portable
projections to `uasset-inspection`.

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
intermediate dynamic JSON tree. Human commands are thin diagnostic adapters over the same
executors.

```sh
cargo test -p uasset-io
cargo run -p uasset-io -- protocol < request.json
```

# `uasset-io`

Filesystem and process-facing execution for saved Unreal packages. This crate owns project
discovery, bounded file reads, cache/signature work, concurrency, compact projections, and the
native `uasset` executable boundary. It delegates package meaning to `uasset-parser` and portable
projections to `uasset-inspection`.

The `uasset protocol` command accepts one bounded JSON request on stdin and emits validated
newline-delimited events on stdout. The contract and shared fixtures live in
`packages/protocol/contracts/uasset-io/v1/`. Human commands remain diagnostic compatibility
commands; the public TypeScript reader uses the protocol mode.

Protocol inspection and unfiltered full scans run through the typed Rust executor. Filtered,
cached, inventory, and compact projection operations still use the compatibility worker.

```sh
cargo test -p uasset-io
cargo run -p uasset-io -- protocol < request.json
```

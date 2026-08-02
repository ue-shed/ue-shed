# `uasset-inspection`

Portable projections over parsed Unreal package values. This crate owns generic inspection,
authoring, text, texture, and saved-world result shapes; it does not open paths, enumerate a
project, start processes, or schedule work.

The crate depends on `uasset-parser` for bounded package decoding and remains usable from the
native reader and the `uasset-inspection-wasm` binding. Filesystem and concurrency work belongs in
`uasset-io`.

`generic::inspect_bytes` is the typed Rust entry point. `generic::inspect_bytes_json` is kept for
the WASM and compatibility adapters; native protocol execution should not serialize and decode
that JSON shape again.

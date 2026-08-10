# `uasset-inspection`

Portable projections over parsed Unreal package values. This crate owns generic inspection,
authoring, text, texture, and saved-world result shapes; it does not open paths, enumerate a
project, start processes, or schedule work.

The crate depends on `uasset-parser` for bounded package decoding and remains usable from the
native reader and the `uasset-inspection-wasm` binding. Filesystem and concurrency work belongs in
`uasset-io`.

`generic::inspect_bytes` is the typed Rust entry point. JSON-only callers use
`generic::write_inspection_json`, which decodes, serializes, and drops one export at a time without
constructing the owned inspection DTO tree. Its caller-owned writer keeps native output atomic and
lets the WASM adapter enforce its byte ceiling. `generic::inspect_bytes_json` is the convenient
string-returning compatibility wrapper; native protocol execution should consume the typed result
instead of serializing and decoding this JSON shape again.

# `uasset-inspection`

Portable projections over parsed Unreal package values. This crate owns generic inspection,
authoring, text, texture, animation, and saved-world result shapes; it does not open paths, enumerate a
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

`animation::inspect_animation_bytes` returns schema-1 saved animation summaries. It joins each
AnimSequence to its exported AnimationSequencerDataModel, MovieScene, and first FK Control Rig
section. Timing, bone/float-curve inventory, absolute notify times, skeleton references, and
root-motion settings retain saved provenance. Missing properties and unsupported data models are
explicit coverage gaps; no CDO defaults, poses, external packages, or compressed tracks are evaluated.
`animation::project_animations` accepts an already decoded package for library callers.

`authoring::inspect_authoring_bytes` returns the saved-file authoring contract 2.1 snapshot
for exactly one DataTable or Composite DataTable. `authoring::project_authoring_table` accepts
typed inspection evidence, preserving native field order, diagnostic codes, partial coverage,
special float representations and unavailable schema/fingerprint evidence. The mechanical move
retains the existing typed-inspection coupling rather than changing native snapshot semantics.
`saved_inspection` owns that typed projection and its serde models; it projects directly from
decoded parser values. Optional checkpoint closures allow IO cancellation without a portable
dependency on cancellation tokens, files, processes or scheduling.

`text_wire`, `texture_wire` and `saved_world_wire` own the native saved-text, saved-texture and
saved-world serde model families and the pure evidence-to-wire conversions. The names distinguish
the preserved native wire contract from the existing `projection` and `saved_world` evidence
models. Text occurrence/coverage-gap mapping, texture record/evidence mapping and its private
`TextureWire` trait, and saved actor/transform mapping require no IO. The saved-world family also
includes its authority, contract, diagnostics and summary types. Native `uasset-io::protocol_result`
re-exports the types and retains result/event envelopes, file enumeration and failure mapping.

Unit tests assert serialized JSON strings, including field order, every enum variant, empty/default
text notes and omitted versus present saved-world options. All moved serde attributes are retained.
WASM still serializes its existing text/texture evidence models; adopting the matching wire models
there is a possible follow-up, outside this ownership change.

# `uasset-inspection-wasm`

WebAssembly bindings for UE Shed's portable UAsset inspection projections.

The binding accepts package bytes supplied by its host. It does not discover files, read project
roots, run processes, or own caches. Native project work belongs to `uasset-io`; package decoding
belongs to `uasset-parser`; generic and compact projections belong to `uasset-inspection`.

`extract_blueprints(path, bytes)` returns the same bounded schema-1 saved-graph projection used by
the native protocol. It targets the supported uncooked UE 5.7 saved-revision window and reports
unresolved references, unprojected native property payloads, or native node-subclass tails as
coverage gaps; it does not compile, mutate, or save Blueprints. Control Rig remains a separate
RigVM serialization surface.

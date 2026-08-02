# `uasset-inspection-wasm`

WebAssembly bindings for UE Shed's portable UAsset inspection projections.

The binding accepts package bytes supplied by its host. It does not discover files, read project
roots, run processes, or own caches. Native project work belongs to `uasset-io`; package decoding
belongs to `uasset-parser`; generic and compact projections belong to `uasset-inspection`.

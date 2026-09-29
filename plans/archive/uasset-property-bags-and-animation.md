# Property bags and saved animation summaries

Implement approved ranking items 4 and 5 after commit `365bf46f`.

Status: DONE — verified 2026-09-29.

- [x] Decode `FInstancedPropertyBag` descriptors, metadata, references and bounded tagged values.
- [x] Source-check the UE 5.7 custom-version-3 and UE 5.8 custom-version-5 layouts separately.
- [x] Exercise empty bags, scalar/container values, nested structs, references, metadata and malformed inputs.
- [x] Project saved AnimSequence timing, data-model track/curve inventory, notifies, skeleton references and root-motion settings.
- [x] Publish a versioned animation contract and expose the projection through native CLI and WASM.
- [x] Generate real fixtures and fresh-process Unreal API evidence on UE 5.7 and UE 5.8.
- [x] Verify focused tests, native/WASM parity, packed contracts and `pnpm check`.

Preserve unsupported evidence. Do not evaluate animation, load skeleton dependencies, infer absent
CDO defaults, or evaluate StateTree/PCG parameters. Keep all implementation usable without Workbench.

Property bags use a counted descriptor array followed by a sized tagged value stream. UE 5.8 adds
descriptor flags and map key types; unsigned descriptor type IDs also differ. Select by the saved
custom version rather than treating matching package revisions as equivalent layouts.

Verification: `pnpm test:uasset-engine-matrix` passed on UE 5.7.4 and 5.8.2, including
source-model checks, fresh asset generation, fresh-process Unreal API evidence, nine semantic
parity tests and native/WASM comparisons across sixteen fixtures. Packed Node/browser exports,
JSON Schema validation, Chromium smoke tests and malformed property-bag tests passed. The full
`pnpm check` passed, including 218 Vitest files / 1,289 tests (14 files / 50 optional tests skipped).
Logs: `out/property-bags-animation/check.log`; engine evidence: `out/uasset-engine-matrix-BSciRX`.

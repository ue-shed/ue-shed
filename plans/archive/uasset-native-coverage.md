# Shared native parser coverage

Extend the source-model experiment on UE 5.7 classic uncooked packages with the five
approved capabilities. Keep generic properties, native evidence, and domain projections
distinct. Unknown layouts and unsupported inner types remain explicit evidence.

## Work

- [x] Shared numeric/native struct layouts and property evidence, including recursive traversal.
- [x] CurveFloat, CurveVector, CurveLinearColor: semantic rich curve keys.
- [x] Skeleton: raw reference poses and bone-name lookup map.
- [x] Sequencer: float/double channels, keys, tangents, defaults and extrapolation.
- [x] InstancedStruct: selected type, bounded inner value and explicit unsupported payloads.
- [x] Package metadata: package and object annotation maps.
- [x] Unreal fixtures, fresh-process evidence, malformed/boundary tests for each capability.
- [x] Native/WASM/public contract parity, documentation, targeted checks and full local gate.

## Acceptance

Each capability must expose useful saved values through the library, native inspection,
and WASM. Derived layouts must reuse the common native reader where applicable. Fresh
Unreal evidence independently checks saved semantic values. Preserve existing behavior
and report partial support honestly; no cooked data or runtime evaluation is implied.

## Environment

Worktree: `D:/git/ue-shed-source-codegen`, branch `experiment/uasset-source-codegen`.
The original main checkout has unrelated user edits and must remain untouched.
Local engine source is a development input only; generated models and product code must
not embed its machine path. Local verification logs live under ignored `out/source-codegen`.

## Completed validation

Completed 2026-09-19. All five capabilities are available in generic native, IO, and WASM inspection.
Six small fixtures were built and saved by UE 5.7, then reloaded in a separate process. Semantic
comparison used that fresh API evidence. Both committed source models passed regeneration checks.
Malformed payloads, custom versions, bounds, unsupported values, recursive text traversal, and
wire discriminators have regression coverage. Native/WASM parity passed for all 15 selected assets.

All `pnpm check` stages passed. The final run reached formatting after passing the Rust, WASM,
TypeScript, architecture, licensing, public packaging, and copied Data Authoring adoption checks.
After formatting these notes, `format:check`, `contract:check`, and the complete `pnpm test` suite
were rerun successfully (1,241 passed; 50 opt-in tests skipped). Focused Unreal conformance ran
separately; remote editor and Perforce integration gates were not enabled.

Numeric channels also decode inside the existing animation fixture. The compact Sequencer product
projection still treats numeric tracks structurally; the new channel values live in generic
inspection. Later Skeleton bytes and unsupported native InstancedStruct bodies remain explicit.

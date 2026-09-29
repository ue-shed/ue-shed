# Saved discrete Sequencer channels

Status: DONE (2026-09-30). Implemented and verified locally.

Answer which boolean, integer and byte/enum values and defaults are saved at which local frames.
Include visibility sections and enum references. Use existing tagged-property decoding where the
engine uses reflected fields; retain absent/default-elided evidence and unsupported sections.
Editing, compilation, interpolation, blending and playback are out of scope.

- [x] Verify declarations on UE 5.7 and 5.8 and include them in source-model conformance.
- [x] Generate a small sequence covering keyed, default-only, empty and boundary-value channels;
      reload in a fresh process and emit independent Unreal API evidence.
- [x] Project typed discrete channels from decoded values with explicit malformed/missing coverage.
- [x] Update versioned native/WASM/protocol contracts and existing inspection consumers.
- [x] Verify focused malformed-input, native/WASM/oracle, comparison and consumer tests.
- [x] Run the full portable gate and the UE 5.7/5.8 engine matrix; archive results.

## Implementation

The generated source model now includes `FMovieSceneBoolChannel`, `FMovieSceneIntegerChannel`,
and `FMovieSceneByteChannel`. Both engines serialize these as reflected tagged fields, so they
reuse the generic property decoder. The real bool-channel fixture exposed a container bug:
`FBoolProperty::SerializeItem` consumes one byte per container value, while scalar tagged bools
use tag flags. The fix covers array/set/map values, nonzero truth values and truncated payloads.

Level Sequence schema 5 adds typed `discrete_channels` for bool, integer, byte/enum and visibility
sections. It retains saved keys, defaults, presence flags, enum references, extrapolation names,
integer interpolation flags and external inversion flags. Nullable properties remain absent or
undecodable evidence. Omitted key arrays differ from explicitly saved empty arrays; an entirely
elided channel produces a coverage gap. No constructor/CDO defaults or evaluated values are inferred.

Native IO, WASM, public readers, saved comparisons, CLI output and the Workbench viewer consume the
same projection. The WASM item limit includes discrete channels and keys. The historical schema-4
file remains published; current consumers and fixtures use schema 5 and IO contract minor 6.

`LS_Discrete` covers eight tracks: keyed bool/visibility/integer/byte/enum, a default-only bool,
an integer without a default, and an entirely omitted byte channel. Boundary keys use int32 min/max
and byte 0/255. Independent Unreal evidence comes from channel APIs after a fresh-process reload.
Malformed channel lengths are rejected as partial evidence rather than silently zipped.

## Verification evidence

- UE 5.7.4: passed fresh fixture generation, independent reload, codegen/struct conformance,
  native oracle comparison and native/WASM/public-reader parity.
- UE 5.8.2: passed the same checks. Combined results:
  `out/uasset-engine-matrix-wmogxa/results.json`.
- All three Sequencer E2E journeys passed, including discrete values and omitted defaults:
  `out/sequencer-discrete/e2e.log`.
- Focused malformed-container, typed-contract, comparison, projection-limit and fixture checks
  passed. Public-reader parity covers four sequences: `out/sequencer-discrete/public-reader.log`.
- Full `pnpm check`: passed, including 18 packed packages, downstream Data Authoring adoption,
  Rust/WASM/IO, type/lint/format/contract checks and 1,303 tests across 220 files. The standard
  unrelated integration gates skipped 50 tests across 14 files; parser Unreal conformance ran
  separately on both engines above. Evidence: `out/sequencer-discrete/check.log`.

The preceding batch was pushed as `b8c76237`. Its first Linux run exposed a hardcoded `.exe`
path and a build-output type import in saved-review conformance. `3cb4596b` uses native executable
discovery and the checked-in WASM declarations. `486be091` includes that script and Blueprint/
Sequencer protocol changes in CI scope detection so the relevant Linux lane runs.
All lanes passed in [Portable run 36588648973](https://github.com/ue-shed/ue-shed/actions/runs/36588648973),
including repository, UAsset libraries, UAsset IO and Catalog checks. This hosted run covers the
pushed preceding batch and its CI repairs; the new discrete-channel work is verified locally.

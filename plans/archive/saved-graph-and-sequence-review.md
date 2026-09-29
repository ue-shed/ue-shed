# Saved Blueprint and Sequencer review

Status: DONE (2026-09-29).

Deliver the approved read-only milestone: open a Blueprint or Level Sequence, navigate its saved
structure, inspect values, follow asset references, and explain changes between two saved versions.
Keep interpretation and comparison available through public libraries and CLI. Workbench adapts
those capabilities. Preserve the preceding, verified property-bag and animation changes.

- [x] Publish a typed Level Sequence reader operation through the native protocol and Effect API.
- [x] Add public reference inventory/navigation and deterministic semantic comparison for saved
      Blueprint graphs and Level Sequences, including explicit incomplete-evidence warnings.
- [x] Add CLI inspect/compare commands for both domains.
- [x] Add a Sequencer viewer with tracks, sections, key/curve inspection, reference navigation and
      baseline comparison; connect Blueprint navigation and comparison to the same public functions.
- [x] Expand real Blueprint fixtures beyond the minimal event/function graph and compare saved
      graph topology and values against independent Unreal APIs.
- [x] Generate Blueprint and Sequencer fixtures afresh on both UE 5.7 and UE 5.8 in the engine matrix.
- [x] Prove protocol, pure comparison, component, native/WASM, real-engine and end-to-end journeys;
      run the full `pnpm check` gate and record the results.

This milestone covers saved graphs and the supported Sequencer text, numeric, transform, shot and
subsequence tracks. Unsupported tracks remain visible and labeled. Blueprint compilation and editing
are out of scope. Evaluated playback and animation-state-machine evaluation are separate consumers,
not parser-completeness targets. Saved RigVM data remains a separate parsing capability.
Comparisons identify saved changes, not runtime behavioral equivalence. References resolve through
explicit project/package inventory; never guess a physical path from an arbitrary asset string.

Public commands take explicit asset/baseline paths; reads and comparisons do not require mutation
approval or a durable session. Results retain schema versions, source paths, partial coverage, and
actionable failures. No maintained UI adoption bundle is claimed in this increment.

Verification evidence:

- `out/uasset-engine-matrix-ce0AT3/results.json`: fresh UE 5.7.4 and UE 5.8.2 builds,
  generation, separate-process reloads, native/WASM and public-reader/Unreal-API comparisons passed.
- `out/saved-review/e2e-final.log`: five Electron journeys passed, including both baseline comparisons
  and indexed subsequence navigation without an Unreal process.
- The richer committed Blueprint fixture has 3 graphs, 13 nodes, 32 pins and 5 links, with complete
  decoded graph coverage. Node classes include branch, variable get/set, reroute, comment and function entry.
- `out/saved-review/check.log`: every `pnpm check` stage before the final test suite passed,
  including Rust/native/WASM, types, architecture, contracts, packed packages, and Data Authoring
  adoption. The final suite exposed five stale fixture-inventory assertions after adding the
  Blueprint and animation assets. Updated those assertions and reran the complete `pnpm test`:
  `out/saved-review/test-final.log` records 220 passing files and 1,302 passing tests, with 14 files
  and 50 tests skipped by their existing environment gates. Lint, formatting, and `git diff --check`
  also passed after the correction. All required check stages are green; the failed monolithic run
  remains in its original log for traceability.

The CLI output has a published schema under `packages/unreal-assets/contracts/saved-review.v1.schema.json`.
Workbench reference navigation uses indexed Blueprint/Level Sequence packages; other references remain
visible with an explicit unavailable/native status. Key plots show saved values without interpolation
or blending. Comparison identities and incomplete-evidence behavior are documented in the public README.

# Headless Blueprint package and showcase consumer

Status: DONE on 2026-09-30. Started after `e5c58118`.

Create `@ue-shed/blueprints` for reusable pure graph indexing, navigation, bounded search, reference
layout and saved display metadata. Keep the Solid viewer in Workbench, as requested; no UI entry point
or renderer package. Existing native/WASM libraries retain asset reading and parser ownership.

- [x] Add typed public helpers and preserve unresolved/ambiguous identities and missing evidence.
- [x] Make Workbench consume the helpers and demonstrate saved-node/pin search.
- [x] Register the public package, synchronized release metadata and a Changeset.
- [x] Exercise actual native/WASM Blueprint reads, independent UE 5.7/5.8 fixture evidence and a
      clean packed consumer; check browser-safe dependency boundaries.
- [x] Run focused tests, the relevant repository gates and offline viewer E2E; archive the plan.

No parser codecs, fixtures, Unreal APIs or compilation behavior are changed. Persistent pin-bit names
are verified against both local engine serializers. Do not infer editor defaults, load dependencies,
add a second parser or couple the package to Workbench, Electron, Solid or StyleX.

## Delivered

The public package exports owner-qualified graph/pin indexing, saved-link navigation, bounded
node/pin search, reference layout and semantic display helpers. Duplicate identities remain
unresolved, unknown pin bits survive, and missing display evidence remains absent. The existing
projection schema is re-exported rather than duplicated.

Workbench retains the Solid viewer, styles and host operations. It consumes the package's pure
helpers and demonstrates search across saved graphs, selecting the result's graph and owning node.
The public package has no UI entry point. Its Changeset and synchronized release registration are
prepared; no publication was performed.

## Verification

- `pnpm check` passed, including Rust/WASM and IO conformance, repository gates, all 19 packed
  public packages, isolated Data Authoring adoption, and 1,318 tests across 221 files. The 50
  skipped tests belong to unrelated live Unreal/Perforce integration gates.
  Evidence: `out/headless-blueprints/full-check.log`.
- `pnpm test:uasset-engine-matrix` passed on UE 5.7.4 and UE 5.8.2, using fresh engine-generated
  fixtures, independent reload evidence and native/WASM/public consumer checks.
  Evidence: `out/uasset-engine-matrix-cVwakZ/results.json` and
  `out/headless-blueprints/engine-matrix2.log`.
- The final production Workbench build passed all eight offline Blueprint/Sequencer E2E journeys,
  including comment search and the no-Unreal-launch assertions.
  Evidence: `out/headless-blueprints/e2e-final.log`.
- Focused package/viewer tests, Workbench types, precommit checks, actual saved-review fixture
  conformance and the Changesets release preview passed.

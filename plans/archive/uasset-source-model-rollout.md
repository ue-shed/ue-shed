# Switch UE Shed to the source-model parser

Status: DONE (2026-09-21).

Promote the tested parser from `experiment/uasset-source-codegen` into the main checkout. Import only
the parser series after `edddc13`, preserving main's ongoing World Preparation work and excluding
unrelated camera/UI history from the experiment's ancestry.

- [x] Back up the current working files and isolate the parser patch.
- [x] Integrate native parser, analyzer, inspection, IO, WASM, contracts, and consumers together.
- [x] Import the fixture generators, saved assets, Unreal evidence, and conformance checks.
- [x] Document the embedded source model as the default runtime path.
- [x] Rebuild local native and WASM artifacts and verify default CLI/package consumers.
- [x] Check generated models against local Unreal source and fresh Unreal evidence.
- [x] Pass focused checks and `pnpm check` from the main checkout.
- [x] Commit the parser switch separately from the existing working changes.

Legacy dispatch remains available for classes outside the model; deleting that compatibility path
would reduce the supported package surface. No runtime analyzer flag or engine-source path is needed.

Local backup, import patches, and verification logs are under ignored `out/parser-switch/`.

## Verification

- Full `pnpm check` passed from main, including Rust, native/WASM, Chromium, type checks,
  architecture, release checks, 18 packed packages with an offline consumer, copied Data Authoring
  adoption, lint, formatting, contracts, and 1,166 repository tests (50 opt-in tests skipped).
- `pnpm run check:precommit` passed after the fixture-isolation change.
- Focused Rust parser, analyzer, inspection, and IO tests passed.
- Both committed source models match a fresh analysis of the installed UE 5.7 source.
- The rebuilt Unreal fixture project passed fresh-process native evidence generation; all five
  native conformance tests passed against that evidence.
- Broader Unreal commandlet evidence and its five saved-package conformance tests passed.
- The default debug native executable inspected all 77 fixture packages successfully.
- Native/WASM equality passed for 15 fixtures, including the six additional native fixtures.

The rollout also fixes analyzer freshness checking for Windows CRLF checkouts without relaxing
model-content or canonical-format comparisons. Its regression test covers both line endings,
changed content, escaped string content, and indentation drift.

The main checkout also contains 5,129 ignored World Partition stress packages. Saved inventory
checks now copy version-controlled fixture files into temporary projects, so local generation cannot
change the portable fixture counts or CLI scan cost. All 33 tests across the three affected suites
pass with the stress packages still present. Package build output remains rooted at `src`; no-emit
test typechecking permits the shared fixture helper.

Debug and optimized native executables, the packaged Windows reader, and the Node/browser WASM
payloads were rebuilt in the main checkout. The packaged Windows reader exactly matches the release
executable. No experiment executable override is required.

The parser import was staged independently of the existing edits. Reversing it in an isolated copy
reconstructs the original working contents, while files outside the import retain their original
hashes. The unrelated World Preparation work and generated stress assets remain in place.

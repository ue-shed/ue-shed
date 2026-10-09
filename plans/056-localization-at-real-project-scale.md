# Plan 056: Game Text localization at real-project scale

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, `packages/localization/README.md`, ADR 0007 and
> `docs/engineering/testing.md`. Run targeted checks while iterating and `pnpm check` before
> handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/localization packages/game-text packages/unreal-assets apps/cli crates/uasset-io`.

## Status

- **State**: IN PROGRESS. Phase 4 is implemented and targeted checks pass. Real-project checks and
  unrelated full-gate failures remain open.
- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM. Changing how gather filters match changes which lines count as inside a target,
  and the limits and output caps change what a reader accepts. Each change is covered by a test,
  and nothing here writes to a project.
- **Depends on**: Plans 051, 052, 054.
- **Category**: product
- **Planned at**: `fix/localization-real-project-scale`, 2026-10-09

## Context

A read-only run against a real UE 4.27 project failed at every step of the Game Text localization
commands. The project has one target with 10 cultures, 132,606 keys, 166,518 packages, and 60–78 MB
manifest, archive and PO files. Nothing in the committed fixtures comes close to that size, or uses
the config form the Localization Dashboard writes, so CI never saw these failures.

The findings, in the order they were hit:

1. **Evidence limits too low.** The defaults (32 MiB per file, 100,000 entries) were arbitrary; the
   owner asked for 10×. The entry limit is also summed across the whole target (manifest plus every
   archive and PO), so with 10 cultures a ~4,800-line target already fails. The error says "manifest
   could not be read, run the gather", which hides the real cause.
2. **Reader output cap of 1 GiB.** The scan produced 3.26 GiB, 2.5 GiB of it from 4.8 million
   `text_coverage_gap` events. The CLI then reports a generic `reader_failure` and drops the cause.
3. **Catalog timeout of 5 minutes**, against a scan that takes about 2 minutes on an idle machine.
   It failed once under load.
4. **Unbounded corpus diagnostics.** Every gap becomes a diagnostic labelled
   `unsupported_text_history`, losing the reader's real reason. `loc status --limit 5` prints all of
   them plus every package's coverage and fails on V8's string-length limit. Marking packages partial
   is quadratic: `coverageGaps.some(...)` runs once per package.
5. **`%LOCPROJECTROOT%` gather filters are not understood.** The UE 4.27 and 5.7 dashboards write
   `IncludePathFilters=%LOCPROJECTROOT%Content/*` (`LocalizationConfigurationScript.cpp` and
   `LocalizationTargetTypes.cpp` in each engine). The join compares the filter literally, so 241,067
   lines whose keys match the manifest are marked `outside_target`, and 0 lines are translated.
6. **U+2028 in PO files is rejected.** Unreal writes LINE SEPARATOR raw; the project's Chinese PO
   file has 1,258 of them. The PO keyword pattern uses `(.*)$`, and `.` does not match U+2028 in
   JavaScript, so the file fails as `malformed_po`, with no line number.
7. **Speed and memory.** Reading the target's files takes 220 s and 2.7 GB of heap; `parsePO` takes
   about 11 s per 67 MB file. The full `loc status` took 12 minutes and peaked at 8.3 GB.

The outcome: `loc status`, `report`, `check`, `export` and `gate`, and Workbench localization, load
a target of this size with correct states, and their errors name the cause.

**Out of scope**, each for its own plan:

- 4.27 parser coverage: Blueprint class and function exports reported as
  `feature_unavailable_for_engine_version`, and rejected properties;
- aggregating gaps inside the native reader, which changes the `uasset-io` contract;
- `loc gate` treating partly decoded packages as `not_checked`. Most text packages on 4.27 stay
  partial until the parser work lands.

Studio-agnostic: tests use generated targets and inline fixtures. Real-project numbers are reported
only as "a 132,606-key, 10-culture, 166,518-package UE 4.27 project". Every real-project check is
read-only: no gathers, no writes.

## Phase 1: Correct states (findings 5 and 6)

**Gather filter tokens** (`packages/game-text/src/localization.ts`, `gatherRules` and
`localizationGatherCoverage`):

- Resolve path-root tokens before matching. A leading `%LOCPROJECTROOT%` (with or without a
  following `/`) is the project root. `packages/localization/src/operation-plan.ts` and
  `file-access.ts` already strip it; move that into one exported helper in `@ue-shed/localization`
  and use it in all three places.
- A `%LOCENGINEROOT%` pattern can never match a project package. Ignore it, for includes and
  excludes alike, as the dashboard branch already does for `PathRoot: Engine`.
- Any other `%TOKEN%` makes the rule `gather_settings_unavailable` (unknown), never `outside`.

**PO line separators** (`packages/localization/src/po.ts`):

- Field patterns match any character, including U+2028 and U+2029: use `[\s\S]` or the `s` flag
  instead of `.`.
- Check `trim()` and blank-line handling, so a U+2028 inside quotes stays content.
- `malformed_po` names the 1-based line that failed, using the line indices the parser already
  keeps.
- The PO writer leaves U+2028 raw, as Unreal does.

**Tests:**

- Dashboard-form filters (`%LOCPROJECTROOT%Content/*` with `%LOCPROJECTROOT%` excludes) count as
  inside.
- `%LOCENGINEROOT%` filters are ignored, and an unknown token gives unknown.
- A `msgstr` and a continuation line containing U+2028 parse and serialize byte for byte.
- A malformed line reports its line number.
- The fixture's `FixtureGame_Gather.ini` switches to the token form the dashboard writes, so the
  real-Unreal lane proves that Unreal accepts it on UE 5.7 and 5.8.

## Phase 2: Limits 10× and per-file entry counts (findings 1–3)

- `defaultLocalizationLimits`: `maxFileBytes` 320 MiB, `maxEntries` 1,000,000 and `maxFiles` 2,560.
  `maxDepth` stays 64, because it is a format shape, not a size.
- `LocalizationEvidence.read` applies `maxEntries` per file, not summed across the target. Memory
  stays bounded by `maxFiles × maxFileBytes`.
- The reader output cap rises to 10 GiB: `MAX_PROTOCOL_OUTPUT_BYTES` in
  `packages/unreal-assets/src/asset-reader.ts`, and the native `DEFAULT_MAX_OUTPUT_BYTES` in
  `crates/uasset-io/src/protocol_adapter.rs`. Update ADR 0007's note and
  `docs/engineering/uasset-benchmarks.md`.
- `DEFAULT_CATALOG_TIMEOUT_MS` rises to 50 minutes. The 30-second single-asset timeout stays.
- **Errors name their cause:**
    - the CLI's project scan keeps the scan error's message and recovery;
    - a manifest that fails for any reason other than `file_missing` reports that reason and its
      recovery, and only a missing manifest says to run a gather.
- Tests:
    - with explicit small limits, a target whose files sum above `maxEntries` reads, and one file
      above it fails;
    - a reader failure's message reaches the CLI's JSON.

## Phase 3: Bounded diagnostics (finding 4)

**The corpus** (`packages/game-text/src/corpus.ts`):

- Fold gaps as they arrive into a per-package count by reason, plus a few samples. The millions of
  gap objects are never kept.
- Each package gets one `package_partially_decoded` diagnostic with its counts by reason. The reason
  comes from the reader's `coverage_gap.reason`.
- A diagnostic stays `unsupported_text_history` only when the reason is exactly that.
- `TextCorpusDiagnostic` gains an optional record of counts by reason. The field is optional, so
  the schema stays version 1.
- Marking a package partial uses a set of package files, so it is linear.

**The status report** (`packages/game-text/src/localization-status.ts`):

- At most 200 diagnostics, with `diagnosticCount` and totals per code.
- Package coverage becomes counts by status, plus at most 200 packages that are not complete, with
  an omitted count.
- Check that `loc report`, `check`, `export` and `gate` print no unbounded corpus lists.

**Tests:**

- 50,000 synthetic gap events give bounded diagnostics with correct reason counts and partial
  marking.
- The status report respects both 200 bounds.

## Phase 4: Read speed and memory (finding 7)

- Profile `parsePO` on a generated 132,000-entry, ~65 MB PO file. The likely costs are the per-line
  schema decode and validating every entry and then the whole document again.
- Build lines and entries directly from the parser's captures: the parser is the boundary, and its
  captures are already typed. Keep one structural check where it guards an invariant.
- Target: 3 s or less per 67 MB PO file.
- Apply the same pass to `parseArchive` and `parseManifest` if profiling shows schema validation
  dominating.
- Re-measure the full `loc status` on the real project: heap peak and wall time.
    - If the peak still exceeds Node's default heap, document the `NODE_OPTIONS` workaround.
    - Report how Workbench main behaves on the same project.
- A pure test bounds the parser on a generated 50,000-entry PO file. Its time budget is generous,
  so it is not flaky.

## Docs and release

- `docs/products/game-text.md`:
    - the limits and how to raise them;
    - the dashboard token form;
    - the status output bounds;
    - known gaps on UE 4.27 assets.
- The limit lines in `packages/localization/README.md` and `packages/unreal-assets/README.md`.
- Changesets for `@ue-shed/localization`, `@ue-shed/game-text`, `@ue-shed/unreal-assets` and the
  CLI.

## Verification

- **Targeted tests:** `packages/localization`, `packages/game-text` and `apps/cli` (CLI integration
  with the native reader), on Node 24 and Node 26.
- **Gates:** `pnpm run check:precommit` and `cargo test -p uasset-io`.
- **Real Unreal:**
    - `pnpm test:localization-processes` on UE 5.7 and 5.8, with the fixture's token-form gather
      config;
    - `pnpm test:uasset-engine-matrix`, because a fixture changes.
    - Report any engine that is not installed as unavailable.
- **The real project, read-only and local:**
    - `loc targets`, `report`, `status --limit 5`, `check` and `export` complete with default limits;
    - most lines are inside the target, every culture has translated lines, and the Chinese PO file
      reads;
    - record wall time and peak memory before and after.
- PR CI green, and the PR review addressed.

## Evidence

Recorded per phase as it lands.

### Phase 4: read speed and memory

The generated 132,606-entry, ten-culture target reduced PO parse time from 7.08 s to 1.88 s,
archive parsing from 2.14 s to 0.98 s and manifest parsing from 1.85 s to 0.91 s. Evidence retained
heap fell from 4,169 MiB to 1,121 MiB after GC; the final read completes on Node's default heap.
See the [measurement and consumer audit](../docs/research/localization-read-performance-2026-10-09.md)
for profiling attribution, compact evidence, reproduction and verification results.

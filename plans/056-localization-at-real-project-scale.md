# Plan 056: Game Text localization at real-project scale

> **Executor instructions**: Follow this plan in order. Before editing, read `AGENTS.md`,
> `docs/README.md`, `docs/products/game-text.md`, `packages/localization/README.md`, ADR 0007 and
> `docs/engineering/testing.md`. Run targeted checks while iterating and `pnpm check` before
> handoff.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/localization packages/game-text packages/unreal-assets apps/cli crates/uasset-io`.

## Status

- **State**: IN PROGRESS. Phases 1–5 are done; the plan closes when PR #61 merges. Memory at this
  scale moves to Plan 057 (a compact, persistent Game Text index).
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

## Phase 5: Saved package namespaces

- Match saved FText identities to manifests, archives and PO files after stripping Unreal's
  trailing package namespace marker once for asset properties and DataTable cells. Keep String
  Table definitions and references in their exact authored namespace. Export the pure helper from
  browser-safe localization.
- Keep full saved namespaces in corpus units and occurrences, and use gathered identities for
  localization lines, key changes, review fingerprints and gates.
- Count duplicate sources by gathered identity, and retain conflicts across package variants.
- Cover marker edge cases, translated joins, saved identity preservation, pairing, reviews and
  gates with invented examples; update the product contract and add a Changeset.

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

### Phase 5: saved package namespaces

`stripPackageNamespace` lives in browser-safe `@ue-shed/localization`. The join strips each saved
FText namespace once for asset properties and DataTable cells before grouping against manifest,
archive and PO identities. String Table definitions and references keep namespaces exactly as
authored. Units mixing String Table entries with FText locations also preserve the namespace,
avoiding loss of authored table identity. Key-change pairing, review fingerprints, gates and
translation editing consume those gathered line identities.
Localization files are not stripped again, preserving namespaces such as `[A]` after `[A] [B]`
is cleaned. Corpus units, occurrence identities and asset focus/export keep full saved namespaces.
Query findings count distinct gathered identities, including shared text and source conflicts
across package variants. A navigation test now uses distinct keys for its distinct lines.

Verified the stripping algorithm and asset-gather call against installed UE 5.7 and UE 5.8 source,
and the algorithm against UE 4.27 source. This phase changes no parser, fixture or Unreal process
integration; no engine commandlets were run for it.

Verification on Node 24.21.0:

- Sequential localization and game-text builds: both passed.
- `pnpm exec vitest run packages/localization packages/game-text`: 324 passed, 0 failed,
  4 environment-gated tests skipped; 41 files passed and 3 skipped.
- `pnpm exec vitest run apps/cli/src`, with the release native reader explicitly configured:
  76 passed, 0 failed, 25 files passed.
- `pnpm exec vitest run extensions/game-text apps/workbench/src/main`: 339 passed, 0 failed,
  43 files passed.
- `pnpm exec oxfmt --write` on all 16 changed files: passed.
- `pnpm run check:precommit`: passed all six stages; architecture tests 43 passed, 0 failed.
- `pnpm check`: failed at unrelated Data Authoring adoption conformance. Its copied protocol
  package imports missing `editor-foreground-responsiveness.js`; the full gate stops before the
  final test stage. Native/WASM checks, package builds, types, architecture, license, release and
  20 packed-package consumers passed before that failure.

Node 26 remains unverified for this phase; the real-project checks are recorded below. A transient precommit failure from
running while package conformance rebuilt dist outputs was resolved by rerunning after the build.

### Real project, read-only

`loc status --limit 5` on a 132,606-key, 10-culture, 166,518-package UE 4.27 project, before and
after this plan:

|                              | Before                                                                       | After                                     |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| Result                       | Failed before output (limits, then the 1 GiB reader cap, then string length) | Completes in 335 s, 210 KB of JSON        |
| Localization files read      | 7 of 21                                                                      | 21 of 21, including the Chinese PO file   |
| Lines outside the target     | 241,067                                                                      | 2,461                                     |
| Translated lines per culture | 0                                                                            | about 29,000 (122,630 after Phase 5)      |
| Diagnostics                  | 4,813,877                                                                    | 16,272, one per package, with gap reasons |

The table's "After" column predates Phase 5. Phase 5's package-namespace matching, measured on the
same project through the join, changed the German line states as follows:

| German       | Before Phase 5 | After Phase 5 |
| ------------ | -------------: | ------------: |
| Translated   |         29,235 |       122,630 |
| Not gathered |        154,034 |        59,458 |
| Not found    |         30,416 |           203 |
| Unknown      |        459,142 |       394,790 |

Joined lines fell from about 678,000 to 583,507, because package variants of one gathered identity
now share a line.

The run still needs a larger heap: Node peaks at 6.6 GB (reader 4 GB) and fails at Node's default
4 GB while building the corpus and join, after the scan. The remaining memory is the corpus and join held as
objects; Plan 057 replaces that with a compact, persistent index.

Most of the remaining `not_gathered` lines are editor-only text, such as Blueprint node labels and
Sequencer track names, which a target with editor-only gathering off never gathers. Most `unknown`
lines have no key, or sit in packages the UE 4.27 reader only partly decodes. Both are recorded as
follow-ups rather than fixed here.

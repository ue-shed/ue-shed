# Plan 060: Text in a changelist, and the text in a project's source

> **Executor instructions**: Read this plan fully before starting. Also read `AGENTS.md`,
> `docs/README.md`, `docs/vision-and-architecture.md` (especially
> [Base, not constraints](../docs/vision-and-architecture.md#base-not-constraints)),
> [ADR 0012](../docs/decisions/0012-native-engine-boundary.md),
> `docs/engineering/native-game-text-index.md`, `docs/engineering/game-text-gather-coverage.md`,
> `docs/products/game-text.md`, Plans 052 and 059 and the archived Plan 054. Run targeted checks
> while you iterate. Honour the STOP conditions. At the end of every phase, record its evidence
> and measurements here and review the plan with the owner before starting the next phase.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- crates/game-text-index crates/uasset-io packages/game-text packages/unreal-assets packages/localization packages/map-history apps/cli`.

## Status

- **State**: In progress. Phase 0 not started.
- **Priority**: P1
- **Effort**: XL
- **Risk**: MEDIUM-HIGH. It adds a second source of text (C++, config and String Table CSVs) next
  to saved packages, and a new way to read the project: at a point in Perforce, not only on disk.
  Parity with Unreal's own gather is the correctness bar for the first; the second must never
  write to Perforce.
- **Depends on**: Plan 059 (one query and rule engine in the index), the Game Text fixture.
- **Category**: product
- **Planned at**: `feat/changelist-text-and-unreal-source`, 2026-10-28

## Context

Owner decisions on 2026-10-28, in three conversations:

1. **A changelist scanner.** Pick a changelist, mostly someone else's submitted one, and see what
   it does to the project's text and its translations. Any two points can be compared: the local
   working copy, a submitted changelist, or a shelved one.
2. **A separate package for Unreal C++**, not a corner of `@ue-shed/game-text`. Research outside
   this repository (its findings are summarised below) recommends a targeted Rust token scanner that mirrors Unreal's `GatherTextFromSource`, not a
   full C++ parser. The owner agreed, dropped tree-sitter and Python, and asked to ship it in the
   same release as the scanner, because a changelist that edits a `LOCTEXT` must show up in it.
3. **From the x18n comparison**, keep: the changelist check from the command line with a
   markdown summary for Jenkins, Horde or TeamCity and for Swarm reviews; stable exit codes; an
   agent guide that ships with the CLI. Drop: translation briefs for agents and review comments
   that travel with a branch ("not how game studios work").

What exists today:

- **`loc gate`** (Plan 054) judges the text in a list of files and exits `0` passed, `1` failed,
  `2` could not check. Its stated limits are exactly what this plan removes:
    - it reads the workspace on disk, so it must run where the change is, never on a server;
    - C++ and config key changes only show across a gather UE Shed runs;
    - a full project scan runs each time.
- **`diffPackageText`** (`packages/game-text/src/package-text-diff.ts`),
  **`localizationKeyChanges`** and **`diffLocalizationBaselines`** compare text in TypeScript,
  one line at a time. Per-line data belongs in the native engine
  ([bulk data native](../docs/decisions/0012-native-engine-boundary.md)).
- **Map History** (`packages/map-history/src/perforce.ts`) already reads package revisions from
  Perforce for a host.
- **Game Text reads saved packages only.** It knows C++ and config text only from Unreal's
  gather manifest, so text added since the last gather is invisible
  (`docs/engineering/game-text-gather-coverage.md`, "What a headless rescan can miss").

Research findings this plan relies on (measured 2026-10-28 on this PC):

- Unreal's C++ gather is itself a token scanner: it does not evaluate `#if`, follow includes or
  resolve constants. A full parser would produce identities a real gather never creates.
- The macro set grows by version. 4.27 is a strict subset; `NOTELOCTEXT`, `SETNOTESTRING` and
  `UE_DECLARE_ERROR` are 5.8-only; `UE_LOGFMT_*` and the `#define` wrapper prepass are 5.x.
- Scale: a UE 5.7 project has 4,117 source files and 647 gatherable places; a large UE 4.27
  project has 12,201 files, 64 MB and 1,786 places. About one place per 1,000 lines.
- The spike scanner (memchr hops between interesting bytes, one exact table lookup per
  identifier, terminator hops over strings and comments) reads 75 MB/s on the UE 5.7 project and
  49–53 MB/s on the UE 4.27 project, single-threaded, file reads included. Pierre's hand-written
  WebAssembly C++ lexer reads 51–68 MB/s on the same inputs without file reads.
- Reflected metadata (DisplayName, ToolTip) is gathered from loaded reflection, not from headers.
  Saved UHT output exists only on machines that built the project, never at a depot point.

## Decisions

Taken by the owner, or by the planner on the research's recommendation (marked _recommended_).
The owner can reverse any of them at a phase review.

1. **Package and crate**: `@ue-shed/unreal-source` and `crates/unreal-source`. It reads a
   project's source tree (C++, headers, config and String Table CSVs), not its content. Game Text
   is its first consumer; reflection for authoring and Remote Control comes later. _(planner)_
2. **A token scanner, not a parser** (owner). No clang, no tree-sitter, no Pierre fork. The
   spike's scanner is the starting core. Unknown constructs are kept as unknown and reported, never
   guessed.
3. **Never smarter than Unreal** (_recommended_). No include following, no `#if` evaluation and no
   constant resolution in the gathered set. Extras such as `FText::FromString` or `INVTEXT` are
   reported as findings that never become keys.
4. **Scope comes from the project's localization targets** (_recommended_): search directories,
   filters, excludes and `ShouldGatherFromEditorOnlyData` from each target's
   `GatherTextFromSource` steps. A project with no target gets "no localization target", not a
   guessed scope.
5. **Editor-only text follows each target's own setting** (_recommended_); excluded text is shown
   as out of scope, not dropped silently.
6. **4.27 in full in the first version** (_recommended_): large UE 4.27 projects are real
   consumers. That includes UTF-16 CSV and INI files.
7. **Reflected metadata is a named gap** (_recommended_), filled later from generated code where a
   build left it.
8. **Read-only.** UE Shed never edits C++, INI or CSV source. A C++ place is `read_only`, with a
   reveal-in-IDE affordance for hosts.
9. **One store for every place** (_recommended_): source places sit beside saved-package places in
   the same snapshots and diffs from the start, not in a sidecar report.
10. **A point is a set of file digests** (_planner_). A changelist review reads only the files the
    changelist touched, at its two revisions, plus the localization files at the base. No full
    project scan.
11. **The changelist check extends `loc gate`** (_planner_): `--change <CL>` and
    `--shelved <CL>` beside `--files`, the same checks, policy flags and exit codes, plus
    `--format markdown`. A separate `loc diff --from <point> --to <point>` lists differences without
    a verdict.
12. **No Perforce writes, ever.** The host reads revisions with `p4 describe`, `p4 files` and
    `p4 print`; nothing else.

## Concepts

- **Point**: the project's text at one moment. `local` is the working copy on disk;
  `depot@<CL>` is a stream or path at a submitted changelist; `shelved:<CL>` is a shelved
  changelist over its base. A point is a manifest from project-relative path to a content digest.
- **File record**: the text found in one file's content: saved-package occurrences from the
  asset reader, or source places from `unreal-source`. Records are content-addressed, so two points
  share every file they have in common, and a revision read once is never read again.
- **Source place**: `(file, line, column, macro, namespace, key, source, devNotes?, editorOnly,
platform?, tableId?)`. It joins localization by `(namespace, key)` like any other place.
- **Change**: per place, `added`, `removed`, `edited` (same key, new text), `rekeyed` (same place,
  new key) or `unchanged`, as `diffPackageText` defines today.
- **Impact**: per changed key, at the base point's localization: which cultures had a translation,
  which now show stale, which keys lose their translations through a rekey, and which new text
  collides with an existing key's different text.

## Phase 0: Oracle and baseline

1. **Fixture**: extend `fixtures/unreal-project` with source cases for every descriptor family in
   the research's macro table: `LOCTEXT`/`NSLOCTEXT` with namespace scoping, a `#define` wrapper,
   `LOC_DEFINE_REGION`, `#if WITH_EDITOR` text, adjacent literals and escapes, `UI_COMMAND`, the 5.x
   log macros, `LOCTABLE_NEW`/`SETSTRING`/`FROMFILE_GAME` with a UTF-8 and a UTF-16 CSV, and INI
   text. Each case records its expected manifest entries in `FixtureExpected`.
2. **Reference gathers**: run Unreal's gather on the fixture's source recipe with UE 5.7 and UE 5.8,
   and on the same cases (without the 5.x-only macros) in `fixtures/legacy-unreal-project` with
   UE 4.27, one Unreal task at a time. Commit the manifests as the oracle.
3. **Baseline**: time today's `loc gate` on the fixture and on one large local project for a
   changelist's file list, and record the full-scan cost the new path must beat.
4. **Sample changelists** on a real project, chosen with the owner: code-only, asset-only, mixed,
   a key rename with translations, and a shelved one. Record their numbers only, never names or
   text.

**Evidence**: _pending_.

## Phase 1: `unreal-source`, the scanner

1. `crates/unreal-source`:
    - **Lexer** from the spike: memchr hops, exact identifier table, terminator hops. Fix the
      spike's known gap: an identifier match must start at an identifier boundary (`MY_LOCTEXT`
      is not `LOCTEXT`).
    - **Descriptors as versioned data**: a table per engine line (4.27, 5.x, 5.8), not code
      branches. Each descriptor names its argument shape and how namespace, key and source are
      formed.
    - **Arguments**: nested brackets, adjacent literals, `TEXT()`, escapes, raw strings, line
      continuations; per-file `LOCTEXT_NAMESPACE` state; first-wins String Table semantics.
    - **Context**: the editor-only `#if` stack the way Unreal tracks it, platform split paths,
      `LOC_DEFINE_REGION`, and the `#define` wrapper prepass for 5.x (reported as unsupported for
      4.27 targets).
    - **INI**: section namespaces and package-marker stripping, as the commandlet does.
    - **String Table CSVs**: an `FCsvParser`-compatible reader (UTF-8, UTF-16, BOM),
      `Key,SourceString[,DevNotes][,Meta…]`, registered by the `LOCTABLE_FROMFILE_*` call that names
      them.
    - **Diagnostics** for every warning class Unreal logs (empty key or source, wrong argument
      count, unterminated namespace define, unregistered table entries, duplicates) and a
      **coverage statement** per scan: active descriptor families, excluded files and why, and the
      named blind spots (direct `RegisterStringTable`, computed keys, custom gather callbacks).
    - Output as compact typed records; `ts-rs` types generated into `packages/protocol`.
2. **Parallel scan** over files with rayon, bounded by the existing reader budget.
3. `packages/unreal-source`: an Effect service that resolves each target's `GatherTextFromSource`
   steps through `packages/localization` and runs the scan through the `uasset` worker.
4. CLI: `ue-shed source text <project-root> [--target]` prints places, diagnostics and coverage.
5. **Conformance**: the scanner's identities match the Phase 0 manifests exactly, on all three
   engines. Unit tests per descriptor, per escape and per encoding.
6. **Measure** single-threaded and parallel MB/s on the two research projects against the
   spike's numbers, with bounded spans per stage (read, lex, descriptors, CSV).

**Evidence**: _pending_.

## Phase 2: Source places in Game Text

1. A `source_text` place kind beside the three saved kinds in `packages/game-text/src/schema.ts`
   and the index's place columns. Places are `read_only`.
2. **Current source against the manifest**: a gathered key whose current source differs from the
   manifest's is "Changed since gather", the existing line state, now for C++ and config text too.
3. **Audience evidence**: editor-only context and `UICommands.*` namespaces feed the existing
   audience policy as a new reason, `source_editor_only`.
4. **Incremental**: source records are keyed by file digest, so a rescan reads only changed source
   files, like packages today.
5. `loc gate` no longer warns `gathered_source` for a changed C++ or config file it can read: it
   judges its places like any other.

**Evidence**: _pending_.

## Phase 3: Points

1. **Point manifests and the record store** in `crates/game-text-index`: per-file records keyed by
   content digest, for packages and for source files; a point is a manifest of path → digest.
   Records are written once and shared.
2. **Reading a revision**: the host fetches only what a point needs, with `p4 describe` for a
   changelist's files and actions, `p4 print` for their content at the two revisions, and the
   target's manifest and archives at the base revision. Revisions land in a content-addressed cache
   the engine reads from disk; the engine starts no processes. Share the Perforce read path with
   Map History rather than copying it.
3. **Point pairs**: `local` vs `depot@head`; `depot@<CL-1>` vs `depot@<CL>`; base vs
   `shelved:<CL>`; and any two points the host names.
4. **Measure**: a changelist review's wall time and bytes read against Phase 0's full-scan
   baseline, on the sample changelists.

**Evidence**: _pending_.

## Phase 4: Diff and impact, natively

1. **Diff** two points' records in the engine, with `diffPackageText`'s pairing rules for both
   package and source places. Retire the TypeScript per-line diff once the host reads the native
   one.
2. **Impact** in one call: the diff joined to the base point's localization, returning per
   culture the stale translations, keys that lose translations through a rekey, colliding text and
   new text not yet gathered, with paged rows and counts.
3. `loc gate`'s checks read the impact instead of a full corpus scan when a point pair is given.
4. Contract types generated; the host reads paged columns, never every line as JSON.

**Evidence**: _pending_.

## Phase 5: The command line

1. `loc gate --change <CL>` and `--shelved <CL>`, beside `--files`; same checks, policy flags and
   exit codes. `--format markdown` writes a summary fit for a build log or a Swarm comment:
   counts, the failing lines with a way forward, and the coverage statement.
2. `loc diff --from <point> --to <point>` lists differences and impact without a verdict.
3. **Error and exit codes in one table**: each typed failure the CLI can end with has a code,
   a cause, a fix and an exit code. Docs are generated from it, as the check table is today.
   `apps/cli/src/index.ts` maps failures through it instead of sending every one to exit `2`.
4. **An agent guide** shipped with the CLI for the changelist check, with a test that every
   command and flag it mentions exists.
5. Docs: `docs/products/game-text.md`, "Checking a changelist", replacing the stated limits of the
   pre-submit check.

**Evidence**: _pending_.

## Phase 6: Electroswag

In the Electroswag repository, on its own branch:

1. **Localization impact** on the submitted-changelist review page
   (`P4ServerChangelistReviewPage`): counts, then the changed lines with their place, the cultures
   affected and the way forward. Shelved changelists too.
2. **Compare** in Game Text: two point pickers (local, a submitted changelist, a shelved one) over
   the same diff.
3. C++ places in Game Text's line detail, read-only, with reveal in IDE.

**Evidence**: _pending_.

## STOP conditions

- The scanner's identities differ from a Phase 0 reference manifest and the difference cannot be
  traced to Unreal's documented behaviour. Fix or document it before Phase 2.
- Any v1 feature turns out to need a build, UHT output or a running editor.
- Per-line data has to cross into TypeScript in bulk to make a phase work.
- Reading a point needs anything other than `p4 describe`, `p4 files` and `p4 print`.
- A changelist review is not clearly faster than Phase 0's full-scan baseline on the sample
  changelists.

## Out of scope

- Reflected metadata (DisplayName, ToolTip, enum names). Named in every coverage statement.
- Reflection for authoring and Remote Control, the module and plugin graph, gameplay tags, console
  variables and log categories. They are `unreal-source`'s follow-ons, on the same scanner.
- Editing C++, INI or CSV source.
- File compare against a chosen PO, archive or CSV, and our own CSV format. Later work.
- Translation briefs for agents and review comments that travel with a branch (owner, 2026-10-28).
- SARIF and GitHub annotations: text lives in `.uasset` files, and studios run Perforce.

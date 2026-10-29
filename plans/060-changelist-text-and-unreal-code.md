# Plan 060: Text in a changelist, and the text in a project's code

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

- **State**: Done (2026-10-30). Phase 0: done (oracle on 5.7, 5.8 and 4.27; baseline and sample
  changelists, 2026-10-29). Phase 1: done and reviewed (owner, 2026-10-29). The scanner matches all
  three engines' gathers, and `ue-shed code text` runs it through the Game Text engine. Phase 2:
  done and reviewed (owner, 2026-10-29). Game Text reads each target's code and judges C++ text
  like asset text. Phase 3: done and reviewed (owner, 2026-10-29): a changelist's or a workspace's
  two points, with code and the base's localization, read in 1.3–1.6 s warm. Phase 4: done and
  reviewed (owner, 2026-10-29): the engine compares two points and judges the change by the gate's
  checks against the base's localization. Phase 5: done and reviewed (owner, 2026-10-29):
  `loc gate --change` and `--shelved`, `loc diff`, `--format markdown`, exit codes and an error
  table from the error's next step, and the agent guide. Phase 6: done and reviewed (owner, 2026-10-30):
  ranges, `compareChange` for hosts, and Electroswag's review page, Compare, the text diff and code
  places (draft Stairway-Games/electroswag#124 until 0.24.0 is published).
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

1. **Package and crate**: `@ue-shed/code` and `crates/unreal-code` (owner). It reads a project's
   code (C++, headers, config and String Table CSVs), not its content. Game Text is its first
   consumer; reflection for authoring and Remote Control comes later. "Source" was rejected: it
   already means the native text in Game Text and source-built engines in `@ue-shed/engine`.
2. **A token scanner, not a parser** (owner). No clang, no tree-sitter, no Pierre fork. Unknown
   constructs are kept as unknown and reported, never guessed. The core is a port of Unreal's own
   scanner, not the spike's: the spike matched whole identifiers, which Unreal does not (Phase 0),
   so its idea survives as tier one, the skip of files that hold no descriptor token. Later
   consumers (reflection, modules) mirror their own Unreal tool, UHT's tokenizer for reflection,
   and share the crate's encoding, literal, CSV and path code, not the gather's quirks.
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
9. **One store for every place** (_recommended_): code places sit beside saved-package places in
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
  asset reader, or code places from `unreal-code`. Records are content-addressed, so two points
  share every file they have in common, and a revision read once is never read again.
- **Code place**: `(file, line, column, macro, namespace, key, source, devNotes?, editorOnly,
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
   and on the same cases through `fixtures/unreal-427-localization` with UE 4.27, one Unreal task
   at a time. Commit the manifests as the oracle.
3. **Baseline**: time today's `loc gate` on the fixture and on one large local project for a
   changelist's file list, and record the full-scan cost the new path must beat.
4. **Sample changelists** on a real project, chosen with the owner: code-only, asset-only, mixed,
   a key rename with translations, and a shelved one. Record their numbers only, never names or
   text.

**Evidence (2026-10-28, partial)**:

- Cases in `fixtures/unreal-project/FixtureSource/UnrealSource` (namespaces, literals, editor-only
  context, `UI_COMMAND`, localized logs, a wrapper macro, code String Tables with a UTF-8 and a
  UTF-16 CSV under `Content/Fixture/UnrealSource`, 5.8 developer notes, INI). Recipes
  `UnrealSource.ini` (no editor-only text) and `UnrealSourceEditor.ini` (with it).
  `pnpm fixture:generate-unreal-code` gathers both and keeps the manifests in
  `FixtureExpected/unreal-code/<engine>`.
- UE 5.8 gathered 44 entries without editor-only text and 46 with it, in 3.7 s; the manifest is
  UTF-16. It corrected four of the research's assumptions, so the oracle, not the research, is the
  spec:
    - `MYLOCTEXT("Prefixed", …)` gathers as `LOCTEXT`: no identifier boundary is checked.
    - `LOCTEXT(KeyConstant, …)` gathers with the identifier itself as the key.
    - Adjacent literals do not join: `"Two literals " "become one"` gathers as
      `Two literals " "become one`.
    - `#if defined(WITH_EDITOR)` is runtime text: only `#if WITH_EDITOR`,
      `#if WITH_EDITORONLY_DATA` and their `#ifdef` forms make text editor-only.
- Also observed: `TEXT("Inside TEXT()")` as a source keeps its `TEXT(...)` wrapper; an INI
  `NSLOCTEXT("[/Script/UnrealSource]", …)` gathers under the empty namespace; `UI_COMMAND`
  under a namespace gathers as `UICommands.<namespace>`; CSV cells in extra columns become
  `MetaData.Info`, and `DevNotes` becomes the entry's developer notes.
- Encoding: a UTF-8 file without a byte order mark, one with it and a UTF-16 file all gather
  `Café ❄ 港` identically on 5.7, 5.8 and 4.27.
- UE 5.7 (41 and 43 entries) differs from 5.8 only where expected:
    - 5.7 gathers the whitespace-only `Blank`; 5.8 drops it.
    - A CSV `DevNotes` column is `MetaData.Info.DevNotes` in 5.7 and the entry's developer notes
      in 5.8.
    - `NOTELOCTEXT`, `NSNOTELOCTEXT`, `LOCTABLE_SETNOTESTRING` and `UE_DECLARE_ERROR` gather
      nothing in 5.7.
- UE 4.27 gathers the same cases through `fixtures/unreal-427-localization`'s
  `UnrealSource427.ini` recipe, which points at the 5.x fixture's sources (37 entries). Against
  5.7:
    - A macro call spread over several lines gathers nothing (`Spanning`, the multi-line
      `UI_COMMAND`): 4.27 reads arguments from one line only.
    - `UI_COMMAND` with four arguments still gathers (`TooFew`).
    - Localized log macros gather nothing.
    - `NOTELOCTEXT(` matches as `LOCTEXT` and fails its argument count, as in 5.x without the
      macro, and so is only a warning.
    - Source locations read `path:line` relative to the recipe, not `path(line)`.
- 4.27 crashes (an access violation) when a String Table has entries but no registration: its
  "never registered" warning passes the entry count to a `%s`. 4.27 keeps String Tables
  project-wide, so a table registered in another file is fine there; 5.x keeps them per file and
  drops the entries with a warning. The case lives in `StringTablesUnregistered.cpp`, which the
  4.27 recipe excludes. 4.27 resolves exclude filters against the project folder, so the filter
  names the file by its relative path.
- The `#define` wrapper prepass ignores the target's scope: it reads `*.cpp` and `*.h` under the
  engine's and the project's `Source` and `Plugins` (its `.inl` filter lacks the `*`, so it never
  matches). A wrapper defined in a header applies to every file, one defined in a `.cpp` only to
  that file, and two header wrappers with the same name are both excluded. A changelist that
  edits a header wrapper can change text in files it never touched, so a point keeps its wrapper
  set, and the engine's part can be kept per engine build.

**Evidence (2026-10-29, baseline)**: on this plan's branch after Phase 2, so the full scan includes
the code scan. The owner left the choice of changelists to the planner.

- **Sample changelists**, from the large UE 4.27 project, the one local project with a gathered
  target (10 cultures, 132,734 manifest entries); numbers only. Each is at or below the change its
  workspace is synced to, so the files `loc gate` reads are on disk, except the shelf's.

    | Kind                         | Changelist | Files | Lines judged     | Verdict                        |
    | ---------------------------- | ---------: | ----: | ---------------- | ------------------------------ |
    | Code only                    |     220336 |    19 | 5, in 2 files    | passed                         |
    | Asset only                   |     220368 |     9 | 296, in 9 files  | passed                         |
    | Mixed                        |     220253 |    36 | 138, in 13 files | failed, 2 lines; 2 partly read |
    | Key rename with translations |     219062 |    33 | none             | passed                         |
    | Shelved                      |     220258 |    26 | 84, in 6 files   | failed, 1 line                 |

    219062 is a gather commit: its manifest moves 49 entries' unchanged source to new keys, with
    their translations. The gate judges places in the listed files, and a gather commit lists only
    localization files, so it sees nothing; a point pair across the commit is what finds them.

- **Times**, `loc gate --files <list> --target <target>` through the CLI, one process per run:

    | Project                            | Cold (empty cache) | Each changelist, warm |
    | ---------------------------------- | -----------------: | --------------------: |
    | Fixture (`FixtureGame`)            |              5.9 s |                 1.9 s |
    | UE 4.27 project (167,507 packages) |             55.7 s |            9.0–11.9 s |

    The warm cost does not follow the list: 9 files and 36 cost the same. Where it goes (inventory,
    refresh or the read itself) is the first thing Phase 3 profiles. The index takes 210 MB. This is the bar: a changelist review must be clearly faster than about 9.5 s warm
    and 56 s cold on this project.

- **Found on the way**:
    - The gate refused any changelist touching a package Unreal's gather does not select
      (`not_gatherable`, such as a material) as unreadable, exit 2. Fixed: such a package holds no
      text the target gathers, so there is nothing to judge, as in Unreal.
    - Then 2 of the mixed sample's widget Blueprints, read only in part, stopped it with exit 2. On
      this project 2,061 of 15,632 gatherable packages are partial. Of a 171-package sample, 119
      have properties not decoded for 4.27 (Blueprint graph pins most often), 57 container elements
      saved without their type, 40 properties the decoder rejected and 9 unsupported text. The owner
      chose better handling over widening the reader for now: the gate checks the text such a
      package did yield and lists it as `partial_read` (warns; `--fail-on partial_read` stops it)
      with how many properties were not read, why and one of them. The mixed sample now fails on 2
      lines with one key and two texts, and names its 2 partly read Blueprints.

## Phase 1: `unreal-code`, the scanner

1. `crates/unreal-code`:
    - **Two tiers.** A SIMD substring check (memchr's `memmem`) skips every file that holds no
      descriptor token at all; no place can come from such a file. The few files left go through
      a faithful port of Unreal's line scanner (`ParseSourceText`): its per-character token
      counters, longest-token deferral, comment and string state, and argument gatherer, quirks
      included. Unreal checks no identifier boundary, so `MYLOCTEXT(` gathers as `LOCTEXT`; the
      spike's planned boundary fix would break parity and is dropped.
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
3. `packages/code`: an Effect service that resolves each target's `GatherTextFromSource`
   steps through `packages/localization` and runs the scan through the `uasset` worker.
4. CLI: `ue-shed code text <project-root> [--target]` prints places, diagnostics and coverage.
5. **Conformance**: the scanner's identities match the Phase 0 manifests exactly, on all three
   engines. Unit tests per descriptor, per escape and per encoding.
6. **Measure** single-threaded and parallel MB/s on the two research projects against the
   spike's numbers, with bounded spans per stage (read, lex, descriptors, CSV).

**Evidence (2026-10-28)**:

- `crates/unreal-code` ports `GatherTextFromSourceCommandlet` on UTF-16 code units: the line
  scanner, every descriptor, the argument gatherer and look-ahead, escapes, `TEXT()`, the
  `#if` stack, `LOC_DEFINE_REGION`, INI sections, String Tables (per file on 5.x, project-wide on
  4.27), an `FCsvParser` port, and the 5.x wrapper prepass. Tier one is an Aho-Corasick pass over
  the descriptors' tokens. Its README lists the approximations it knowingly makes.
- The fixture gained `Lexing.cpp` (comments, continued and raw strings over lines, quote
  characters, `LLOCTEXT`, `#else`, `#elif`, `#ifdef`) and three header wrappers in
  `Source/UEShedFixture/Public/UEShedFixtureTextWrappers.h`, called from `Wrappers.cpp`.
- **Conformance**: the scan reproduces every Unreal manifest exactly: 4.27 (46 entries), 5.7 (54
  and 59) and 5.8 (57 and 62), namespace, key, text, location, developer notes and metadata.
- Two more Unreal behaviours the oracle showed:
    - A wrapper around `NSLOCTEXT` gathers nothing on 5.x. Its body also holds `LOCTEXT`, so the
      prepass registers it twice under one name, and at every call each registration defers to
      the other. The scan reproduces this and reports it as `wrapper-unsupported`.
    - `HARBOR_LOCTEXT("Wrapped", …)` gathers on every engine, 4.27 included, without any prepass:
      its name ends in `LOCTEXT(`.
- **Speed**, release build, file reads included, second runs, `scan_project` example (target files
  are `*.cpp`, `*.h`, `*.ini` under `Source`, `Plugins` and `Config`):

    | Project               |  Files |   MB | Line-scanned | Places |         1 thread |         Parallel |
    | --------------------- | -----: | ---: | -----------: | -----: | ---------------: | ---------------: |
    | Large UE 4.27 project | 12,303 | 60.8 |          537 |  1,782 | 853 ms (71 MB/s) | 93 ms (656 MB/s) |
    | UE 5.7 project        |  4,301 | 23.8 |          210 |    668 | 358 ms (66 MB/s) | 32 ms (736 MB/s) |

    The spike read 49–75 MB/s single-threaded; the faithful port matches it, because tier one
    leaves 4–5 % of the files for the line scanner. The 5.7 project's wrapper prepass over the
    engine (79,614 files) took 5.96 s single-threaded and 0.53 s parallel, plus about 10 s to list
    the files, so the engine's wrappers (48 with the project's) are worth keeping per engine build.

- **Wiring (items 3 and 4)**: the scan runs inside the Game Text engine as a
  `{ action: "code_text" }` request, so it shares the engine's build identity and its types are
  generated into `game-text-contract.generated.ts`. File contents never cross into the host: the
  host sends the targets' steps, the engine answers with places, diagnostics, file counts and a
  per-stage profile (engine wrappers, project wrappers, listing, scan).
- `packages/code` (private) reads each target's `GatherTextFromSource` steps through
  `LocalizationEvidence`, a step's missing fields falling back to `CommonSettings` as the
  commandlet reads them, and annotates its span with the profile.
- `ue-shed code text <project-root>` takes `--target`, `--engine-root`, `--engine-version` and
  `--cache-root`. The engine comes from `@ue-shed/engine` discovery (the explicit root or the
  `.uproject` association) unless `--engine-version` names the behaviour directly.
- The engine's wrappers are cached under the cache root, one file per engine build shared by
  every project: keyed by crate version, engine root, engine line and `Build.version`, with paths
  kept relative to the engine root and rebased onto each project. `--refresh-engine-wrappers`
  reads them again, for a source-built engine edited without a version change. A second project
  on the 5.7 engine found the fixture's file and took 0.4 ms; the fixture's output was unchanged.
  The cache lasts across runs only when the caller passes a cache root: the CLI's `--cache-root`,
  and from Phase 2 the host's own cache folder.
- Through the command, the fixture's targets gather what Unreal gathered: on 5.8 `UnrealSource`
  57 and `UnrealSourceEditor` 62; with the engine found from the association (5.7), 54. The 5.7
  engine's wrappers took 3.7 s to find with a warm file cache and 0.4 ms from the cache; 52
  wrappers with the project's.
- **Against Unreal's own gather**, same file set, second runs, Unreal's logged stage times. The
  commandlet ran from the fixture projects with a recipe pointing at the research projects, so
  nothing was written into them; Unreal's 5.7 prepass therefore read the fixture's source, not the
  project's (about 4,250 files, a small skew in Unreal's favour).

    | Stage                                    |                                      Unreal |                            `unreal-code` |
    | ---------------------------------------- | ------------------------------------------: | ---------------------------------------: |
    | UE 5.7 project, wrapper prepass          |           2.97 s every gather (5.05 s cold) | 3.7 s once per engine build, then 0.4 ms |
    | UE 5.7 project, main scan                |                                      0.47 s |       358 ms on 1 thread, 32 ms parallel |
    | Large UE 4.27 project, scan (no prepass) |                                       6.6 s |       853 ms on 1 thread, 93 ms parallel |
    | Editor start before the gather           | about 5 s, and needs built project binaries |                                     none |

    Unreal's 5.x line scanner is itself quick (about 50 MB/s); the gain there is parallelism, the
    wrapper cache and no editor. Its 4.27 scanner is about 9 MB/s, so the port is 8× faster on
    one thread there.

- Not split yet: within the scan stage, reading files versus line scanning and CSV import. The
  scan stage is 3 ms on the fixture and 32–93 ms on the research projects, so the split waits
  until a profile shows it matters.

## Phase 2: Code places in Game Text

1. A `code_text` place kind beside the three saved kinds in `packages/game-text/src/schema.ts`
   and the index's place columns. Places are `read_only`.
2. **Current source against the manifest**: a gathered key whose current source differs from the
   manifest's is "Changed since gather", the existing line state, now for C++ and config text too.
3. **Audience evidence**: editor-only context and `UICommands.*` namespaces feed the existing
   audience policy as a new reason, `code_editor_only`.
4. **Incremental**: code records are keyed by file digest, so a rescan reads only changed source
   files, like packages today.
5. `loc gate` no longer warns `gathered_source` for a changed C++ or config file it can read: it
   judges its places like any other.

**Design (2026-10-29, planner)**, from a map of every consumer of the three saved kinds:

- **A code layer per target**, `code-text:<target>`, in the package shards' column format, so
  the join, search, focus, rules and exports read code places as occurrences. The Catalog lists
  only `Content` packages, so code files cannot join the 256 package shards; and a target's code
  set is exact only per target (its steps' folders, filters and editor-only setting, its split
  platforms, and on 4.27 its project-wide String Tables). The store already holds each target's
  own localization layers beside the shared package shards; the code layer sits with them.
- **Location kind 3, `code_place`**: `{ file, line, macro }`, with the file as Unreal names it in
  the manifest (`Source/…/Foo.cpp`) and no line for a String Table CSV entry. Columns: object =
  file, property = macro, row = line, class = wrapper. Read-only; origin `cpp` for C and C++
  files, `other_source` for INI and CSV.
- **Scope is the scan's**: a code place the target gathers rates inside; editor-only text the
  target leaves out rates outside with `editor_only_data_not_gathered`. Asset filters never apply
  to code places.
- **Audience**: editor-only context is evidence, reason `code_editor_only` (like the gather
  table's); a `UICommands` policy row marks `UI_COMMAND` text editor text.
- **Producer**: a reader operation runs `unreal-code` for one target and stages the layer; the
  host publishes it only when its content key changed, so an unchanged scan leaves the join
  alone. The host passes the engine line, engine root and its cache folder; without them no code
  layer is built, and the coverage statement says code was not read.
- **Item 4, changed**: a full target scan is 32–93 ms parallel on the research projects
  (Phase 1), so a rescan scans every file and publishes only on change. Per-file records keyed
  by content belong to Phase 3's record store, which needs them for points anyway.

**Evidence (2026-10-29)**:

- **Writer**: `publish_code`, a builder request the reader runs (as it runs `plan_packages`):
  `unreal-code` scans the target, one package-text record per file with places, staged in the
  package columns and published cold under `code-text:<target>` when its content key differs.
  `occurrence.gather` 3 marks code text the target leaves out; the join rates it outside. The
  outcome carries the scan's counts, up to 200 diagnostics and the per-stage profile, which the
  host puts on its span.
- **Readers**: the join, incremental join, summary, focus, line places, corpus and CSV exports and
  the rules engine all know kind 3. Before, a code place would have panicked the rules engine
  (`location_kinds[3]`), failed focus, places and the gate, and rendered as an asset elsewhere.
  Key-change pairing reads a code place as `file[line]`, and a 4.27 manifest's `file:line` the
  same way. The summary counts all five origins (state v3; joins rebuild once).
- **Policy**: `code_editor_only` is appended to the audience reasons; the `ui_command` row
  (`macro` match) is the policy's last row, so stored row positions hold. Package shards key on
  the rows saved text can match, so this phase re-reads no package and re-encodes no shard.
- **Hosts**: `GameTextIndexRefreshRequest.code` (`{ engine, engineRoot? }`) and the workspace's
  `codeSource` hook. The CLI resolves the engine from the project's association, or from
  `UE_SHED_ENGINE_VERSION` and `UE_SHED_ENGINE_ROOT`; Workbench from its engine setting or the
  association. `sourceGatherSteps`, `sourceGatherEngine` and `projectSourceGatherEngine` moved to
  `@ue-shed/localization`, since the published `@ue-shed/game-text` cannot use the private
  `@ue-shed/code`. The Game Text UI shows a code place's `file:line` and macro, offers no Show in
  Unreal for it, and refuses ID repair ("Change this text in its source file").
- **Fixture through the CLI** (`FixtureGame`, 5.7 from the association): its two gathered C++
  lines now come from the code layer, translated in every culture, where they were gathered-only
  manifest evidence. With `UEShedLocalizationText.cpp` edited and then restored:

    | Edit                           | State                                                         | `loc gate`                       |
    | ------------------------------ | ------------------------------------------------------------- | -------------------------------- |
    | `LOCTEXT` text changed         | Changed since gather                                          | `translated_text_changed` (fail) |
    | New `LOCTEXT`                  | Not gathered yet                                              | `not_gathered` (warn)            |
    | `LOCTEXT` in `#if WITH_EDITOR` | Outside this target (`editor_only_data_not_gathered`), editor | not judged                       |
    | Unedited                       | Translated, from the code layer                               | passed, no `gathered_source`     |

    `loc status` took 9.0 s cold (the whole index), 2.0 s warm and 2.1 s after the edit.

- **Found on the way**: the gate integration test expected no skipped targets, but Phase 1's
  oracle targets (`UnrealSource`, `UnrealSourceEditor`) have no manifest in the project; and
  Phase 1's rename left `apps/cli/package.json` unformatted, which stopped PR CI before its tests.
- **String Tables in code** (after the review): an asset's text that names a String Table C++
  defines (`LOCTABLE_NEW`) by its table ID joins that entry's line, with its translations. A code
  place carries `table` in the class column, since a String Table entry never has a wrapper; a
  join fact test covers a resolved and a missing entry.
- **Gaps**: Electroswag passes no `codeSource` until Phase 6.

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

**Where a warm `loc gate` goes (2026-10-29)**, the asset-only sample on the UE 4.27 project, 10.3 s
end to end, from the CLI's spans:

| Stage                                                                    |   Time |
| ------------------------------------------------------------------------ | -----: |
| Node and the TypeScript loader starting (a dev run; not the release CLI) | ~2.0 s |
| Project refresh: Catalog (`project_index_refresh` and `status`)          |  0.9 s |
| Project refresh: package plan over 167,507 packages                      |  2.3 s |
| Code layer: scan and key                                                 |  0.5 s |
| Opening the index for queries                                            |  1.2 s |
| Corpus header: every package's coverage and diagnostics, into TS         |  1.9 s |
| The gate's own read of the listed files' lines                           |  0.5 s |

The changelist's own work is 0.5 s; everything else is the whole project, every time. The corpus
header also breaks the bulk-data rule: the gate needs the coverage of a few listed files and
receives 167,507 packages'.

**Design (2026-10-29, planner)**:

- **A record is one file's package-text columns**: exactly the per-package `Columns` the shard
  path builds before appending them to a shard (`project_one_path`, then `native_stored`, then
  `Columns::feed`), written alone as a staged file. Key: SHA-256 over the format, the saved-text
  policy key and the SHA-256 of the file's bytes. Records live in the cache root's
  `records/<k[0..2]>/<k>` and are written once: a revision read for one changelist is a hit for
  every later one, in any project on the machine. A code file's record is its places from
  `unreal-code`, in the same columns, keyed by its bytes and the target's scan context (wrappers,
  engine line); on 4.27, String Tables are project-wide, so a code point keeps the context's key.
- **A point is a manifest**, `points/<id>`: `{ base, entries: path → record key | removed }`. A
  changelist's points are sparse: only its files, over a base. Ids: `local`, `depot@<CL>`,
  `shelved:<CL>`.
- **Revisions**: the host prints each revision a point needs into `revisions/<md5>-<size>`, from
  the digest and size `p4 describe` reports, so a revision is printed once. Submitted: base is
  each file at `#rev-1` (an add has none), head at `#rev` (a delete has none). Shelved: base is
  the revision the shelf is based on (`shelvedDiffRevisions`), head `@=<CL>`. Local: head is the
  file on disk, base `#have`. The engine reads these files; it starts no processes.
- **Perforce**: through the `p4client-ts` connection Map History already resolves
  (`resolveConnection`, `describeChangelist`, `printBatch`), moved where both use it rather than
  copied.
- **Reader request** `read_point`, intercepted in the reader as `publish_code` is: it hashes,
  looks up and fills records and writes the point; its outcome counts hits, misses and bytes and
  carries per-stage times, which the host puts on its span.
- **Not in Phase 3**: the diff and impact (Phase 4), so this phase measures reading a changelist's
  two points against the full refresh. The corpus header cut (the gate reads listed files'
  coverage natively) is a clear cut taken here, since every changelist check pays it.

**Evidence (2026-10-29, first slice: packages)**:

- **The corpus header cut**: the gate asks for the listed files' coverage (`file_coverage`); the
  engine matches files as `where.files` does and builds diagnostics for those packages only. That
  stage went from 1.94 s to 0.61 s and the warm gate on the UE 4.27 project from 10.3 s to 8.3 s,
  with the same verdict. The 0.61 s left decodes every package's path to match a few.
- **Records and points**: `read_point` hashes each package, reuses its record when the cache holds
  one, else parses it through the shard staging's projection and writes the record beside a status
  file; the point's manifest names a record per file. A reader test reads a package once, reuses it
  at a second point, and marks a removed file and a code file.
- **Revisions**: Map History's `readChangelistRevisions` describes the change, maps the project
  folder, and prints only the files the caller's points read, one `print` per side; a revision is
  printed once. Map History's workspace choice now also finds a project in a subfolder of its
  workspace (the deepest workspace root above it).
- **The sample changelists' points**, through `scripts/changelist-points-measure.ts`, cold (empty
  caches) then warm, packages only:

    | Kind                  |     Changelist | Packages | Printed              |  Cold |  Warm |
    | --------------------- | -------------: | -------: | -------------------- | ----: | ----: |
    | Asset only            |         220368 |        9 | 18 revisions, 2.0 MB | 3.8 s | 1.9 s |
    | Mixed                 |         220253 |       16 | 24 revisions, 4.4 MB | 5.6 s | 1.8 s |
    | Shelved               |         220258 |       12 | 18 revisions, 3.6 MB | 4.8 s | 1.5 s |
    | Code only, key rename | 220336, 219062 |        0 | none (not read yet)  | 1.8 s | 1.7 s |

    Reading the points takes 0.03–0.09 s; the rest is Perforce and starting the processes. The
    first version printed one revision per `print` and every changed file: 27 s for the mixed
    sample, and 3.0 GB in 189 s for the gather commit's compiled localization files.

- **Found on the way**:
    - `p4client-ts` 0.13.0 rejects `print` output for a shelved add, whose revision Perforce names
      `none`; such a file is printed with `print -o` through its untyped runner. The fix belongs
      upstream.
    - Map History looks only at the user's own workspaces. On the measuring machine the project's
      workspace belongs to another user and `P4CLIENT` names a build agent's, so the runs named the
      workspace in `P4CLIENT`. A host setting for the workspace is still to come.

**Evidence (2026-10-29, second slice: code)**:

- **A code file's record** is its places as the target scans them, from the revision's bytes:
  `unreal-code`'s `scan_files` runs each gather step over the files it gathers, judged by path, so
  a printed revision need not be on disk. A conformance test scans the fixture's code from a copy
  elsewhere on 5.8, 5.7 and 4.27 and gets the target scan's places. The record key replaces the
  policy with the scan context (wrappers, audience policy, scan request), so a change to any of
  them makes new records. A code file the target does not gather is `not_gatherable`; without a
  target, code files stay `unread`.
- **What a point does not take from the revision**: wrappers and String Table CSVs come from the
  project on disk, as the full scan reads them. A changelist that changes a wrapper or a CSV is
  read with the workspace's; the CLI does not print CSVs.
- **A clear cut found on the way**: on 4.27, finding the project's wrappers walked the whole
  project source tree and then discarded it (4.27 has no wrapper prepass): 0.21 s per point, and
  part of every full code scan. It no longer walks.
- **The sample changelists' points with code** (target `Game`, 4.27), cold then warm:

    | Kind                | Changelist | Files read | Printed              |  Cold |  Warm |
    | ------------------- | ---------: | ---------: | -------------------- | ----: | ----: |
    | Code only           |     220336 |    19 code | 38 revisions, 0.3 MB | 3.7 s | 1.5 s |
    | Asset only          |     220368 |          9 | 18 revisions, 2.0 MB | 2.9 s | 1.5 s |
    | Mixed               |     220253 |         36 | 64 revisions, 5.0 MB | 5.0 s | 1.5 s |
    | Shelved             |     220258 |         26 | 44 revisions, 3.7 MB | 6.1 s | 1.5 s |
    | Key rename (gather) |     219062 |          0 | none                 | 1.5 s | 1.5 s |

    The reader takes 0.004–0.022 s of a warm read and 0.07–0.20 s of a cold one; the rest is
    Perforce and starting the processes. Against Phase 0's warm `loc gate`, 9.0–11.9 s, a warm
    changelist read is 1.5 s.

**Evidence (2026-10-29, third slice: the base's localization, and local points)**:

- **The target's manifest and archives as the change found them**: at the changelist before a
  submitted change, and at the depot's head for a shelf. On the UE 4.27 project they are 757 MB
  at a revision (a 78 MB manifest and ten archives of 61–72 MB), so they are never printed when
  the workspace has them: `p4 files` lists them at the base and at `#have`, and a file the
  workspace has at that revision and has not checked out is read where it is. Any other revision
  is printed once with `print -o`, straight to the revision cache, never held in memory. Every
  base after the last gather, which is every changelist review but a gather's own, prints nothing.
- **Round trips**: each Perforce command costs about 0.4 s on this server, and resolving the
  workspace about 0.8 s. A changelist read now resolves the workspace once and runs `describe`,
  `where` and both `files` lookups together.
- **Local points**: `local` (the files on disk) over `before.local` (the workspace's revisions),
  for a list of files, the way `loc gate --files` names them. A checked-out file's `#have` is
  printed; an unopened one is read in place.
- **The sample changelists' points with code and the base's localization**, cold then warm:

    | Kind                           |     Read | Localization                  |   Cold |  Warm |
    | ------------------------------ | -------: | ----------------------------- | -----: | ----: |
    | Code only, 220336              | 19 files | from the workspace            |  3.8 s | 1.4 s |
    | Asset only, 220368             |  9 files | from the workspace            |  3.0 s | 1.4 s |
    | Mixed, 220253                  | 36 files | from the workspace            |  4.9 s | 1.4 s |
    | Gather commit, 219062          |  0 files | printed: 11 revisions, 757 MB | 13.0 s | 1.4 s |
    | Shelved, 220258                | 26 files | from the workspace (head)     |  6.5 s | 1.6 s |
    | Local, the code sample's list  | 19 files | from the workspace            |  1.5 s | 1.3 s |
    | Local, the mixed sample's list | 36 files | from the workspace            |  1.3 s | 1.4 s |

    A warm changelist read, the base's localization included, is 1.3–1.6 s against Phase 0's
    9.0–11.9 s warm `loc gate`; Perforce is about 0.8 s of it.

- **Phase 3 is complete** against its items: records and points, revisions through Map History's
  connection, the submitted, shelved and local pairs, and the measurements. Phase 4 joins two
  points' records and the base's localization into the impact.

## Phase 4: Diff and impact, natively

1. **Diff** two points' records in the engine, with `diffPackageText`'s pairing rules for both
   package and code places. Retire the TypeScript per-line diff once the host reads the native
   one.
2. **Impact** in one call: the diff joined to the base point's localization, returning per
   culture the stale translations, keys that lose translations through a rekey, colliding text and
   new text not yet gathered, with paged rows and counts.
3. `loc gate`'s checks read the impact instead of a full corpus scan when a point pair is given.
4. Contract types generated; the host reads paged columns, never every line as JSON.

**Design (2026-10-29, planner)**:

- **One engine call, `compare_points`**: a point, its base, and optionally the base's
  localization. It answers the changes, the findings, and their counts, with a bounded page of
  each; the host never receives a point's text in bulk. It runs in the engine without a pinned
  index reader and without the store's writer lease, so it never waits on a refresh.
- **The diff** reads both points' records (the staged columns the reader wrote) file by file.
  Package places pair as `diffPackageText` pairs them: by place inside the package, identical
  text first, then saved order. Code places pair by file and identity, not by line, so an edit
  above a macro does not show as text removed and added; a code place left over on both sides with
  the same text and another key is `rekeyed`. A file only one point has is all `added` or all
  `removed`.
- **The base's localization lookup**: the target's manifest and archives at the base, parsed once
  into a file sorted by namespace and key (each identity's manifest contexts, and per culture the
  translation and the source it was made for). It is keyed by the files' depot revisions, which
  Perforce fixes, so finding it hashes nothing, and every review between two gathers shares it.
  A review reads only the identities its changes name, by binary search.
- **Findings use `loc gate`'s checks, judged against the base**, so only what the change
  introduces counts; a problem already in a changed file before the change is not reported.
  Empty text is left out, as Unreal's gather leaves it out:
    - `key_changed`: a place's key changed, or text moved to a new key in the change, and the
      earlier key had translations the new one lacks; per culture.
    - `conflicting_source`: after the change, a key has more than one text, across the changed
      files or against its manifest contexts in files the change did not touch, and the base's
      manifest gave it one.
    - `translated_text_changed`: a gathered key's text changed and some culture's translation
      was made for the earlier text; per culture. Otherwise `text_changed`.
    - `not_gathered`: text the change places at a key the base's manifest does not have.
    - `unresolved_key`: changed text with no reliable key.
    - `removed`: a gathered key the change removes from its last place; the next gather drops it
      and its translations.
    - `partial_read` from the points' statuses, and `gathered_source` for code files a point did
      not read.
- **Where the TypeScript diff goes**: `diffPackageText` stays until Electroswag's review page
  reads `compare_points` (Phase 6); the CLI never uses it.

**Evidence (2026-10-29)**:

- **The diff**: `diffPackageText`'s cases, ported to the native package diff, pass unchanged
  (place by place, identical text first, a new namespace or a table reference as a rekey,
  branched package names lining up, cells and entries kept apart). A reader test edits a code file
  and judges it against a written manifest and two archives: a line added above every macro leaves
  the moved text unchanged, and the test gets each finding kind with the cultures it names
  (`key_changed` by rekey and by moving text to a new key, `conflicting_source`,
  `translated_text_changed`, `not_gathered`, `removed`).
- **The lookup**: built in 5.6 s from the UE 4.27 project's 757 MB of manifest and archives, four
  files at a time, once per set of revisions; opened in under 1 ms by every later review.
  Judging a change takes 0.04–0.10 s for the largest samples (700 changed texts).
- **The sample changelists, warm** (points, comparison and Perforce together; Phase 0's warm
  `loc gate` took 9.0–11.9 s):

    | Sample          | Changes                                     | Findings                                                                                                             |  Warm |
    | --------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----: |
    | Code, 220336    | none (7 texts unchanged)                    | none                                                                                                                 | 1.4 s |
    | Asset, 220368   | none (315 unchanged)                        | none                                                                                                                 | 1.3 s |
    | Mixed, 220253   | 660 added, 35 removed, 20 rekeyed, 1 edited | 1 conflict, 1 translated text changed (9 cultures), 77 not gathered, 9 no key, 1 removed (9 cultures), 2 partly read | 1.6 s |
    | Shelved, 220258 | 235 added, 11 removed, 34 rekeyed           | 1 conflict, 91 not gathered, 2 no key                                                                                | 1.6 s |

    The mixed row was first recorded as 664 added and 11 without a key, before empty text was left
    out; the shelf's rows move as the depot's head, its base, moves (275 added, 8 removed,
    36 rekeyed and 110 not gathered on 2026-10-29 evening).

- **Against the full `loc gate`** on the same samples (Phase 0's runs): on the mixed sample both
  fail on the same two findings (a `KismetSchema` key given a new text, and translated text
  changed on `TownieGroupMerfolk`). The comparison leaves out keyless text the changed widgets
  already had before the change, and adds a key the change removes from its last place, whose
  translations in 9 cultures the next gather drops. On the shelf, the full gate read the
  workspace's files rather than the shelved ones; the comparison judges the shelved text.
- **The gate from a comparison**: `localizationGateComparison` turns the findings into the gate's
  target result (checks, fail or warn by policy, items with guidance naming the cultures and the
  earlier key). Phase 5 puts it behind `loc gate --change` and `--shelved`.
- **Left as the full gate has it**: text audience is not applied (the full gate does not apply
  it either), and a key the base's manifest already gave several texts is not reported as the
  change's conflict.

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

**Design (2026-10-29, planner)**:

- **`loc gate` takes one change**: `--files <list>` (as before: every line in the files on disk),
  `--change <CL>` or `--shelved <CL>` (the change from Perforce, judged against each target's
  localization as the change found it, through `comparePoints` and
  `localizationGateComparison`). Two of them, or none, is a usage error. The result gains
  `change`: the two points, the files the change touches in the project, how many were read, how
  many lie outside, and whether code was read with an engine.
- **One Perforce read for every target**: `readChangelistPoints` and `readLocalPoints` take the
  targets' names, fetch the change and every target's manifest and archives together, then read
  and compare the points one target at a time (a point's id names the change, not the target).
- **`--format json|text|markdown`**; `--summary` stays as `--format text`. The Markdown is plain
  (no HTML, so Swarm and build pages show it as written): the outcome, a count per check that
  found something with its policy, the failing lines with a way forward, the first 20 warnings,
  and a coverage statement (files read, code read or not, CSVs and wrappers from the workspace,
  reflected metadata not checked).
- **`loc diff`** takes the same three change flags, not `--from`/`--to`: every pair the CLI can
  name today is a change and its base. Two arbitrary depot points need a range read
  (`p4 files @A,@B`), which Phase 6's point pickers need too; it is left for then. `--limit`
  (1–1,000) bounds the lines listed; counts are whole. It exits `0` whenever it read the change.
- **Exit codes from the error's next step**, in one table (`CLI_EXIT_CODES`): `0` done, `1` a
  failed check, `2` could not run, `3` may succeed if repeated (`nextStep: "retry"`), `4` a crash
  with no typed cause (was `1`, which a script read as a failed check), `130` interrupted.
  `escalate`, `fix_input` and `reconcile` all exit `2`: 53 CLI input errors carry `escalate`, so a
  finer split would misreport them until each is relabelled. A failure prints its code and its
  typed cause's recovery, looking through the CLI's generic error.
- **The error table** (`CHANGE_CHECK_ERRORS`): each code `loc gate` and `loc diff` can end with,
  its cause, its fix and its exit code. Both tables are generated into the product docs, and a
  test fails when the docs differ.
- **Perforce failures by cause**: the revision reader now classifies a failed command as Map
  History does (authentication, configuration, not in the workspace's view, a dropped connection
  that may be retried), and a changelist Perforce does not know is `invalid_target`, the caller's
  to fix. Before, every failure there read "Perforce has no workspace for this project".
- **The agent guide** ships in `apps/cli/guides` and prints with `ue-shed guide changelist-check`;
  a test runs `--help` for every command it names and checks each flag.

**Evidence (2026-10-29)**:

- **`loc gate --change` through the CLI** on the UE 4.27 project, warm, one process per run (a dev
  run: Node and the TypeScript loader start in about 2 s of it); Phase 0's `loc gate --files`
  took 9.0–11.9 s the same way:

    | Run                                 | Exit | Outcome                                                           |  Time |
    | ----------------------------------- | ---: | ----------------------------------------------------------------- | ----: |
    | `--change 220253` (mixed), Markdown |    1 | 716 changed lines; the `KismetSchema` conflict and `Merfolk`      | 3.1 s |
    | `--change 220253`, every target     |    1 | the same; the project has one target                              | 3.1 s |
    | `--shelved 220258`, text            |    1 | 319 changed lines; one conflict                                   | 3.0 s |
    | `--change 220336` (code only)       |    0 | no changed lines                                                  | 3.0 s |
    | `--change 220368` (asset only)      |    0 | no changed lines                                                  | 2.9 s |
    | `loc diff --change 220253`, text    |    0 | 660 added, 35 removed, 20 rekeyed, 1 edited, and the impact       | 3.2 s |
    | `loc diff --files` (the mixed list) |    0 | the workspace has those revisions: 1,019 unchanged, 2 partly read | 3.0 s |
    | `--change 99999999`                 |    2 | `invalid_target`: "no such changelist"                            | 2.9 s |
    | `--shelved 220253` (submitted)      |    2 | `invalid_target`: "Changelist 220253 is submitted, not shelved."  | 3.0 s |
    | `--change 220258` (pending)         |    2 | `invalid_target`: "Changelist 220258 is pending, not submitted."  | 3.0 s |

- **Found on the way**: `--shelved` on a submitted changelist read its files at the submitted
  revision on both sides and judged them as a shelf. The revision reader now refuses a change
  whose status is not the one asked for. A stale reader is refused by the engine's contract
  check (`index_failed`, exit 2), as designed.
- **Tests**: the gate's selection errors, the Markdown and text verdicts for a changelist and a
  shelf, `loc diff`'s text and Markdown, the exit mapping through the CLI's generic error, the
  docs' generated tables, and the guide's commands and flags against `--help`.
- **Phase 5 is complete** against its items. Phase 6 is Electroswag's review page and compare.

## Phase 6: Electroswag

In the Electroswag repository, on its own branch:

1. **Localization impact** on the submitted-changelist review page
   (`P4ServerChangelistReviewPage`): counts, then the changed lines with their place, the cultures
   affected and the way forward. Shelved changelists too.
2. **Compare** in Game Text: two point pickers (local, a submitted changelist, a shelved one) over
   the same diff.
3. C++ places in Game Text's line detail, read-only, with reveal in IDE.

**Design (2026-10-29, planner)**:

UE Shed, on this branch and in the same release:

- **The host names the workspace.** Map History's revision reads take the host's `P4ClientOptions`;
  a `connection.client` it names is used as named, not re-chosen from the user's own workspaces.
  Electroswag passes the selected project's workspace; the CLI keeps `P4CLIENT`.
- **A range read**, `readRangeRevisions({ from, to })`: `p4 files <project>/...@>from,@to` lists
  each file's last revision in the range, and one `p4 files` lists the same files at `@from`; both
  sides are printed as a changelist's are, and the targets' localization is read at `from`. A
  range whose read files pass 2,000 is refused (`invalid_target`, "pick a shorter range"): it
  bounds what one review prints.
- **Change points move into Game Text** (`readChangePoints` in `@ue-shed/game-text/index`): the
  CLI's orchestration (each target's outputs, the read, the two points and the comparison) is
  shared by every host. Game Text gets revisions through a `GameTextChangeRevisions` the host
  supplies, which Map History's three reads fit as they are, so `p4client-ts` stays in Map
  History.
- **`compareChange` in the workspace contract**: a submitted change, a shelf, a range or listed
  working-copy files, one target or every target, paged changes and findings. It answers what
  `loc diff` does (the change block, and per target the counts, the page of changes and the
  findings with their cultures) and reads code with the workspace's code source. The host hook
  `changeRevisions` supplies Perforce; without it the method fails `capability_missing`.
- **`--from <CL> --to <CL>`** joins the change flags of `loc gate` and `loc diff`: the range,
  judged against the localization at `from`.

Electroswag, on `feat/changelist-text-review`:

- **The server** gives the Game Text workspace Map History's reads with the project's Perforce
  options, and a code source from the project's engine association through `@ue-shed/engine`.
- **The review page** gets a Text section for submitted and shelved changelists: the outcome,
  a count per check, then the changed lines with their place, the text before and after, the
  cultures affected and the way forward, paged. It reads the selected project; a change with no
  files in it says so.
- **Compare in Game Text**: a Compare view with two pickers. "To" is the working copy, a submitted
  changelist or a shelf; "From" is what it changed from, or, when "To" is submitted, an earlier
  submitted changelist (the range). Other pairs need the workspace's sync state at a changelist
  and are not offered. It lists the same rows as the review page.
- **C++ places in line detail**: the file, line and macro, read-only, and **Open in IDE** with the
  source code accessor the project's Unreal settings name (Visual Studio, Rider or VS Code), else
  the system's app for the file.

**Evidence (2026-10-29)**:

- **UE Shed**: `readRangeRevisions` and `rangeRevisionSpecs` (unit-tested: a file the range edits,
  adds, deletes, or adds and deletes); `perforceChangeRevisions`; a host-named workspace used as
  named; `readGameTextChangePoints` shared by the CLI and the workspace; `compareChange` in the
  contract, served from a real workspace in the contract test (`capability_missing` without the
  hook); each finding's severity and way forward, and the verdict, from `changeComparisonTarget`
  (unit-tested against the policy); `LOCALIZATION_GATE_CHECK_LABELS` shared by the CLI and hosts.
- **The range read on the UE 4.27 project, through the CLI**:

    | Run                                        | Outcome                                       |  Time |
    | ------------------------------------------ | --------------------------------------------- | ----: |
    | `loc diff --from 220252 --to 220253`       | the same changes as `--change 220253`         | 3.8 s |
    | `loc diff --from 220340 --to 220355`, cold | 19 added, 10 removed, 80 rekeyed (29 files)   | 8.2 s |
    | the same, warm                             | the same                                      | 3.9 s |
    | `loc gate --from 220340 --to 220355`       | fails: a key change leaves 9 cultures behind  | 3.8 s |
    | `--from 220355 --to 220340`                | exit `2`: "Name the later changelist as --to" | 1.5 s |

    In one process, warm, the range reads in 2.1 s and the shelf in 1.3 s.

- **Electroswag** (Stairway-Games/electroswag#124, a draft until 0.24.0 is published; its UE Shed
  packages are packed from this branch): the review page's Text section, Compare in Game Text, and
  code places with Open in IDE. `pnpm run check` and the full Vitest suite pass. In serve mode
  against the UE 4.27 project, changelist 220253's review page fails on the `KismetSchema`
  conflict the CLI reports, and Compare over changelists 220340 to 220355 gives the CLI's counts
  and the key change's 9 cultures.
- **Found on the way**:
    - Electroswag's Game Text UI assumed every place is a saved asset; Phase 2's `code_place`
      reached 25 sites. Each now names a code place by its file and line and never offers Show in
      Unreal for it.
    - On a machine without the project's engine installed, `projectSourceGatherEngine` answers
      undefined, so Electroswag reads no code and says so (the Merfolk finding in a C++ header is
      then not seen); the CLI reads code with `UE_SHED_ENGINE_VERSION` alone. Whether a host should
      read code without the engine's wrapper macros is open.
- **Phase 6 is complete** against its items.

**Design review (2026-10-29)**: two critiques of the first screens, one from Opus and one from
Muse, given the screenshots and the code, not the planner's view.

- **The verdict was wrong, not just badly shown.** Both lists led with Blueprint graph labels
  (`K2Node,Target`, `KismetSchema,SplitPinFriendlyNameFormat`). The project's own `Game.manifest`
  has no `K2Node` text and one `KismetSchema` line, and its gather sets
  `ShouldGatherFromEditorOnlyData=false`. `comparePoints` trusted only the gather table's editor-only
  bit, and most graph text has no gather-table site. It now leaves out package editor text as the
  index rates it out of scope (the gather table, else the audience policy), unless the base's
  manifest names that key in that file. On the CLI:

    | Change               | Before                                                          | After                                                           |
    | -------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
    | 220253               | 652 added; fails on a `KismetSchema` pin label; 70 not gathered | 34 added; fails on the Merfolk C++ text change; 23 not gathered |
    | range 220340..220355 | 19 added, 80 rekeyed; fails on a key change in 9 cultures       | 1 added, 1 removed; passes, 1 not gathered                      |

    The 80 "rekeys" were function categories (`KismetSchema,Default`) and pin labels.

- **Electroswag's screens, reworked** on #124:
    - the verdict leads, as a banner with the target named, and says "passes on what was read" when
      code or a package was not read in full; what was not read is one line under it;
    - findings to fix open, warnings fold to a line with their guidance said once, and each opens
      grouped by file with Show diff and Show in Unreal; no scroll box inside the page;
    - rows lead with the text; keys show only for key checks, shortened, with no leading comma;
    - the counts open the changed lines of their kind; "Unchanged" is a muted figure;
    - on the review page, the verdict alone shows until the change fails or the reviewer opens it,
      the details take at most half the page, and Show diff folds them; a pending changelist gets
      the section too, compared as its opened files are on disk;
    - Compare is "Change" and "Against", names each changelist as it is typed, says in a sentence
      exactly what a range compares (after `from`, up to and including `to`), keeps its result
      across tabs, and drops the scan status it never needed.
- **Not done**: word counts for vendor batches, the gate policy shown beside the verdict, and
  per-culture rollups. Both critiques asked for them; they need data the comparison does not
  return yet.
- **Found**: opening the review page as the project opens can race the project index for the
  catalog writer lock (`cannot acquire Catalog writer lock`); the index gave up instead of
  waiting. It predates this rework; Electroswag's index keeper now waits up to 30 seconds for the
  lock.

**Owner review of the rework (2026-10-29)**: three faults the screenshots showed and the first
rework kept.

- **The details crushed the diffs.** Stacked above them, even capped at half the page, they left
  the diffs a third of the screen. The review page now shows one verdict line per target above
  full-height diffs, and **Text report** swaps the diffs for the report; Back to diffs and Show diff
  swap back. The diff layout controls hide while the report shows.
- **The file tree was light.** `@pierre/trees` sets `color-scheme: light dark` and so follows the
  system; Electroswag is dark only, and the tree's styles now say so.
- **The Change/Against picker was hard to use.** Compare is now a changelist list like P4V's:
  Submitted, Shelved or Pending, newest first. A click compares one; a shift-click on the
  submitted list compares every changelist between the two together, as one band.
- **Found on the way**: a change that is all C++ and config, with the engine not installed, said
  "Passes" on nothing read; it now says **Not checked**, and "files read" counts only what was.
  Shelf 220630 (5 C++ files) shows it. The sticky diff file header was see-through.

**The text diff (2026-10-29)**: the owner asked for the changed text itself as a diff, built to
diff `.po` and `.archive` files later.

- Electroswag's `TextDiff` takes neutral entries: a kind, the key on each side, the file, a place,
  and fields (source, notes, a key, later a culture's translation). It knows nothing of Game Text.
  Entries group by file; each is diff lines with the sign and colour saying what happened, the
  words that differ marked (`Intl.Segmenter` words, so text without spaces splits too), and the
  key and place in aligned columns. A new key is a `Key` field, old over new, so a namespace or
  generated key that the short label hides shows where it differs. Kind filters and a text, key
  or file filter work on the loaded page; Load more keeps them.
- `.po` and `.archive` need a differ that pairs entries by key, natively and paged, as the
  comparison does; `TextDiff` takes its pages unchanged.
- **Found while reading real ranges:**
    - Changelists 220671 to 220804 failed with `spawn ENAMETOOLONG`: `readRangeRevisions` named
      every changed file on one `p4 files` command line. It now lists them in batches under
      Windows' limit.
    - Recompiling a Blueprint renumbers its generated functions, so cutscene lines showed as removed
      and added with the same key and text. A text that only moves to another object of its package
      is now unchanged. On that range, added went from 192 to 161 and removed from 35 to 4.
    - Two rekeys the diff now makes plain are real: 184 interaction prompts in one map got new
      generated keys, and 397 lines of a dialogue DataTable went from row-named keys to GUIDs. Both
      lose their translations.

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
  variables and log categories. They are `unreal-code`'s follow-ons, on the same scanner.
- Editing C++, INI or CSV source.
- File compare against a chosen PO, archive or CSV, and our own CSV format. Later work.
- Translation briefs for agents and review comments that travel with a branch (owner, 2026-10-28).
- SARIF and GitHub annotations: text lives in `.uasset` files, and studios run Perforce.

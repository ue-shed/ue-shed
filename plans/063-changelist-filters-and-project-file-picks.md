# Plan 063: Changelists that touch text, and the project's own localization files

> **Executor instructions**: Read this plan fully before starting. Also read `AGENTS.md`,
> [ADR 0012](../docs/decisions/0012-native-engine-boundary.md), Plan 060 (`compareChange`, the
> revision cache) and Plan 061 (`compare_text_files`). This plan spans three repositories: UE Shed
> (this one), Electroswag and Tools (`packages/cores/perforce`). Run targeted checks while you
> iterate. Honour the STOP conditions. At the end of every phase, record its evidence and
> measurements here and review the plan with the owner before starting the next phase.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- packages/game-text crates/game-text-index crates/uasset-inspection/src/package_header.rs packages/p4client-ts`.

## Status

- **State**: TODO. Written 2026-10-30 with the owner; Phase 1 first.
- **Priority**: P1 (Phases 1 and 2), P2 (Phases 3 to 5)
- **Effort**: L over all five phases; Phases 1 and 2 are M each.
- **Risk**: LOW for Phases 1 to 3, which read Perforce and the project and write only local
  caches. MEDIUM for Phase 5, which takes facts from signed-in clients into a shared store.
- **Depends on**: Plan 060 (changelist reads, the revision cache), Plan 061 (`compare_text_files`),
  the Tools Perforce core's compact store (Phases 4 and 5).
- **Category**: product
- **Planned at**: `release/0.25.0`, 2026-10-30

## Context

Game Text's Compare tab has two modes. **Changelists** lists every submitted, shelved and pending
changelist of the project's stream, like P4V. Most of them change no text: of the last 150
submitted changelists in ProjectCoral-MP, and the last 120 in ManaBreak Research, the edited
assets are mostly animations, textures, meshes, cutscenes and widgets, and many changelists are
C++ or audio only. Finding the ones that matter means opening them one by one.

**Files** compares two `.po`, `.archive` or `.manifest` files, chosen in the native file dialog.
The files a person compares are nearly always the project's own: a target's manifest, archive or
a culture's `.po`, now against an earlier revision. Today that means finding the file on disk and
printing the earlier revision by hand (`p4 print -o`), which is how the 21 October and 30 October
French `Game.po` of ProjectCoral were compared for 1.11.0.

## Decisions

1. **A file fact is keyed by content, never by changelist.** Perforce submissions don't change:
   there is no force-push. The exceptions are `p4 obliterate` (revisions disappear), `p4 change
-f` (an admin rewrites a description, user or date, never files), `+S` file types (old content
   purged) and shelved or pending changes, which change freely. A fact keyed by the revision's
   Perforce MD5 and size, plus a producer version, can't go stale under any of them: an
   obliterated revision is only never asked for again, and integrations and copies of the same
   bytes share one fact. Shelved and pending files are looked up the same way, since their
   digests are known too.
2. **What a fact holds.** For a package: whether it holds gathered text, by the header rule Game
   Text scans use (`PKG_RequiresLocalizationGather`, or a gatherable text count and offset;
   `crates/uasset-inspection/src/package_header.rs`), its gatherable text count, and its asset
   class (which the uasset diff work will use: "12 Widget Blueprints"). For C++ and config:
   whether it holds text macros, and how many, as `@ue-shed/code` reads them. Localization files
   (`.po`, `.archive`, `.manifest`, `.locres`) and String Table CSVs need no fact; the extension
   says it. The producer version names the header rule and the code reader version; a new rule is
   a new version, never a rewrite.
3. **A changelist touches text when any of its files does, on either side.** An edit counts when
   the new or the previous revision holds text (text removed is a text change). A delete looks at
   the previous revision, an add at the new one. A changelist's counts are computed when it is
   read, from its files' facts, and never stored.
4. **Facts are worked out where the bytes are cheapest.** When the workspace has that exact
   revision (digest equal to the file on disk), read the header from disk. Otherwise stream
   `p4 print` and stop once the header is read, so a 100 MB package costs kilobytes. Code files
   are read whole; they are small.
5. **Bulk stays native.** Changelists with more than a thousand files are common (one ManaBreak
   changelist had 1,287). File lists, digests and facts stay in the engine; the host receives, per
   changelist, only its counts: text packages, localization files, code files with text, and files
   without a fact yet.
6. **Two tiers, one record.** A local fact cache under the app data folder, and a shared store in
   the Tools Perforce Worker. Both hold the same records with the same key, so the shared store is
   only a cache everyone fills; nothing depends on it being there.
7. **Signed-in Electroswag publishes, and the Worker checks.** A fact is accepted only when its
   (path, revision, MD5, size) is a revision the Worker has recorded for one of the caller's
   enabled scopes, as `publishActorMetadata` checks today; the payload fits its schema and bounds;
   and the producer version is one the Worker knows. The first accepted fact for a key stands; a
   different payload for the same key and producer version is rejected and recorded with the
   caller, so a faulty client shows up instead of overwriting. A signed-out Electroswag computes
   facts and keeps them locally only.
8. **Files: the project's own files, and revisions of them.** The workspace lists the project's
   localization files from its localization config (`Config/Localization/*.ini`: each target, its
   native culture and cultures): per target the manifest, then each culture's archive and `.po`.
   For a chosen file it lists the file's Perforce revisions (revision, changelist, date, author,
   description) and prints the one chosen into the revision cache Plan 060 built. The default
   pair is the workspace's file after, and its revision before the last change to it before.
9. **The rule that only dialog-chosen files are compared widens, server-side.** The workspace
   compares a file when it was chosen in the dialog, when the project's localization config names
   it, or when it is a revision of such a file that the workspace printed. A host still can't pass
   an arbitrary path.
10. **Spans and stage times**, as every heavy operation has: `changelist_facts.page` with
    `describe`, `digests`, `lookup_local`, `lookup_shared`, `produce` and `publish` stage times and
    counts; `localization_files.list` and `localization_files.revision` with their Perforce
    timings.

## Phases

### Phase 1: the project's own files in Compare › Files

- UE Shed workspace: `localizationFiles` (the project's targets and their files, from its
  localization config, each with whether it exists on disk), `localizationFileRevisions` (one
  file's revisions, newest first, paged) and `chooseLocalizationRevision` (prints a revision into
  the revision cache and returns it as a chosen file). `compareLocalizationFiles` accepts the three
  kinds of choice in decision 9.
- Electroswag: each slot gets **Project files** (target › culture › file) beside **Choose file…**;
  the Before slot gets **Earlier revision…** for the file in the After slot. Choosing a project file
  for After fills Before with its revision before the last change.
- Done when: on ProjectCoral-MP, French `Game.po` against its 21 October revision takes two clicks
  and gives the 5,515 changes measured for 1.11.0; the spans show the print time.

### Phase 2: changelists that touch text, first from what the project already knows

Producing exact facts costs a Perforce print per package not on disk at that revision, and a
cold page of 50 changelists can name thousands. Whether an asset holds text rarely changes
between its revisions, and the Project Index already has every package's header evidence for
the workspace's revision. So the filter's first answer needs no prints.

- UE Shed engine: `changelistTextCounts` for a page of changelists: one batched
  `p4 describe -s` (`-S` for shelves), each file mapped through the client view, and matched by
  path against the Project Index's header evidence, the localization extensions and the files
  Game Text's code layer found text in. A file the index doesn't have (deleted since, or added
  after the workspace's revision) counts as unknown, not as no text.
- Electroswag: **Only changes to text**, on by default, in Compare › Changelists. Rows show their
  counts ("3 text assets · 1 .po · 2 C++"); a changelist with only unknown files stays, marked so;
  a line at the end says how many were hidden. A shift-click range still compares everything
  between its ends.
- Done when: the newest 200 changelists of both projects filter correctly against a hand check of
  20 of them, including a delete, a shelf and a C++-only change; a page of 50 filters in under a
  second; the share of files that came back unknown is recorded, since it decides how much
  Phase 3 is worth.

### Phase 3: exact facts by content

- UE Shed engine: the fact model, the producer (decision 4), the local cache keyed as decision 1
  says, and digests with `p4 fstat -Ol`. A file's fact replaces its Phase 2 answer: unknown files
  get one, and an asset whose text came or went between revisions is counted right.
- Electroswag: rows show their Phase 2 counts at once and settle as facts arrive.
- Done when: the Phase 2 hand check passes with no unknown files, and the cold cost of a page is
  recorded with its print count and bytes.

### Phase 4: both projects in the Worker, and digests from it

The checks in decision 7 need the Worker to know each revision a fact names, so the two scopes'
revisions come before the shared store.

- Tools and Electroswag: compact inventories for ProjectCoral-MP and ManaBreak Research, kept
  current by Electroswag's `perforce sync`. Check first: `mbp-research` is `perforce sync`'s
  default scope with a 30-day window, no production scope had a compact inventory at activation
  (13 October), and ProjectCoral-MP may have no scope at all.
- UE Shed: read a page's file lists and digests from the Worker instead of `p4 describe` and
  `p4 fstat` when the scope covers them, and fall back to Perforce when it doesn't.
- Done when: a page that both cover gets its file lists, digests and facts from the Worker in one
  round trip each, and changelists older than the Worker's window still filter.

### Phase 5: the shared fact store in the Tools Perforce Worker

- Tools: an additive `file_facts` table keyed by (MD5, size, producer version), `publishFileFacts`
  with the checks in decision 7, and `fileFacts` for up to 500 keys. Through the existing
  authenticated `/api/perforce/compact` route, like actor metadata.
- UE Shed and Electroswag: look up the shared store between the local cache and production;
  publish what was produced when signed in.
- Done when: a second PC filters a page with no production at all; a forged fact (wrong digest, an
  unrecorded revision, an unknown producer version, a changed payload) is rejected and the
  conflict is recorded.

## STOP conditions

- A fact's meaning would change for the same producer version: stop and make a new version.
- The Worker would need to read raw `.uasset` bytes: it doesn't, by design. Stop and ask.
- A page needs file lists in TypeScript in bulk: stop; counts only cross.
- Phase 4's inventory work needs Perforce writes or a Tools schema change that isn't additive.

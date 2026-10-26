# Game Text rule engine: Phase 5 specification

Plan 059 Phase 5: a change re-evaluates only what it affects. A rescan after one package edit
should cost about as much as the edit, not as much as the project. Phase 4.5 made the cold scan
native; this phase removes the last per-package TypeScript loops from the scan and makes findings
incremental.

## 1. Scope

- **The writer plans the package refresh.** Selection, shard keys and change detection move out of
  TypeScript, which today pages every package header out of the Project Index to compute them.
- **The reader verifies bundles.** Workers check each package's files against its Catalog
  signature before and after decoding it, instead of TypeScript calling `stat` on every file.
- **Incremental findings.** After an incremental join, the engine re-evaluates the lines the join
  patched and the rows that share a group or a corpus count with them, and copies every other
  finding from the previous evaluation.
- **The fuzzer** proves that an incremental evaluation answers exactly as a full one, after every
  edit, on both join strategies.

Not in scope: the join's own fallback rules (an added or deleted package still rebuilds the join),
incremental localization import, and UI.

## 2. Before

Measured at `4b29f042` (main after Phase 4.5).

| Path                                                                  | Released project |  1× project |
| --------------------------------------------------------------------- | ---------------: | ----------: |
| Inventory: Project Index status and every header page into TypeScript |            3.4 s | — (records) |
| Bundle verification: `stat` of every selected package and sidecar     |            5.2 s |           0 |
| Full findings evaluation (rule preview)                               | 34.2 s (Phase 3) |      26.4 s |

The 1× evaluation, by stage: occurrence relation 0.3 s; subject columns 3.5 s (line 2.6 s, of
which children 1.2 s; line_culture 1.0 s); rule execution 14.6 s (line 5.5 s, line_culture 9.1 s);
diagnostics and emission 0.8 s; layer order and publish 4.9 s; about 2.6 s between stages.
Execution, emission and publish scale with the rows evaluated; the relations and columns scale
with the project unless they are built for a selection.

**A rescan after one package edit** (the `edit` stage, 1× project, three runs): 35.3 s (35.2–36.0).
The findings evaluation is 30.7 s of it (publishing the layer 4.1–4.4 s), the localization import
1.3–1.6 s, opening the index 1.0 s, the package refresh 0.7–1.0 s (selection 0.3–0.4 s) and the
join 0.5–0.6 s. The rescan moves 1.19 MB between the host and the native processes, most of it the
writer's root manifest, returned by each of its four commands (0.93 MB).

## 3. What crosses into TypeScript

Every stage reports the records and bytes it moves between a native process and TypeScript as
span attributes (`boundary.records`, `boundary.bytes`, both directions). Step 1 records the table
below on both projects; each later step states which rows it removes.

| Stage                  | Before                                                                            | As built                                                     |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Inventory              | Every package's path, signature and header data (167,401 on the released project) | The Catalog generation in, one summary per changed shard out |
| Staging request        | Every expected entry of every changed shard                                       | A plan file path and the changed shard numbers               |
| Bundle verification    | Every selected package's bundle paths, `stat` from TypeScript                     | Nothing on a cold build; the changed packages on a warm one  |
| `changedFiles` refresh | Every stored package's path, signature and status                                 | Nothing                                                      |
| Findings evaluation    | Counts and rule metadata                                                          | Unchanged                                                    |

A warm refresh (at most 8 changed shards) reads the changed shards' entries from the plan file
and their packages through `read`, as before: those are the packages that changed.

## 4. The writer plans the package refresh

A new builder request, `plan_packages`, replaces the inventory paging, `packageTextSelection` and
the retained-eligibility read in `refreshPackageTextLayer` whenever the source knows its Catalog
(`GameTextIndexSource.catalog`) and the builder is native (`plansPackages`).

- **Request:** the Catalog cache root, project ID and generation (from `ProjectIndex.status`), the
  package-text format, the audience-policy JSON (the string TypeScript hashes:
  `JSON.stringify([TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY])`), optional
  `changedFiles`, and the plan file to write.
- **Who runs it:** the builder session lives in `uasset.exe`, and its protocol adapter takes the
  request before it reaches the writer: the reader pages the Catalog generation
  (`package_text_inventory`) and selects each package with `gathered(header)`, the port of
  `isPackageTextCandidate` (`REQUIRES_LOCALIZATION_GATHER` set, or a gatherable text count and
  offset both above zero). The writer's `plan()` (`package_text_plan.rs`) then:
    - with `changedFiles`, keeps a package that isn't named at its stored signature and
      eligibility, read from the active package-text layers in its own store;
    - shards each path (FNV-1a over UTF-16 code units, modulo 256) and keys each shard as
      TypeScript does: SHA-256 over the format and policy, then the JavaScript JSON of
      `[path, signature, selected]` per entry in path order;
    - compares each key with the manifest's active key and writes each changed shard's entries to
      the plan file, one NDJSON line per shard.
- **Response:** per changed shard its number, key, entry count and selected count; the removed
  shard names; the package total and shard 0's key. No paths.
- **Then:** a cold build asks the reader to stage the changed shards by number from the plan file
  (`planFile`, `groups`; no paths). A warm refresh reads the changed shards' entries from the file.
- **Identity:** every shard key equals TypeScript's for the same inventory, so existing caches stay
  valid. `package-text-plan.integration.test.ts` publishes the fixture project both ways and
  compares every shard key and record, then a `changedFiles` refresh naming unchanged files and an
  unchanged refresh.
- **Kept:** the TypeScript inventory, selection and verification remain for the TypeScript builder
  and for a source without a Catalog (records replay, tests).

## 5. The reader verifies bundles

- When it stages from a plan file, the reader computes each package's bundle signature (the
  package and its `.uexp`, `.ubulk`, `.uptnl` files: size and modification time, or null when
  missing) and compares it with the plan's signature before it decodes the package and again
  after.
- A difference fails the scan ("Package or sidecar changed while reading"), naming the package.
  Cancellation and the byte budget are unchanged.
- The TypeScript `verify` remains only around `read` (a warm refresh's changed packages) and the
  path-list staging the TypeScript builder uses.

## 6. Which lines changed

The joined layer already records them. An incremental join publishes an overlay over a kept base
(`join_incremental.rs`): `patch.rows` lists every line row it rewrote, the edited lines and the
lines that depend on them, cumulatively since the base. Any change it can't express as such a
patch (a package added or removed, a changed identity, structure or policy input, more than 8,192
rows) rebuilds the join, which gives it a new base and may renumber rows.

- **Changed lines `D`**, when the joined base is the one the previous evaluation saw: that
  evaluation's patch rows together with the current ones. Every other line holds the same values
  in both views.
- **A new base** means a full evaluation.
- **Join membership.** A line's `joinPosition` is its rank among the joined lines, so hiding one
  line shifts the positions of every later line without patching them. When any rule reads
  `joinPosition`, the state records each line's membership (`state.join`), and a line in `D` whose
  membership changed gives a full evaluation. This is stricter than the rule's actual use needs;
  no built-in rule reads it today.

## 7. The findings state

The findings layer keeps what the next incremental evaluation needs, as `state.*` sections and
metadata (`LayerState`) that no findings reader opens:

- **The joined base key, the line count and the patch rows** at evaluation time
  (`state.patch_rows`).
- **Cross-row nodes:** each node that reads other rows (`groupCount`, `groupRank`, `groupTake`,
  `groupTally`, `existsOther`, `corpusCount`) keeps, per subject row, its groups
  (`state.<subject>.n<node>.rows`, with `starts` when a row can fall in several, as a site-keyed
  `existsOther` does) and per group a 64-bit hash of its key text (`h0`, `h1`). `corpusCount` also
  keeps its table: each key's hash and count (`t0`, `t1`, `tc`).
- **Facts for merging:** each finding's `actual` text (`f.actual.ends`, `f.actual.bytes`) and each
  diagnostic's origin (`diag.origin`: the culture projection, a line rule, or a culture rule), so
  a line's diagnostics can be spliced by origin.
- The layer format version is 6, so existing layers are evaluated again in full once.

## 8. Incremental evaluation

`findings_evaluate` takes the incremental path when the previous findings layer of the same
document, evaluator version, locale and collation has state for the current joined base, and is
otherwise full. `UE_SHED_GAME_TEXT_FULL_EVALUATION` forces a full one.

1. **Keys of the changed rows.** For each subject, when the cross-row keys read only their own row
   (no aggregate inside a key), keys are evaluated for the rows of `D` and the rest are copied from
   the state; otherwise every row's key is evaluated. `corpusCount`'s table is rebuilt from every
   occurrence.

   A full evaluation doesn't read keys first: `groupCount`, `groupRank`, `groupTake`,
   `groupTally` and `corpusCount` record the groups they form over every row as the rules run, and
   after the rules the remaining nodes are read as above: `existsOther`, whose own pass drops the
   rows a `differing` value fails on, and any node no rule read over every row. In tests, every
   full evaluation checks the recorded groups against the ones read first.
2. **Closure `S`, per subject.** Start from the rows of the lines in `D`. A group is affected when
   one of those rows was or is in it. Every row whose old or new group is affected joins `S`, and
   so does every row whose `corpusCount` key has a changed count. For `line_culture`, `S` then
   grows to every culture row of each line it touches. Repeat until `S` stops growing. A hash
   collision can only add rows. An unchanged line whose cultures changed evaluates the subject in
   full.
3. **Evaluate `S`.** Every rule's scope is narrowed to `S`, and so are the group aggregates: a
   group in `S` holds all its members, so its counts, ranks and tallies are exact. The
   culture-diagnostic projection runs over `S` too. `unit_source` rules and role totals are
   evaluated in full.
4. **Merge.** A rule's findings for rows outside `S` are the previous layer's, with a
   `line_culture` row renumbered through its line and culture; findings of rows in `S` are new.
   Diagnostics are sorted by line and origin, kept for lines outside `S`. Counts and the layer's
   orders are recomputed from the merged facts.
5. **Fallback.** When `S` holds more than a quarter of a subject's rows, the subject is evaluated in
   full. `UE_SHED_GAME_TEXT_UNLIMITED_CLOSURE` lifts the limit, so the fuzzer's small corpora
   exercise the incremental path.

**The gate:** an incremental evaluation answers exactly as a full one. Every finding (row,
culture, evidence, places, both ID lanes, order), every diagnostic and every count is equal.

## 9. Publishing

An incremental evaluation publishes a complete findings layer from the merged columns: kept
findings re-intern their evidence and place sets through one shared map, so only new evidence is
added. If publication still dominates an incremental evaluation once measured, the next step is an
overlay over the previous layer, as the joined layer has.

## 10. Spans and profiles

- `PackageText.plan`: packages, changed and removed shards; `PackageText.planEntries` for a warm
  refresh's plan file read.
- `findings_evaluate` stages: `layer.previous` (opening the previous layer and computing `D`),
  `<subject>.closure` with `.groups` and `.select`, and `layer.merge` (kept findings). A subject
  with a `closure` stage was evaluated incrementally; its rows are `S`.
- Boundary records and bytes on every stage that crosses into TypeScript (§3).

## 11. Order of work, one commit per step at least

1. **Before.** Add an `edit` stage to `scripts/benchmark-game-text-engine.ts` on the 1× project's
   records: build, evaluate the rules, change one retained record's source text, rescan with that
   package as `changedFiles`, evaluate again. Record each part (package refresh, join, findings).
   Add the boundary counters. Measure at `4b29f042` and record the §2 and §3 tables.
2. **The writer plans the package refresh** (§4), with the differential test; delete the
   TypeScript selection.
3. **The reader verifies bundles** (§5).
4. **Measure** the cold build on both projects against step 1.
5. **The findings state** (§7), published by every evaluation.
6. **Incremental evaluation** (§6, §8) with merge and fallback, publishing complete layers (§9).
7. **The fuzzer** (§12).
8. **Measure** the edit stage and a full evaluation on both projects; record the results.

## 12. Tests and the fuzzer

- **Engine tests:** every findings test that evaluates rules also runs an incremental evaluation
  from an earlier state and compares the answers with the full one. Generated deltas cover a
  changed source, a changed translation, a line moving between groups, a group emptied, a
  `corpusCount` key whose count crosses a rule's threshold, an added and a removed line, and
  renumbered rows.
- **The corpus fuzzer** evaluates the rules after every rescan both ways and compares them, and
  records the join strategy. Its edit set gains a round with only in-place source edits, so the
  incremental join and incremental findings are exercised; the existing round with an added and a
  deleted package covers a rebuilt join.
- The canonical corpora, the 20 exported files and the corpus fixture stay exact.

## 13. STOP conditions

- An incremental evaluation that answers differently from a full one, at any seed.
- A shard key or selection that differs from TypeScript's for the same inventory.
- A change to finding identity.
- A regression of the cold build or of a full evaluation on either project.

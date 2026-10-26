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

| Stage                  | Today                                                                             | After this phase                       |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| Inventory              | Every package's path, signature and header data (167,401 on the released project) | 256 shard summaries                    |
| Staging request        | Every expected entry of every changed shard                                       | Shard numbers and a Catalog generation |
| Bundle verification    | Every selected package's bundle paths, `stat` from TypeScript                     | Nothing                                |
| `changedFiles` refresh | Every stored package's path, signature and status                                 | Nothing                                |
| Findings evaluation    | Counts and rule metadata                                                          | Unchanged                              |

## 4. The writer plans the package refresh

A new writer-session operation, `package_text_plan`, replaces `GameTextIndexSource.inventory`,
`packageTextSelection` and the retained-eligibility path in `refreshPackageTextLayer`.

- **Request:** the Catalog path and generation (from `ProjectIndex.status`), the package-text
  format, the audience-policy prefix (the exact string TypeScript hashes today: the format, then
  `JSON.stringify([TEXT_AUDIENCE_MATCHER_VERSION, TEXT_AUDIENCE_POLICY])`), and optional
  `changedFiles`.
- **Work, in the writer:**
    - Read the Catalog generation's inventory and header records directly. The writer session
      runs in `uasset.exe`, so the operation lives in `uasset-io`, which owns the Catalog format
      and links the store.
    - Select each package with `isPackageTextCandidate`, ported rule for rule:
      `REQUIRES_LOCALIZATION_GATHER` set, or a gatherable text count and offset both above zero.
    - With `changedFiles`, a package not named keeps its stored signature and eligibility, read
      from the active package-text layers in the writer's own store, exactly as
      `package-text-layer.ts:216-282` does today.
    - Shard each path with `packageTextShard` (FNV-1a over UTF-16 code units, modulo 256) and key
      each shard as today: SHA-256 over the prefix, then `JSON.stringify([path, signature,
selected])` per entry in path byte order. The JSON is JavaScript's (`identity.rs`
      `javascript_json`).
    - Compare each key with the manifest's active key.
- **Response:** per shard: number, key, entry count, selected count and whether it changed; plus
  the removed shard names. No paths.
- **Then:** TypeScript asks the reader to stage the changed shards by number and Catalog
  generation. The reader rebuilds each shard's expected entries from the same Catalog generation
  (the same selection code in `uasset-io`), so the request carries no package lists. The incremental path (at most 8 changed shards, `replacePackageTextRecords`) asks the
  reader for its shards the same way.
- **Identity:** every shard key equals today's for the same inventory, so an existing cache stays
  valid. A differential test compares the native keys and selections with the TypeScript code on
  the fixture projects, generated edge cases (unicode, reserved scalars, empty and all-excluded
  shards) and both canonical corpora, before the TypeScript code is deleted.
- **Records replay** (the 1× benchmark and tests) keeps explicit staged records as its input; it
  has no Catalog.
- **Deleted:** `GameTextIndexSource.inventory` and its page cache, `packageTextSelection`,
  `PackageTextSelectionBuilder`, the retained-eligibility read, and `isPackageTextCandidate` once
  nothing else calls it.

## 5. The reader verifies bundles

- A worker stats a package's bundle files (the paths `bundlePaths` lists: the package and its
  `.uexp`, `.ubulk`, `.uptnl` sidecars) and compares them with the package's Catalog signature
  before it decodes the package, and again after.
- A difference fails the scan with today's typed failure ("Package or sidecar changed while
  reading"), naming the package. Cancellation and the byte budget are unchanged.
- The comparison is today's: a missing file matches only a null entry; otherwise size and
  modification time (milliseconds, from nanoseconds) must both equal the signature's.
- **Deleted:** `GameTextIndexSource.verify` and its calls around `read` and `stage`.

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
  line shifts the positions of every later line without patching them. The built-in rules read
  positions only to order a group and to test membership, which a shift doesn't change; a rule
  that reads `joinPosition` anywhere else gets a full evaluation whenever a line in `D` changed
  membership.

## 7. The findings state

The findings layer keeps what the next incremental evaluation needs, as `state.*` sections and
metadata that no findings reader opens:

- **The joined base key and its patch rows** at evaluation time.
- **Cross-row nodes:** each node that reads other rows (`groupCount`, `groupRank`, `groupTake`,
  `groupTally`, `existsOther`, `corpusCount`) keeps, per subject row, the group it fell in: a
  dense group number, or none for a row outside `among`, a null key or a failed input, and per
  group a 64-bit hash of the group's key text (`Evaluator::key`). `corpusCount` also keeps its
  table: each key's hash and count.
- **Facts for merging:** each finding's `actual` text (`f.actual`), the one order input the layer
  didn't store, and each diagnostic's origin (`diag.origin`: the culture projection, a line rule,
  or a culture rule), so a line's diagnostics can be spliced by origin.
- The layer format version rises, so existing layers are evaluated again in full once.

## 8. Incremental evaluation

`findings_evaluate` takes the incremental path when the previous findings layer of the same
document, evaluator version and locale has state for the current joined base, and is otherwise
full.

1. **Keys first.** For each subject, before any rule runs, every cross-row node's key is evaluated
   over every row, as the aggregates already do, and grouped. `corpusCount`'s table is rebuilt
   from every occurrence.
2. **Closure `S`, per subject.** Start from the rows of the lines in `D`. A group is affected when
   one of those rows was or is in it, or when any row's group changed between the state and now
   (which covers a row whose `among` changed through another aggregate). Every row whose old or
   new group is affected joins `S`, and so does every row whose `corpusCount` key has a changed
   count. For `line_culture`, `S` then grows to every culture row of each line it touches, so a
   line's culture diagnostics are recomputed together. Repeat until `S` stops growing. A hash
   collision can only add rows.
3. **Evaluate `S`.** Every rule's scope is narrowed to `S`; aggregates still see every row. The
   culture-diagnostic projection runs over `S` too. `unit_source` rules and role totals are
   evaluated in full, as today.
4. **Merge.** A rule's findings for rows outside `S` are the previous layer's, with a
   `line_culture` row renumbered through its line and culture; findings of rows in `S` are new.
   Diagnostics are spliced per line and origin. Counts and the layer's orders are recomputed from
   the merged facts.
5. **Fallback.** When `S` holds more than a quarter of a subject's rows, that evaluation is full.

**The gate:** an incremental evaluation answers exactly as a full one. Every finding (row,
culture, evidence, places, both ID lanes, order), every diagnostic and every count is equal.

## 9. Publishing

An incremental evaluation publishes a complete findings layer from the merged columns: the old
findings keep their evidence string IDs and their place sets are re-interned, so only new evidence
is interned. If publication still dominates an incremental evaluation once measured, the next step
is an overlay over the previous layer, as the joined layer has.

## 10. Spans and profiles

- `package_text_plan`: Catalog read, selection, keys, comparison; packages, shards, changed
  shards.
- Reader verification: files checked, wall and busy inside the extraction profile.
- `findings_evaluate` gains the stages `incremental.changed`, `<subject>.closure` and
  `incremental.merge`, with the changed lines (`D`), the rows evaluated (`S`) and total per
  subject, the strategy (`full`, `incremental`) and the reason for a full one.
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

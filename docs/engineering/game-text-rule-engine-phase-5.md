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
- **Incremental findings.** After any change to the joined layer, the engine re-evaluates the rows
  whose data changed and the rows that share a group or a corpus count with them, and copies every
  other finding from the previous evaluation.
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

The cost of a rescan after one package edit is measured in step 1 (§11), before any change.

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

## 6. Line fingerprints

The joined layer gains `line.fingerprint`, two `u64` columns (`line.fingerprint.0`,
`line.fingerprint.1`): a 128-bit hash, per line row, of everything any rule subject can read for
that line.

- **Covered:** every line field, every culture field of the line's culture rows, and every field of
  the line's occurrences in relation order, including the places and copies a finding's
  `affected` can name. A field is hashed by its stored value (string bytes, not string IDs, so a
  dictionary change doesn't change the fingerprint), with a field tag and a length before each
  value.
- **Computed** in the join, in parallel over lines, and patched by `join_incremental` for every row
  it rewrites, like any other patched field.
- **Line identity:** `line.id_hash`, a 128-bit hash of the line ID (`query.line.id_utf8`), also in
  the joined layer, so rows can be matched across a full rebuild without loading the IDs.
- The fingerprint is a change detector, not an identity: a full evaluation never reads it.

## 7. The findings state

Every evaluation, full or incremental, publishes a global `findings-state` layer next to the
findings layer, keyed by the findings key. It holds what an incremental evaluation needs from the
previous one:

- **Rows:** per line row, its `line.id_hash` and `line.fingerprint` at evaluation time.
- **Cross-row nodes:** for each node of the program that reads other rows (`groupCount`,
  `groupRank`, `groupTake`, `groupTally`, `existsOther`, `corpusCount`), per subject row:
    - a 64-bit hash of the node's key for that row (`by`, or `key` for `corpusCount`), with a
      reserved value for a null key or a row outside `among`;
    - for `corpusCount`, the table: key hash to count.
- **Document:** the canonical document hash and evaluator version. A different document or version
  means no usable state, and the evaluation is full.

The state is evaluator data, not findings: no reader of findings opens it.

## 8. Incremental evaluation

`findings_evaluate` takes the incremental path when a `findings-state` exists for the same
document and evaluator version, and is otherwise full. Every step records a stage (§10).

1. **Changed lines `D`.** Match current rows to state rows by `line.id_hash`. A current row is in
   `D` when it has no state row or its fingerprint differs. A state row with no current row is
   removed. Rows are _stable_ when every matched row keeps its row number and no row was added or
   removed.
2. **Cross-row closure `S`.** Start with `S = D`. For each cross-row node in topological order:
    - **Group nodes:** evaluate the node's key (`by`, `among`) for the rows in `S` only. The
      affected keys are those rows' state key hashes and their new ones. Add every row whose state
      key hash is affected. Hash collisions only add rows.
    - **`corpusCount`:** rebuild the table from every occurrence (it is built from the full
      occurrence relation today, 0.3 s on 1×) and compare it with the state's table. Add every row
      whose state key hash has a changed count, and the rows of `S` whose new key's count changed.
    - Repeat the pass over all cross-row nodes until `S` stops growing, because a node's key can
      read another node's result.
3. **Evaluate `S`.** Build the subject relations and columns for the rows of `S` only (line rows
   and their culture and occurrence rows) and run the program over them, as today. A group
   aggregate sees every member of its group, because the closure put every member of every
   affected group in `S`. `corpusCount` reads the table from step 2. Role totals are recomputed
   over every unit, as today. A `unit_source` row is evaluated when any of its lines, old or new,
   is in `S`; the state records each unit's line rows for that.
4. **Merge.** Every finding and diagnostic of a row outside `S` is the previous evaluation's, with
   its row renumbered through the identity match when rows aren't stable; every finding of a row in
   `S` is the new evaluation's. Order is rule, then row, then element, as today. Counts are
   recomputed from the merged findings.
5. **Fallback.** When `S` holds more than a quarter of the rows, evaluate in full instead: past
   that point an incremental evaluation costs more than a full one.

**The gate:** an incremental evaluation answers exactly as a full one. Every finding (row,
culture, evidence, places, both ID lanes, order), every diagnostic and every count is equal. The
layers' bytes may differ only where string IDs are assigned in emission order.

## 9. Publishing incremental findings

- **Stable rows:** publish a findings overlay over the previous findings layer, as the joined
  layer does: `findings-base` stays active, and the new layer holds `patch.rows` (the rows of `S`)
  and, per rule, the findings of those rows. A reader applies the overlay when it opens the layer,
  so findings queries, reads, sinks and counts see one merged layer.
- **Renumbered rows** (after a full join rebuild), an overlay over 8,192 rows, or a fallback:
  publish a complete findings layer from the merged findings, and drop the base.
- The overlay is cumulative against its base, like the joined overlay: each incremental evaluation
  replaces it with the union of the previous patch and the new `S`.

## 10. Spans and profiles

- `package_text_plan`: Catalog read, selection, keys, comparison; packages, shards, changed
  shards.
- Reader verification: files checked, wall and busy inside the extraction profile.
- `findings_evaluate` gains the stages `incremental.match`, `incremental.closure`,
  `incremental.columns`, `incremental.execute`, `incremental.merge` and `incremental.publish`, with
  `rows.changed` (`D`), `rows.evaluated` (`S`), `rows.total`, the strategy (`full`,
  `incremental`, `fallback`) and the fallback reason.
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
5. **Line fingerprints and identity hashes** (§6) in the join and the incremental join.
6. **The findings state** (§7), published by every evaluation.
7. **Incremental evaluation** (§8) with merge and fallback, publishing complete layers.
8. **The findings overlay** (§9) and the readers that apply it.
9. **The fuzzer** (§12).
10. **Measure** the edit stage and a full evaluation on both projects; record the results.

## 12. Tests and the fuzzer

- **Engine tests:** every findings test that evaluates rules also runs an incremental evaluation
  from an earlier state and compares the answers with the full one. Generated deltas cover a
  changed source, a changed translation, a line moving between groups, a group emptied, a
  `corpusCount` key whose count crosses a rule's threshold, an added and a removed line, and
  renumbered rows.
- **The corpus fuzzer** evaluates the rules after every rescan both ways and compares them, and
  records the join strategy. Its edit set gains a round with only in-place source edits, so the
  incremental join and the findings overlay are exercised; the existing round with an added and a
  deleted package covers renumbered rows.
- The canonical corpora, the 20 exported files and the corpus fixture stay exact.

## 13. STOP conditions

- An incremental evaluation that answers differently from a full one, at any seed.
- A shard key or selection that differs from TypeScript's for the same inventory.
- A change to finding identity.
- A regression of the cold build or of a full evaluation on either project.

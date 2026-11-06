# Native Game Text engine

Rust owns the Game Text index: dictionaries, immutable storage, joins, incremental updates,
compaction, search predicates, facets, grouping, counts, pagination, focus and bulk exports.
It is a domain-specific embedded data engine. TypeScript owns host composition, extraction and
localization input producers, configurable quality policy, typed process calls and presentation.

CLI, Workbench and library hosts compose `GameTextIndexBuilderLive` from
`@ue-shed/game-text/index` with their existing `AssetReader`, source and localization evidence
layers. `nativeIndexBuilderLayer(configuration)` supplies the same builder and query capability
with explicit reader configuration. Package delta publication needs uasset-io protocol 1.16 and
`game_text_index`. Queries run in the engine's own binary session, `uasset game-text-engine`, whose
handshake checks the engine's contract once per process. One engine process per host holds every
open snapshot's reader. Its requests run concurrently: keystroke reads on two threads of their own,
bulk work (opens, evaluations, exports) two at a time on the shared pool, and an interrupted read is
cancelled in the engine. Native failures remain typed failures with recovery guidance.

## Reads and writes

Preparation is explicit. `refreshProject`, `importTarget` and `buildTarget` publish derived state;
`openTarget` acquires an immutable native snapshot. Search does not discover packages, build a
join or construct a JavaScript query model. Source and localization requests use the same native
reader. The TypeScript in-memory and columnar implementations are independent test oracles,
excluded from production package output and public entry points.

All `model.query` operations return Effects. `model.summary` reads checked counters persisted by Rust
with the joined revision. Interactive callers use bounded search and focus; `model.corpus` and
`model.localizationJoin` are explicit asynchronous bulk reads. The full corpus retains blank
source units as provenance; filtered exports retain their visibility rules. CSV formatting
consumes native review signals rather than constructing another query engine.

`model.localizationJoin` contains the visible lines used by policy/report views.
`query.readLocalizationLines` explicitly exports every joined line, including blank sources.

`query.localizationDetail` selects a line or unit and pages locations, cultures and PO context
in Rust. Ordinary text focus carries a compact localization preview. `localizationFocus` and
`localizationLines` explicitly export complete provenance through scoped files; interactive
handlers do not hydrate a full line and slice it in JavaScript.

Opening a native query reader loads its persisted folded source arena and resolves sources added
by an incremental overlay once. This work is reported as `source_search_prepare` in native stage
timings and belongs to opening, before the host presents a ready model. Numeric query columns are
also prepared during opening, reported as `query_projection_prepare`. It does not discover
packages or publish an index. Distinct search terms scan unique source entries with prepared
substring matchers, then use numeric source matches to reject rows before expensive eligibility
checks. Source-only rejection is disabled when the request also searches translations. Lone UTF-16
units retain code-unit substring semantics, including matches inside a supplementary scalar.
Localization totals visit set reason bits and scan one culture's columns at a time. Cache misses
still scan source bytes and matching rows; these changes do not introduce a persisted substring
index or turn first-use search into an indexed lookup.

Opening also hashes the packed line and unit IDs and maps each unit to its last line in display
order, reported as `id_index_prepare` (about 1 ms per 35,000 IDs, 62 ms per million). Focus,
cursors, `lines` selections, localization focus and line details then find a row with one probe
instead of scanning the ID arena, and focus without a localization selection no longer visits
every line. The index borrows the reader's arenas: four bytes per slot, two slots per ID.

The `id_index_prepare` total includes six finer timings: `id_index_raw_load` and
`id_index_line_load` read, decode and validate the persisted `id_starts` / `id_utf8` arenas;
`id_index_raw_build` and `id_index_line_build` construct and cache their hash tables.
`id_index_unit_lines_load` acquires the projection and slice-to-unit column and validates their
lengths; `id_index_unit_lines_build` allocates, fills and caches the unit-to-line vector.
These are elapsed costs at that point in opening: `raw.visible` is already cached by
`query_projection_prepare`, and `line.source` by `source_search_prepare`. The projection,
including line order/ranges, and the slice-to-unit column are also already cached by
`query_projection_prepare`, so acquiring them usually costs very little. The finer timings
are parts of `id_index_prepare`, not additional preparation time.

Exact-source predicates (`source` clauses, `group: "source"`, a source `openGroup`) look each
value up once per request in the sorted dictionary segments, one fence index read per segment and
one block decoded per probe, and then compare string IDs per row; they never compare source
bytes per row. A text no row holds matches nothing. Source groups are keyed by dictionary ID and
decode their texts once, after `minGroupSize` drops small groups, to read and tie-break by the
text. `finding` clauses take all seven stored review signals.

Asset type clauses and the `assetTypes` facet read the package shards' `package.asset_class`
column, not a joined column: the first request that needs them maps each global occurrence to its
package's type once per reader, deduplicating class names that sit in several dictionary segments.
A row has the types of its members; a line those of its visible slices. Because the column lives in
the package shards, a new type needs no join format change, and a re-read package changes its
type through the ordinary package delta.

## Library reads

The index answers the questions hosts used to export the corpus or the join for. Each takes a
query `selection` beside its own fields, runs as a bulk request and streams its rows as column
batches.

- `aggregate` groups every matching row by one to four stored dimensions and returns every group,
  in each dimension's own order: `culture`, the culture-mark dimensions `state`, `fact`,
  `unknown_reason`, `review` (lenses), `review_status` and `review_flag` (which need `culture`
  before them), and `translation_key`, `source`, `namespace`, `audience`, `origin`, `problem`,
  `finding`, `asset` and `gathered`. A row counts once under each value of a multi-valued
  dimension and not at all when it has none. Measures are `lines`, whitespace `sourceWords` (as in
  state counts) and `lineBreakWords`, Unreal's word count (`unicode-line-break-v1`) of the text
  Unreal gathers for the line: its first required manifest entry's source, else its saved source.
  Text in Thai, Lao, Khmer or Myanmar has no such count and is counted in `unknownWords`. The
  count is a Rust port of the `linebreak` package `localizationWordCount` uses, with class tables
  generated from it by `scripts/generate-line-break-tables.ts`; it matched the package on every
  code point in three contexts and 400,000 random strings. Counts are cached per text per reader.
- `localization_export` with `fields` writes each matching line with only the named fields: any
  `LocalizationLine` field, `marks` (cultures without archive and PO entries, with the translation
  that ships), `problems` (in the request's cultures), `signals` and `places` (the package file,
  object path and origin of each saved place of the line's unit slices). A file export or a gate
  names what it shows instead of reading whole lines and the corpus.
- `corpus_header` writes the corpus without units: status, coverage, package coverage and
  diagnostics. `export` with `units` writes the named units (up to 5,000).
- `corpus_fingerprint` hashes the whole corpus as `sha256-canonical-json-utf8-v1`, the corpus
  generation a localization baseline records. Rust writes the corpus's schema fields with sorted
  keys and JavaScript string escapes straight into the digest, so the value equals the one
  `createLocalizationBaseline` computes from an exported corpus and stays a pure function of the
  corpus content: equal corpora fingerprint equally on every machine and cache. A cache
  generation or revision would not: it changes with the cache and the machine. A reader computes it
  once and keeps it, since its snapshot never changes.

A model's `revision` names the opened model and its pinned snapshot, unique within the process.
Hosts compare it to tell whether the model changed; the lazy `corpus` read is no identity token.
`queryRevision` remains the content identity of a validated target.

## Queries

A `query` request names a `selection` and the `parts` of the answer it wants. The selection is a
target (its lines are the rows; corpus units without one), a culture and culture scope, a findings
layer, text, and a `where` in the rule IR's grammar. `game-text/src/native-query-ir.ts` builds it
from a search request: each filter pill, the localization lens and the location scope becomes a
conjunct, and the capability, translator-notes and location filters one `anyPlace` test, since
they must hold on one saved place together. Facet marks (`{ "facet": [name, expr] }`) name what a
conjunct constrains, and counting a facet, or a counts tab, drops its marks. The engine
(`engine_where.rs`) compiles the shapes Browse writes to the kernels its clauses ran, caches each
top-level conjunct's row set, and refuses any other expression by name.

The parts are `rows` (after a cursor, optionally one group's), `openGroups` (each group's first
rows), `counts`, `facets`, `groups` and `fileScope`. The answer's part is a `QueryAnswer`; rows
travel as `browseUnit` and `browseLine` batches, open groups' rows with their group's position as
`parent`. A query listing more than 500 rows runs as a bulk request.

A `line` request reads one selected row, a line or a unit, with the sections a host shows:
`places` (the unit's places after a cursor), `detail` (translations, locations and problems),
`related` (same key, same text, conflict, key change and, when asked, similar keys) and `line`
(the whole line as a `lines` batch). Selecting a row is one request whatever it shows.

`related`'s `similarKeys` section (`engine_similar.rs`) is a fourth key-change tier after the
join's exact ones, answered only by `related`: it never changes the join, its `key_changed` marks
or their counts. Earlier lines are visible `not_found` lines without saved places; new lines are
visible `not_gathered` lines with saved places and an identity; lines the exact tiers paired and
lines with blank or trivial text (fewer than two letters outside `{...}` and `<...>` spans) are
left out. Texts are compared with whitespace collapsed, trimmed and lowercased, by Levenshtein
distance over UTF-16 code units within `min(12, max(1, floor(longer length × 0.2)))`. Each new
line, in line ID order, compares the earlier lines sharing one of its package files (the join's
`facet.files`: a saved line's packages, an earlier line's manifest files) and, only when none is
near enough, the earlier lines whose length is within `min(12, max(1, ceil(length × 0.25)))`; once
more than 2,000,000 comparisons were made, no further new line runs that cross-package pass and the
answer is `truncated`. A new line proposes its single nearest earlier line, and an earlier line
accepts its single nearest proposal, so a tie pairs neither. The answer names the selected line's
side, its pair with the earlier line's carried translations, and its near lines ranked by
distance, same-package first, then line ID. The ratios, the cap, the budget and the letter minimum
are optional request fields. A reader builds the index for the whole target on the first request
that asks for it and keeps one parameter set; other parameters build it again.

A `review_lines` request reads, for one culture, up to 2,560 lines by identity in request order:
each line's manifest source, the translation the next sync ships, its PO entry with the line's own
key, and the review fingerprint the join compares stored reviews with (`review_fingerprint` in
`join_marks.rs`). A line the target lacks, one without a manifest entry, or a culture the target
lacks answers `not_gathered`. Hosts stamp reviews and check staged edits with it, so neither decodes
a localization file; `reviewLines` sends larger batches in parts.

### Generations and what changed since one

A target's `generation` is its joined key: a digest of the store's dictionary epoch, the project
root, every input layer's key (package-text shards, localization files by content key, the code
layer), the target and its policy, the review file, key-change pairs and file evidence
(`join.rs`). It changes whenever something the target shows changes, stays equal across refreshes
that change nothing, and is safe to persist and compare across processes. The store's own
`generation` is not a change counter: it is the dictionary epoch, renewed only when the store is
created again or compacted (`store.rs`), so a package publish or localization import keeps it.
Host types call that epoch `storeEpoch`; a refresh result, a target index, the workspace's
completed refresh and a selected target report the target's `generation`.

A `changed_since` request (`engine_changes.rs`) answers what changed in the open reader's target
since an earlier generation: its `lines`, by line ID, or its `packages`, by path. Earlier joined
layers and their inputs stay in the store until compaction, and layers of one dictionary epoch
share string IDs, so the engine opens the earlier joined layer read-only by key (its inputs need
only be listed, not active) and compares columns without materialising strings:

- Lines are matched by line ID. A line changed when its namespace, key, source, facts, flags,
  files, units (by unit ID), saved places, key-change pair, or a culture's state, review or
  translation (archive and PO text) differs. A place is identified as the focus query identifies an
  occurrence (package path, object, location kind, and the row and property that kind names), by
  string ID, so an occurrence moved to another object of the same package, or one added to or
  removed from an existing unit, changes the line. A change of the target's cultures changes every
  line.
- Packages come from the package-text shards whose keys differ between the two joins' dependencies:
  their `package.path` and `package.signature` columns, so packages without text count too.

The answer is `same` when `since` is the current generation, `too_old` with a reason when it can't
be diffed (`compacted`: the layer or an input is gone, or a compaction renumbered its strings;
`format`: another joined format; `unknown`: not a generation of this target), or `changes`: every
change's counts and a page of items in ID order (WTF-8 bytes), whose last ID is the next page's
cursor. The engine never answers "everything is new"; that is the host's choice on `too_old`. A
reader keeps one diff per kind, only the changed items, so later pages are cheap. It runs as a bulk
request.

Each immutable native reader caches page-independent search metadata: counts, problems, groups,
facets, file scope and localization totals. Counts are also shared across requests that differ
only in grouping or requested facets. This reader-owned cache retains at most 64 entries and
8 MiB of serialized keys and values; oversized valid requests still execute without being cached.
Cached values never contain page rows or cursors, and cancellation is checked on cache hits.
The existing ordered-row cache includes grouped selections and counts its keys in its 32 MiB
budget. Both caches are discarded when the reader closes; a new snapshot or policy gets a new
reader, so cached aggregates cannot cross revisions.

Ungrouped pages slice the matching row IDs directly. Group membership is selected once and reused
within the same row-cache bounds. Cursor lookup uses display-order ranks and binary search,
including restarting at the first page when a valid cursor is outside the selected rows.
Each projection's rank vector is prepared lazily on its first cursor request and retains four
bytes per row. A first predicate, group or facet can still scan its input; subsequent pages do not
reconstruct the entire result list. Only the requested page is hydrated into authored values.

Models of the same validated configuration, dictionary generation, joined revision and audience
policy share a native reader while their scopes are live. The final pin closes the process;
unused readers are not retained. Native handles pin files
and dictionary segments, including sections not yet read, across later publications and
compaction. A query reader holds no writer lease. Canceling a caller skips its queued read or
stops waiting for an admitted read; that read and its temporary files remain owned by the model
until completion. Closing the model interrupts its active read. Losing a native process produces
a typed failure and invalidates the shared acquisition entry. Open a new model to recover;
already pinned models retain their original reader.

A native process answers one request at a time. Bulk reads (`readCorpus`, `export`,
`exportWithSignals`, `readLocalizationLines`, `localizationLines` and policy rows) therefore run
in a second process of the same model, which opens its own reader of the same snapshot on the
first bulk read; summary, search, focus, localization focus and detail stay in the first. Each
lane admits one read at a time, so a corpus dump never delays an interactive read. The second
reader repeats the opening preparation and holds its own projection, so a model that has run a
bulk read holds two. It closes with the model. If it cannot open (a newer snapshot was published
since the model opened, or the process does not start), bulk reads queue on the first process as
before, without invalidating the model. Hosts that call `openNativeTextQuery` directly opt in with
`bulkEngine`; without it, every read shares one process and one queue.
Retained models require `borrow` around operations and `retain` when publishing a candidate.

One write session owns one native process and writer lease. Existing TypeScript input producers
send prepared layers through a leased native adapter. Rust publishes dictionaries, input layers,
joins and compaction atomically. Changing the selected project remains exclusively the host's
responsibility.

`prepareTarget` coordinates localization import, package refresh and target publication under
one writer session. Individual steps still acquire their own session when called separately.
Source-only recovery releases the failed target session before acquiring its source session.

### What on disk differs from the index

A `disk_changes` builder request (`disk_changes.rs` in both crates) answers which saved packages,
and with a `target` which of its localization inputs, differ on disk from what the view's index
holds, without refreshing anything: the reader opens the store's committed root read-only, takes no
writer lease, and writes no Catalog, index or cache file. A host can show "N saved packages changed
since the last scan" from it instead of keeping its own snapshot of the tree.

- Without `paths`, the reader walks the project's `Content` with the Project Index's own walk
  (`scanner::enumerate_content`: the same root, package and sidecar rules and directory-listing
  metadata, so a Windows walk states no file), on at most 8 threads, checking cancellation per
  entry. Each package is grouped with its `.uexp`, `.ubulk` and `.uptnl` sidecars from the same
  listing and signed with the Catalog's `bundle_signature`, so its signature is the one the
  package-text shards hold. With `paths` (project-relative, at most 4,096), only those are stated
  with `fs::metadata`; a sidecar checks its package. A test proves both give the same signature.
- Packages are compared by path with the `package-text.*` shards the view's joined layer read (its
  `join.meta` dependencies, as `changed_since` takes them), a batch of shards' strings at a time:
  `added` on disk only, `removed` in the index only, `changed` when the signature differs. Shards a
  project-only refresh or another target's scan publishes are not the view's until it is joined
  again, so a difference stays reported until then.
- Each observed path is converted once to the dictionary's scalar view, as a scan interns it, and
  compared, ordered and paged as that view; the raw name is used only to stat the file and to pick
  its shard, which a scan picks from the raw name too. On the wire an item's path and the cursor are
  the file's own name, the same text `changed_since` sends for that package, so a name with a
  literal reserved scalar (U+F0000 to U+F0800) matches its indexed package.
- With `target`, the view must be that target's. Its manifest, archives and POs (the paths the join
  reads, `join::input_paths`) and its review file are stated and compared by size and modification
  time with what the join recorded (`fileProvenances`, and `reviewFile`, which the join records and
  keys like a provenance). A recorded file now missing is `removed`; a file on disk the join did not
  record is `added`, unless its import failed for another reason than its absence, when its size
  and time are unknown. Contents are never hashed, as the refresh's own stat check doesn't. Config
  changes that alter which files a target has are out of scope: the check reads the target as the
  join recorded it.
- The answer is `not_indexed` while the view has no joined layer, otherwise every count and a page
  of items in path order (WTF-8 bytes, as `changed_since` orders IDs), whose last path is the next
  page's cursor. A first page
  checks again; the session keeps that check's differences (only the changed paths), so its later
  pages read them.

`watchDiskChanges` (`packages/game-text/src/disk-changes.ts`) keeps a badge current: one full
check, then `Content` and the target's folders are watched recursively through the `DiskWatcher`
service (`fs.watch` in production). A folder that doesn't exist yet, such as the default review
folder `Config/UEShed/Localization` before the first review is saved, is watched from its nearest
existing ancestor below the project root, recursively, and an event under it counts as one for the
folder; when only the project root exists, the root is watched for its own entries and the watch
moves one level deeper as each folder appears. The root is never watched recursively, since it
holds `Content`. Every handle closes with the watching scope. A burst of events settles for 300 ms (a host option); named
packages, sidecars and localization files are then rechecked by path, and a folder-level or unnamed
event, a watcher error or a published scan runs one full walk. It holds only the set of differing
paths.

`scripts/benchmark-game-text-disk-changes.ts` generates a project of real files, indexes it with
their stated signatures and times the checks. On 707k packages (796k files, 8,633 folders, warm OS
cache, release reader, median of 3 fresh readers): a full walk takes 2.3 s (1.2 s walking, the rest
reading and comparing the shards) with a 224 MiB peak working set, whether nothing or 2,000
packages differ; 100 named paths take 0.29 s and 25 MiB. A host's own `readdir` plus `stat` in
batches of 64 took 13.6 s on the same tree.

## Incremental publication

Source-only updates preserve row membership, identities, structure and visibility. Authored text
and String Table references may share a gathered line. Variable source lists and conflict flags
are updated in Rust, including duplicate-source signals on unchanged rows outside the edited
package. Repeated patches flatten against one retained base. A stable PO translation can change
in the same publication. Structural changes and eligibility failures rebuild the derived join.

The native writer maintains a paged dependency graph using the checked native snapshot codec. Logical
sites retain package, object, property, row and location coordinates separately from text values
and reference targets. Indexed edges map occurrences to localization lines and query groups;
source-value indexes locate duplicate-source dependencies. String Table definitions and references
have separate edge kinds, including references whose definitions are absent. Text equality never
merges their identities. A definition edit follows its consumer edges without rereading consumers.
Point lookups read selected 16,384-value pages through an 8 MiB cache. Ordinary edits publish a
bounded source-value delta and reuse the immutable graph base.

Graph updates are matched to an exact dictionary generation and joined revision. Uncommitted
updates are discarded. Pages retain their section checksums; the atomic graph state has a checked
digest and validates scoped base filenames. The state commits before the immutable root is
published; an interrupted publication leaves a revision mismatch that requires reconstructing the
disposable graph. Each
target view owns its graph under the existing writer lease. Query readers continue to pin immutable
snapshots and do not depend on the mutable writer graph.

Text-value updates use indexed membership and source dependencies. Reference and identity changes
remain a separate structural path that rebuilds the projection and rewires the graph. The current
package delta producer reads package identity columns and sends only changed authored records.
Rust preserves unchanged global string IDs and splices numeric ranges into an immutable replacement
for the affected shard. This still reads and writes that shard's numeric columns; it is not a paged
column overlay. Localization publication reuses checked dictionary blocks and interns only changed
blocks. Joined revisions persist summary counters: full joins calculate them once, while eligible
incremental joins subtract and add the affected rows, including duplicate-source dependents.

Short and long sources use the same incremental path when their structure and visibility remain
stable. Patches are bounded to 8,192 rows and source values. Reading and patching numeric columns
still has costs proportional to their size; updates are not constant-time. Restoring the retained
base's exact content key reactivates that base without reconstructing it or creating a
self-referencing overlay.

Storage remains snapshot format 4 with checked roots, sections, atomic publication and shared
project inputs. Native joined keys use `joined-native-v2:`. Older derived views rebuild once to
add the native source-search arena. Revisions without persisted summary counters upgrade their
metadata on preparation; an eligible update can retain the incremental join path. Touched data is validated during reads; opening a writer
does not scrub every unused payload.

## Boundaries and measurement

Requests and responses use validated domain schemas. UTF-16 code units, including lone
surrogates, survive the wire and dictionary boundaries. Search returns at most 50 rows and
200 group entries; `minGroupSize` drops smaller groups before that bound and before `more`.
Group keys, `openGroup` and `source` values hold at most 32,767 UTF-16 code units. A frame
carries at most 8 MiB; bulk reads (the corpus, localization lines, aggregates and findings
pages) stream as column batches with flow control, never as files
([Phase 4 §5](game-text-rule-engine-phase-4.md#5-column-batches)). Native operations expose stage
durations, batch counts and bytes, and actual section, index and write-byte counters.

Full cold construction still allocates in proportion to input size. Measure production host
preparation, first query, repeated query, mixed edits, warm reopen, focus, callback gaps and
process memory separately. The earlier
[hybrid rollout measurements](../research/effect-audit-native-rollout-2026-10-18.md) describe
the superseded native-writer/JavaScript-query architecture and are not performance evidence
for this engine.

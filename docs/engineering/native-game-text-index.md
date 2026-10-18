# Native Game Text engine

Rust owns the Game Text index: dictionaries, immutable storage, joins, incremental updates,
compaction, search predicates, facets, grouping, counts, pagination, focus and bulk exports.
It is a domain-specific embedded data engine. TypeScript owns host composition, extraction and
localization input producers, configurable quality policy, typed process calls and presentation.

CLI, Workbench and library hosts compose `GameTextIndexBuilderLive` from
`@ue-shed/game-text/index` with their existing `AssetReader`, source and localization evidence
layers. `nativeIndexBuilderLayer(configuration)` supplies the same builder and query capability
with explicit reader configuration. The reader needs uasset-io protocol 1.15, `game_text_index`
and `game_text_engine_v1`. Native failures remain typed failures with recovery guidance.

## Reads and writes

Preparation is explicit. `refreshProject`, `importTarget` and `buildTarget` publish derived state;
`openTarget` acquires an immutable native snapshot. Search does not discover packages, build a
join or construct a JavaScript query model. Source and localization requests use the same native
reader. The TypeScript in-memory and columnar implementations are independent test oracles,
excluded from production package output and public entry points.

All `model.query` operations return Effects. `model.summary` is cached metadata computed by Rust
while opening the model. Interactive callers use bounded search and focus; `model.corpus` and
`model.localizationJoin` are explicit asynchronous bulk reads. The full corpus retains blank
source units as provenance; filtered exports retain their visibility rules. CSV formatting
consumes native review signals rather than constructing another query engine.

`model.localizationJoin` contains the visible lines used by policy/report views.
`query.readLocalizationLines()` explicitly exports every joined line, including blank sources.

`query.localizationDetail` selects a line or unit and pages locations, cultures and PO context
in Rust. Ordinary text focus carries a compact localization preview. `localizationFocus` and
`localizationLines` explicitly export complete provenance through scoped files; interactive
handlers do not hydrate a full line and slice it in JavaScript.

Each opened model owns its native query process in the caller's scope. Native handles pin files
and dictionary segments, including sections not yet read, across later publications and
compaction. A query reader holds no writer lease. Canceling a caller skips its queued read or
stops waiting for an admitted read; that read and its temporary files remain owned by the model
until completion. Closing the model interrupts its active read. Losing a native process produces
a typed failure. Open a new model to recover; other models own separate processes.
Retained models require `borrow` around operations and `retain` when publishing a candidate.

One write session owns one native process and writer lease. Existing TypeScript input producers
send prepared layers through a leased native adapter. Rust publishes dictionaries, input layers,
joins and compaction atomically. Changing the selected project remains exclusively the host's
responsibility.

## Incremental publication

Source-only updates preserve row membership, identities, structure and visibility. Authored text
and String Table references may share a gathered line. Variable source lists and conflict flags
are updated in Rust, including duplicate-source signals on unchanged rows outside the edited
package. Repeated patches flatten against one retained base. A stable PO translation can change
in the same publication. Structural changes and eligibility failures rebuild the derived join.

The native writer maintains a SQLite dependency graph alongside the immutable snapshots. Logical
sites retain package, object, property, row and location coordinates separately from text values
and reference targets. Indexed edges map occurrences to localization lines and query groups;
source-value indexes locate duplicate-source dependencies. String Table definitions and references
have separate edge kinds, including references whose definitions are absent. Text equality never
merges their identities. A definition edit follows its consumer edges without rereading consumers.

Graph transactions are matched to an exact dictionary generation and joined revision. Uncommitted
updates roll back. The graph commits before the immutable root is published; an interrupted
publication leaves a revision mismatch that requires reconstructing the disposable graph. Each
target view owns its graph under the existing writer lease. Query readers continue to pin immutable
snapshots and do not depend on the mutable writer graph.

Text-value updates use indexed membership and source dependencies. Reference and identity changes
remain a separate structural path that rebuilds the projection and rewires the graph. The current
package producer still decodes and rewrites the affected shard, and opening a changed model still
computes its summary. Those remaining costs are not eliminated by indexing dependency discovery.

Short and long sources use the same incremental path when their structure and visibility remain
stable. Patches are bounded to 8,192 rows and source values. Reading and patching numeric columns
still has costs proportional to their size; updates are not constant-time. Restoring the retained
base's exact content key reactivates that base without reconstructing it or creating a
self-referencing overlay.

Storage remains snapshot format 4 with checked roots, sections, atomic publication and shared
project inputs. Native joined keys use `joined-native-v2:`. Older derived views rebuild once to
add the native source-search arena. Touched data is validated during reads; opening a writer
does not scrub every unused payload.

## Boundaries and measurement

Requests and responses use validated domain schemas. UTF-16 code units, including lone
surrogates, survive the wire and dictionary boundaries. Search returns at most 50 rows and
200 group entries. Native response JSON is bounded to 16 MiB; bulk corpus exports use scoped
files rather than a giant protocol frame. Native operations expose stage durations and actual
section, index and write-byte counters.

Full cold construction still allocates in proportion to input size. Measure production host
preparation, first query, repeated query, mixed edits, warm reopen, focus, callback gaps and
process memory separately. The earlier
[hybrid rollout measurements](../research/effect-audit-native-rollout-2026-10-18.md) describe
the superseded native-writer/JavaScript-query architecture and are not performance evidence
for this engine.

# Native Game Text preparation

`GameTextIndexBuilderLive` from `@ue-shed/game-text/index` selects the complete TypeScript
build/query backend used by CLI, Workbench and library hosts. Native saved-package extraction
remains a separate AssetReader capability. The production layer does not require a native Game
Text writer or its configuration. This restores the previous complete backend rather than shipping
a native writer coupled to a JavaScript query engine.

The owner requires a future native production backend to own both construction and query execution.
TypeScript should contain contracts, transport, resource lifecycle and presentation, without a second
query engine or reconstruction of the searchable corpus. Until that complete path is implemented and
accepted for correctness, performance and recovery, the TypeScript backend stays in production.

`nativeIndexBuilderLayer(readerConfiguration)` remains an explicit experimental writer for parity
and measurement. It requires `game_text_index` in uasset-io protocol 1.13 and still uses TypeScript
producers and JavaScript query readers. It must not be described as a complete native backend.
Native worker failures never switch writers automatically. The following sections describe this
experimental writer, not the selected production implementation.

## Ownership and compatibility

One build session owns one native child and writer lease. Existing TypeScript package and
localization producers supply prepared layers through a leased writer adapter. Rust publishes the
shared dictionary, input layers, joined projections and compaction. Scope finalizers release the
lease and process; an operation failure invalidates the lease and requires a new session. Search,
facets, focus and lazy projections still use the existing JavaScript readers.

The writer uses the existing format-4 directory, atomic root publication, string generations and
reader pins. Project views share input layers and retain independent joined pointers. Native
joined keys start with `joined-native-v1:`. Switching between native and TypeScript builders
rebuilds that joined view once while reusing inputs. This also prevents a reader's persisted
physical column projections from colliding across builder layouts.

Root and consumed payload checksums remain verified. Selective reads validate segment metadata and
touched sections rather than scanning every unused cached payload on each writer acquisition.
This is ordinary cache validation, not a full integrity scrub. Corrupt disposable caches still
require normal recovery.

## Incremental work and bounds

The native interner probes immutable A64 dictionary fences for unresolved strings. Full cold
construction and full joins still allocate in proportion to their inputs; this is not a claim of
constant memory for an arbitrary cold corpus.

The narrow incremental join retains stable row identity, structure, cardinality and visibility.
Source patches require both old and new strings to have at least 40 UTF-16 code units and reject
sources shared outside the affected rows. PO patches require stable identity, order and context.
The patch cap is 8,192 edits. Unsupported changes, generation changes, missing persisted source
state, changed dependencies and other failed eligibility checks rebuild the joined layer. Numeric
column scans still occur; eligible edits are not constant-time operations.

The adapter stages at most 8,192 intern strings or 16 MiB per batch, with a 1 MiB per-string limit.
Selected-string reads use batches of 32 and a 32 MiB response-file cap. Join input is capped at
32 MiB. A code-unit sidecar preserves unpaired UTF-16 in text and policy keys across JSON/Rust;
valid Unicode keeps its ordinary representation. Input files and results cross validated typed
boundaries. Temporary staging is scoped to the cache operation.

Native outcomes expose actual section/index/write byte counters and named stage durations.
Existing TypeScript-only substage metrics can be zero for this backend; they are not a complete
native phase attribution. Native operation spans carry the stage durations.

## Historical hybrid measurements

The previous public-adapter rollout measured the hybrid CLI and Workbench service composition over a
generated million-occurrence corpus. Median cold preparation improves from about 75–76 seconds to
56–57 seconds. Native is not faster for every workload: the measured mixed-reference package/PO
edit triggers a full native join (about 22–23 seconds versus 5–7 seconds for TypeScript), and warm
reopen is roughly one second slower. Memory does not improve on that workload. The explicit
TypeScript reference layer remains available for hosts whose workload favors it.

Native joining also does not eliminate synchronous reader materialization: the measured Workbench
focus operation still blocks for about 2.6 seconds at this scale. Full methodology, callback gaps,
raw parity evidence and limits are in the [rollout report](../research/effect-audit-native-rollout-2026-10-18.md).

Earlier prototype measurements below describe a different workload and narrower operation scope.
The isolated prototype compared an owned-buffer TypeScript control, a first native writer and an
incremental native writer. On the larger private dataset, one eligible source edit took 299 ms,
13,311 ms and 186 ms respectively. These measurements exclude package discovery, extraction,
model publication and UI work. They are evidence for the implementation direction, not fresh
measurements of this public protocol adapter.

The prototype's three warm Workbench runs took 7.477, 8.931 and 7.480 seconds; reopen took 10.193,
11.760 and 10.392 seconds. Inventory pagination, materialization and path sorting accounted for
about 4.3 seconds outside the writer. Query execution remained JavaScript: distinct-query requests
were about 39 ms, repeated queries about 2 ms, and repeated IPC requests about 3 ms. Typing also
includes the host's 120 ms debounce. These numbers make no native query-speed claim.

Production checks cover cold and eligible incremental builds, structural fallback, PO updates,
query/facet parity, arbitrary UTF-16, pinned readers, compaction, failed sessions, lease exclusion
and generated join-policy cases. The production rollout additionally exercises 32 real process
cancellation/termination cycles: startup, suspended staging, publication and worker death. Each cycle
reopens the last committed state, writes again, and verifies process, lease and staging cleanup.
Changing a PO fingerprint retains the new provenance without disqualifying a structurally eligible
incremental join. Structural and other eligibility guards still select a full native rebuild.

Current public-adapter host measurements and their limits are recorded in the
[rollout evidence](../research/effect-audit-native-rollout-2026-10-18.md). Generated reader evidence
isolates production preparation, model publication and queries; it does not measure Unreal asset
discovery/extraction. Saved-fixture runs exercise that separate path. Queries remain JavaScript.

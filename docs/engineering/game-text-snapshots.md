# Game Text snapshots

`@ue-shed/game-text` owns Plan 057's derived package-text, localization and joined-target
snapshots. The pure format is available from both entry points; the Effect Node store and its
source adapter are available from the main entry. Libraries and CLI provide the same layer as
Workbench. Domain storage stays outside the native Catalog. Package, localization and joined
layers are published through `GameTextIndexBuilder`; every host uses the shared refresh service.
The native Catalog supplies bounded committed signature inventory, as described below.

## Canonical performance policy

[ADR 0010](../decisions/0010-game-text-performance-policy.md) adopts the measured, bounded pipeline.
These are shared library defaults, not Workbench-only optimizations. Cold parsing starts immediately
with size-weighted reservations and up to eight workers; one oversized task can run alone. Parser
workers prepare sorted string runs and hashes. Larger layer conversions use workers while the
coordinator retains dictionary IDs, leases and publication. Reservations estimate memory use.

Queries warm bounded default pages and load other fields on demand. Review and raw focus use numeric
identity lookup. Locale sorting decodes stable runs bounded by 8,192 entries and 4 MiB of encoded
bytes, allowing one oversized identifier alone, then merges one decoded head per run. Optional
source caching follows the format and overlay bounds below. Numeric sections remain zstd level 1;
string/import domains retain their measured compression policy.

Bundled Node hosts must emit `localization-import-worker.js`, `package-text-worker.js`,
`cold-layer-worker.js` and, when enabled, `search-worker.js`, with their dependencies beside the
bundle that resolves them through `import.meta.url`.
Leaving the installed package unbundled also preserves these paths. Verify a cold refresh that
uses multiple layers in the packaged host; a small warm fixture can miss an absent cold worker.

The accepted target-only generated 1× cache is 81.8 MiB. Workbench prepares that same target-first
model for raw source and localization browsing; its fresh cache also measures 81.8 MiB. Older
source-plus-target caches measure 140.8 MiB and retain their previous layers until explicitly
rebuilt. This fixture result does not impose a global cache quota
across projects, targets, staging or pinned generations. Full measurements and rejected alternatives
are in the [consolidated experiment record](../research/game-text-pipeline-performance-2026-10-13.md).
Backend adoption remains governed by the shared builder contract below. Gather coverage is unchanged;
see [the comparison with Unreal gather](game-text-gather-coverage.md).

The Node adapter uses built-in zstd and CRC32, verified on Node 24 and 26. Store activation on a
runtime without zstd fails with typed upgrade guidance. Other package exports remain loadable.

## Format and lazy reads

Layout version 4 uses magic `UESHT004` inside the `game-text-v2` cache namespace. Old derived
generations, including everything under `game-text-v1`, are rejected and rebuilt. Integers are
little endian; payloads are four-byte aligned. The 48-byte header contains version, section count,
file length, directory end, directory CRC32 and header CRC32. Reserved bytes must be zero.

A section's codec is 0 (raw) or 1 (zstd). Integer and string-ID columns may also use codec 2, zstd
over the values' bytes grouped by significance (all first bytes, then all second bytes, and so on),
or codec 3, the same over the differences of a non-decreasing column. The native writer picks the
transform that compresses a sample of the column best, since some integer sections hold packed text
bytes, and encodes a layer's sections in parallel. The section checksum covers the decoded bytes.
`game-text-v2` exists because readers of `game-text-v1` cannot decode codecs 2 and 3. On a local
UE 5.7 project (~11k packages) the joined layer shrinks from 15.2 MB to 4.2 MB and the whole Game
Text cache from 19.4 MB to 8.3 MB.

Full joins with at least 8,192 distinct sources may include an optional source-query cache. Its
global IDs, byte offsets, canonical WTF-8 bytes, ASCII flags and a 256 KiB ASCII-trigram membership
table are ordinary checksummed sections. The producer limits the combined raw projection to
96 MiB and conservatively bounds its stored sections to 16 MiB; larger projections retain the
dictionary-backed path. Readers verify ranges, IDs, UTF-8/WTF-8 boundaries and flag codes before
using the projection. Older joins remain readable without these optional columns.

The cache belongs to its immutable full-join generation. An overlay can reuse its base and append
bounded newly selected sources, copying the trigram table before adding their memberships. Missing
trigrams reject only lowercase ASCII sources; other sources retain exact locale folding and
matching. Obsolete memberships cause additional checks rather than lost matches. Existing readers
keep their original buffers. ID compaction remaps the cache's ID column with other source columns.

Each 96-byte directory entry holds a zero-padded ASCII name (31 characters), kind, codec,
64-bit positioned offset, stored length, raw length, element count, raw CRC32, string domain
(23 characters), domain string count and reserved flags. Codec zero stores raw bytes; codec one
stores a separate zstd frame. A section stays raw when zstd would make it larger. Section
checksums cover decoded bytes and are verified when that section loads.

Open reads only the header and directory through an open file handle. It validates all file and
section bounds, counts, kinds, domain references and directory checksums before allocating any
section buffer. Section loads use positioned reads, capped decompression, raw CRC verification
and typed-array views without copying. String-ID columns validate every ID against their domain.
Integrity failures name the section and give disposable-cache rebuild guidance.

Caps: 16 GiB per file or explicitly loaded raw domain, 128 MiB per section, 1,048,576 sections;
64 million strings per domain and 1 MiB per string. Directory allocations are capped at 96 MiB.
The file-length cap accommodates the measured generated raw probe; it never authorizes a
whole-file allocation. Each frame allocation is bounded by the smaller section cap.
Sections contain bytes, unsigned bytes, unsigned 32-bit integers, domain-local string IDs or
WTF-8 string blocks. Domain-specific numeric relationships need their layer's semantic validator.

Standalone Phase 2 files deduplicate separately by domain. The Phase 3 shared index below replaces
those independent dictionaries with project-wide IDs across all layers. Blocks target 256 KiB of raw bytes,
including local offsets; an oversized single string gets its own bounded block. Each domain has
a small `u32` block-start-ID column, checked for order, counts and agreement with loaded blocks.
Lookup binary-searches that column. Canonical WTF-8 is checked at each string boundary.
Domains remain contiguous on disk and avoid both unrelated reads and a global 4 GiB offset limit.

`reader.section(name)` retains numeric columns on first use. String blocks are temporary.
`reader.strings(domain, ids)` groups requests by block and reads only the touched blocks, including
padding in each positioned read. `reader.domain(domain)` explicitly loads contiguous blocks in
64 MiB positioned reads, checks padding and every block's raw CRC, and decompresses frames in
sequence into one domain buffer. It returns block byte/ID indexes, lookup and a plain Unicode
lowercase substring scan. The caller owns that buffer; page reads still load only touched blocks.

## Store lifecycle

The configured cache root contains `game-text-v2/<hash-of-project-and-target-keys>`, beside
`catalogs-v6`. Both `SnapshotStore.open()` and `writer()` require an Effect scope. The reader
holds its physical file open until scope release, preserving that generation through publication
and retirement. Windows tests retire the old filename before reading its previously unloaded
strings through the retained handle.

`GameTextIndexRefresh` uses one `shared-project-text-v1` store per project. Package layers and
string IDs are shared between saved-source queries and every localization target. Each target
has its own hashed joined/base/invalidation/import pointers, presented through the same `SharedIndex`
interface, so revisiting a target reuses its join and pinned readers retain their original view.
`SharedIndexOptions.projectView` selects an explicit source or named localization view for
lower-level tooling and workers. A localization target named `SavedText` remains distinct from
the source view. View hashes preserve lone UTF-16 surrogates through JSON escaping.
Standalone stores with ordinary target keys keep their existing layout. Earlier target-scoped
refresh caches are disposable and rebuild in the new project store; authored files are unchanged.
Committed signature inventories are cached by project identity and generation, with capacity two
and no caching of failed lookups. A new catalog generation fetches a new inventory.

Completed localization imports publish content-derived observation keys for successful and failed
files, shared across targets, plus a target-specific import key. Build and open steps check these
dependencies before using a handle. Repairing a missing or malformed file invalidates an older
failed import even when the restored content reuses its historical file-layer key. Unchanged
observations reuse their keys, so concurrent targets with identical inputs remain compatible.
Existing pinned models retain their original evidence when later observations change.

Worker-enabled index steps retain a bounded map of eight query workers, keyed by configuration,
physical generation and joined-layer identity. Overlapping unchanged models share a worker while
keeping their own reader scopes. A model opens its worker before publication; lazily reopening
the current manifest after publication would lose its historical generation after compaction.
Closing one model leaves other pins usable. The last pin awaits worker retirement, and changed
joins use a different worker. Metrics count starts, stops and retirement duration.
An unchanged refresh replaces an instance that has failed after readiness. Instance keys differ
from immutable query identities: old reader pins remain valid, and retiring a failed instance
cannot remove its healthy replacement from the pool. Concurrent callers share the replacement.

A target model contains the complete raw source projection. Hosts needing both views can import
the target before refreshing packages and build one join. Workbench uses the selected target for
the same project, or the first discovered target, with source-only recovery when target discovery
or import is unavailable. Target selection still validates imports, review records and carried key
changes before comparing the target handle's optional opaque `queryRevision` with the existing
model's identity and borrowing it. Hosts must not parse or construct this identity or store it as
a durable ID; compare only within the same project, cache and backend. An
unchanged package refresh clears the old selection while retaining its resource pin until a
replacement takes ownership; discovery failures and empty target lists release that pin.

A writer consumes a `SnapshotSource`: ordered section descriptors with a bounded load operation.
`snapshotColumnsSource` adapts existing columns; streaming importers can supply descriptors that
produce one column or block at a time. The writer never allocates an entire raw or compressed
file. Working payload memory is one section plus its compressed copy; inputs retained by a
column producer remain that producer's responsibility.

Publication reserves the destination exclusively, writes a temporary file section by section,
backfills the checksummed directory, fsyncs, and renames. It verifies persisted sections sequentially
before atomically publishing the bounded JSON manifest. The manifest names current and previous
generations and input keys. Numeric and string buffers used by verification are temporary.
Numeric sections use zstd level 1; string blocks use level 3. Level 3 improves string
sizes at a modest encoding cost while higher levels give smaller returns. Per-kind measurements
and the combined policy's size/time evidence are recorded in Plan 057.

A sibling directory lock excludes writers. A nonempty candidate containing an owner/PID record is
installed by rename. A second writer fails with typed `busy`; dead local owners are reclaimed,
and live, foreign or unreadable owners need inspection. The lock stays outside quarantine.
Writer acquisition verifies the current file one section at a time, quarantines corruption and
cleans interrupted staging and retired generations. Lazy reader failures report corruption
without changing files. Failed manifest publication retains the candidate and prevents further
publication until the writer is reopened, since the rename may already have succeeded.

File mutation and reads finish before interruption releases their resource. Closed reader and
writer scopes reject later use. POSIX also syncs directories; Windows Node provides file fsync
and rename. Tests establish process-crash visibility, not a power-loss guarantee. Operations have
named spans, structured logs, metrics and typed filesystem failures.

## Localization file import

`importLocalizationFile` records size, mtime, ctime, inode and device beside its content key.
Matching stats reuse the snapshot without opening authored bytes. A changed stat hashes and parses
one bounded read; an existing hash discards that parse. Before/after handle and path stats detect
in-place writes and replacement, returning typed `file_changed` retry guidance. There is no input
spool. Bounded column string blocks still spill while building a changed file. Stat records are
validated, atomically replaced disposable hints; content keys remain SHA-256 over importer version,
format/PO options and the authored content hash. Importer version 5 separates shared ID layers.
`sharedTargetKey` selects the target store; target discovery supplies the target name. Standalone
file imports default to the explicit `localization` target store. Content hashes remain independent
of other files and the manifest, and a changed-then-restored file can reuse its older cache key.

The JSON tokenizer accepts UTF-16LE BOM or the existing reader's UTF-8 JSON encoding, checks syntax
and nesting across chunks, and decodes only one bounded `Children` element with the native JSON
parser. Namespace nodes retain
parent/name data; namespaces resolve after EOF, so property order does not change identities.
Manifest keys expand directly into numeric columns. Stable sorting preserves the oracle's duplicate
identity order, including root children appearing after subnamespaces in the JSON text.
The PO scanner splits only physical CR/LF lines, preserving U+2028/U+2029 inside strings. It sends
bounded blocks to the localization package's shared `parsePOBlock` decoder, then resolves identities
using the target's format/collapse mode or the first header. Errors carry file and line/offset context.
The document reader and its existing callers keep their original limits and behavior.

The importer defaults to 16 GiB input/spill bytes, 4 million entries or namespace nodes, depth 64,
2,560 target files, 4 MiB per materialized record/block and 512 MiB of accounted identity dictionary
storage (128 bytes plus UTF-8 bytes and two bytes per code unit per unique string). Retained and
resolved namespace trees each have the same allowance, charging 128 bytes per node plus five bytes
per code unit. Reads are at most
1 MiB, normally 256 KiB. Each string remains limited to the format's 1 MiB UTF-8 cap. These bounds
allow the retained 10× files without admitting unbounded strings, trees, dictionaries or row arrays;
320 MiB input and 1 million rows no longer describe the importer's memory use. They remain the
unchanged `LocalizationEvidence.read` defaults. Source, translation, path and comment domains dedup
within 256 KiB blocks and spill immediately. Path rows factor a prefix stored only in that file’s
metadata; mixed prefixes retain their full value under a row flag. Identity blocks use measured
zstd level 6, paths level 9, and source/translation/comments level 3. These bounded temporary
domains are remapped into the shared store before publication; they are never retained as
independent string copies on disk. The identity dictionary serves sorting only.
The 512 MiB dictionary allowance was chosen after 10× exceeded the tentative 256 MiB cap.
The 16 GiB byte allowance limits disk work and spill usage; the record, dictionary, tree and row
limits bound memory directly.

Each file uses layout version 4, with the following logical localization columns (importer version 6):

| Sections                                        | Domain / meaning                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry.namespace`, `entry.key`                  | Identity string IDs, rows sorted by namespace/key text                                                                                                                                                                                                                          |
| `entry.source`, `entry.translation`             | Separate text domains; equal-to-source translation is derived                                                                                                                                                                                                                   |
| `entry.path`                                    | Manifest path or first PO reference in the paths domain                                                                                                                                                                                                                         |
| `entry.notes`, `entry.metadata`                 | Manifest notes and optional opaque metadata JSON, comments domain                                                                                                                                                                                                               |
| `entry.source-extra`, `entry.translation-extra` | Non-Text fields of the complete localization text objects, comments domain                                                                                                                                                                                                      |
| `entry.po-extra`                                | Noncanonical context/plural, nonzero msgstr values and nonempty comment/flag arrays as JSON                                                                                                                                                                                     |
| `entry.options`                                 | u32 bits: optional present/true (1/2), notes present (4), metadata present (8), null PO identity (16), canonical context (32), translation zero present (64), translation equals source (128), leading key comment (256), leading reference (512), path uses file prefix (1024) |
| `entry.ordinal`                                 | u32 original flattened order; restores PO parser order and stabilizes duplicates                                                                                                                                                                                                |
| `file.meta`                                     | Bounded JSON: file format, row count, PO format and source-presence boolean and independent path prefix                                                                                                                                                                         |

Optional absence differs from empty or false. Full source/translation objects matter to source
matching; `metadata.Info.Comment`, developer notes and paths matter to origins and translator notes.
Plural translations and every comment array round-trip; empty arrays and canonical context/key
comments are derived, and translation zero lives only in its text domain. Duplicate diagnostics are derivable from adjacent identities rather than another object tree.
`decodeLocalizationSnapshot` hydrates an explicit bounded page (default 50, maximum 10,000),
using the layer returned by `SharedIndex.open().layer(contentKey)`.
`importLocalizationTarget` uses `LocalizationEvidence.discover`, imports manifest/archive/PO files
sequentially, and returns independent snapshot keys plus typed per-file diagnostics. Locmeta and
reports remain outside this layer. Missing evidence does not suppress successfully imported files.

The opt-in `scripts/benchmark-localization-import.ts` measures cold, rewritten-same-bytes, stat-hit and one-file-change imports, per file
and through target discovery, in one supervised child at a time. It uses the scale safety module's
16,384 MiB heap, OS-polled 20 GB RSS and 20 minute stage caps. It records timer/checkpoint heap and
buffers, pre-GC traced heap, OS RSS, input bytes, snapshot bytes, elapsed time and parsed/reused status.
Both retained scale projects are read without regeneration or the 10× in-memory reader. Complete
per-file and target tables are in
[the localization import measurements](game-text-localization-import-measurements.md).

```powershell
node --import tsx --max-old-space-size=256 scripts/benchmark-localization-import.ts --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/import-files-1x --output test-results/game-text-scale/import-files-1x.json --mode files
```

## Shared strings, generations and compaction

`sharedIndexNodeLayer` supplies the same scoped Effect service to libraries, CLI and Workbench.
The target key is `shared-index-v2:<target>` inside `game-text-v2`; importer version 5 and root
version 2 rebuild the disposable prior hash-page cache. One writer lock publishes a checksummed
`index.meta` root atomically. The root names every immutable segment, independent content-keyed
layer and active file path. Layers declare their generation and segment dependency. Readers open
all handles before returning and retain the generation across compaction and retirement.

**A64 dictionary.** Each immutable segment stores distinct UTF-8 strings in byte sort order.
The ID is the segment base plus sort rank. Blocks restart front coding every 64 strings. Zstd
frames target 256 KiB; an individually large block can exceed that target while retaining the
existing 1 MiB/string and 128 MiB/section bounds. Four sparse columns contain first keys, frame
numbers, block offsets and ownership masks. There are no persisted hash pages or Bloom filters.
Canonical 32-hex strings use a tag plus 16 GUID bytes; uppercase hex digits add a 32-bit case mask.
The noncanonical tag uses the normal front-coded suffix. Every decoded value retains exact text.

A batch sorts unresolved strings once and removes duplicate requests. Matching ownership domains
are probed first, newest segment first, followed by other segments for exact cross-domain reuse.
Each segment receives one ordered pass after a sparse seek to its first unresolved key. Key bounds exclude
impossible requests. Equality compares complete bytes. Positioned frames have a 32 MiB decode
cache; sparse indexes contain no per-string pointers. Prefix range queries perform two lower
bounds per segment and return half-open ID ranges for callers to intersect with their path columns.

The maximum is **256 segments**. A publication that could exceed it first compacts. Reaching the
ceiling also compacts after publication. Ordinary small edits retain the existing conservative
obsolete-byte check: 8 MiB and 25% must both be exceeded before an exact live census is warranted.
Explicit `compact(true)` performs the full remap regardless of garbage. Compaction collects all
live strings into an exactly sized byte arena, sorts them globally, writes **one segment**, remaps
every active layer and publishes one generation under the existing lock. Interrupted publication
leaves the old root readable. Historical content keys retired by compaction can be reconstructed.

First-use domains remain source, identity, `culture.<culture>`, paths and comments. Cross-domain
IDs read their owner without a second stored copy. A compacted segment carries per-string owner
pages and block masks. Masks are conservative for more than 32 owners; exact owner pages filter
any collisions. A domain request expands only matching blocks, with bounded shared-frame reads,
into the Phase 2 byte-buffer/block-index representation. Page decoding and localization hydration
keep their existing APIs. Front-code expansion adds CPU work to bulk loads; the measured report
records that cost separately from hot column loads and page reads.

Cold conversion collects domain byte/offset arrays outside V8, radix-sorts typed occurrence IDs,
assigns ranks and encodes each block once. The producer keeps one raw frame and its compressed
copy, retains compressed frames outside the heap and writes the final snapshot in one pass.
Prepared byte-frame metadata preserves CRC checks and bounds; persisted verification still runs
before publication. Byte offsets widen to exact float64 integers above 4 GiB; IDs remain u32.
Compaction preallocates from its census rather than doubling a multi-gigabyte arena. These choices
stay within the supervised heap/RSS limits on the retained workloads; larger workloads can fail
the explicit 16 GiB arena cap rather than silently wrap offsets.

Cold localization starts a bounded parser pool immediately. It reserves half of the memory reported
by `process.availableMemory()` for parsing, estimates each task at 128 MiB plus 32 times its input
size, and admits smaller files alongside a larger one when their reservations fit. A file that
exceeds the estimate budget runs alone. These reservations are conservative scheduling estimates,
not a hard RSS limit; there is no largest-file calibration pass or fixed 16 GB worker allowance.

Parser workers prepare 16 MiB local string runs and reuse hashes before their columns are released.
The coordinator merges those runs, assigns shared IDs, and preserves deterministic cross-domain
ownership. Temporary run readers target 16 MiB in aggregate with a 16 KiB minimum per reader.
At 256 or more packages, a first package refresh spools one validated read batch into bounded shard
buffers and uses the package worker pool. Existing and smaller package sets retain their current
path. With at least 512 KiB of local-to-global mapping vectors, staged layer conversion runs in up
to eight workers under an available-memory budget; smaller mappings convert in the coordinator.
Workers receive only their own copied ID maps and cannot publish a root or acquire another lease.
The coordinator verifies results and publishes the root atomically. Final join policy still runs in
TypeScript; its ID comparators retain two decoded strings rather than repeatedly decoding both sides.

**File refresh.** The previous key comes from the active path publication or the file's validated
stat hint. Sorted identity mappings match old/new rows, including duplicates and reordering.
The prior file's byte-to-ID mapping reuses unchanged content; only unresolved new/changed strings
are sorted and probed against the project segments. Missing previous layers fall back to full
sorted lookup. Bounded byte batches avoid decoding old strings to JavaScript text and encoding them
again during reuse and compaction. Import metrics expose `lookupStrings`, `reusedStrings` and `probePasses`; stat hits
perform zero dictionary probes. Shared IDs still use reversible modular deltas with zigzag encoding
and zstd level 1. Reader checksums, dependency bounds and scoped column caching remain in place.
An unchanged translation previously represented by its source also reuses that source's old ID,
including when the new source changes. GUID case, reordered identities and these implicit references
have round-trip oracles.
Numeric old IDs already follow byte order inside each segment. Reuse validates ordering at segment
joins before skipping an old-string sort, and validates row identity order before skipping row sorts.
Mixed ordering, new identities and reordered rows retain the full sorting fallback.

The measurement mode uses retained projects and saved Phase 2 snapshots, without rebuilding the
1× join. `--select cold|projection|compact|reader|folder|refresh|parse` isolates operations. All children
run singly with 16,384 MiB heap, 20 GB OS RSS and 1,200 s/stage. **Every 10× run has one absolute
900 s deadline**, including startup, discovery and cleanup. Expired or interrupted runs fail;
per-file stages cannot reset the deadline. The parent restores a PO edit even after worker death.
`--po-change-byte` selects a fresh lowercase ASCII replacement. A refresh measurement must parse
one file; an already cached replacement fails rather than being reported as fresh-edit performance.
PO common folder prefixes live in file metadata; dictionary ranges operate on stored suffixes.
The 10× joined layer remains a synthetic width probe, not a semantic join or a real-content
compression forecast. The full-width forecast charges every declared historical domain width,
including unused variants that the live census prunes. Package proxies omit headers, coverage
and complete origin membership. Full evidence: [shared measurements](game-text-shared-index-measurements.md).

```powershell
node --import tsx scripts/benchmark-localization-import.ts --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/a64-accepted-1x --output test-results/game-text-scale/a64-accepted-1x.json --mode shared --select all
node --import tsx scripts/benchmark-localization-import.ts --project test-results/game-text-scale/project-10x-final --cache test-results/game-text-scale/a64-accepted-10x --output test-results/game-text-scale/a64-accepted-cold-10x.json --mode shared --select cold
```

## Library build and query boundary (Phase 6 in progress)

`GameTextIndexBuilder` is the injectable build capability. Its import, package refresh and
joined refresh methods retain the existing TypeScript functions' inputs, result statistics
(read, parsed/reused and published), typed failures and scoped requirements. It also exposes
dictionary intern/compaction and `withSession`. The selected backend owns the writer lease;
a future native layer must not reacquire a lock already held by a TypeScript caller.
`typeScriptIndexBuilderLayer` remains the oracle and fallback. Native default selection and
production host adoption are pending.

The library `GameTextIndexSteps` service exposes project opening, package refresh, localization
import, target construction, and query opening separately, using an injected `GameTextIndexSource`
inventory/event adapter. Project refresh returns a verified package revision which multiple target
builds can consume without repeating inventory. Localization imports can also precede package
refresh. Every write step owns a scoped lease; builds reject stale project revisions or superseded
file publications. Query opening validates the target revision and returns a pinned reader with the
existing `TextCorpusQuery` contract. Workbench and CLI choose their composition.
`GameTextIndexRefresh` remains a convenience wrapper over those steps. The persisted service test
checks unchanged reuse, selected file/package changes, review invalidation and readers
retaining their earlier generation.

Joined key `joined-v7` adds private query projections. `query.raw` and `query.slice` contain
numeric representatives, memberships, source/file ID vectors and offsets, flags, visibility
and character/word counts. Raw and line identifiers have packed UTF-8 arenas plus numeric
offsets and order vectors. `line.source_words` and `line.source_visible` complete the line
projection. Overlay metadata can associate a query field with its own patch-row vector;
line/culture fields retain the common `patch.rows`. Equal physical columns still alias.
A native joined publisher must produce these projections before serving this query reader.

The synchronous API uses the same pinned Node handles and codecs through `layerSync`,
`stringsSync` and `bytesSync`; the one runtime boundary is documented in
[Effect composition](effect.md#composition-roots-and-exits). Displayed line hydration uses
a 64-entry Effect cache. Production query telemetry, bounded facet-label scans, host wiring
and default-heap acceptance measurements remain incomplete.

**Source-fidelity STOP:** the existing parser accepts an escaped lone UTF-16 surrogate, while
the validated UTF-8 dictionary replaces it with U+FFFD. Exact reconstruction requires a
shared TypeScript/native representation decision; it cannot be repaired by a query or
gathered-line transformation. Two explicit failing fixtures retain the evidence. See the
[plan](../../plans/057-game-text-compact-index.md#phase-6-continuation-column-query-builder-service-and-utf-16-stop).

## Snapshot format measurements

The opt-in `scripts/benchmark-game-text-snapshot.ts` runs one child at a time with the Phase 1
safety module: 16,384 MiB heap, 20 GB OS-polled RSS and 20 minutes per stage. `reblock1` replays
the saved raw 1× sections, splits source/identity IDs and changes block boundaries without a join.
`build1` retains its exclusive claim; the revision never runs it or regenerates either project.

`synthetic10` reads the replayed 1× directory and measures UTF-8 bytes per independent domain.
Source, identity and paths scale with recipe line/occurrence counts; each culture scales by ten
and the culture count doubles. Strings are filled one block at a time to measured domain widths.
This is invented compressible content, a format-size probe, not a real 10× compression forecast
or the Phase 5 join. Both streaming producers write the selected per-kind zstd policy directly.

`probe` compares 16, 64 and 256 KiB blocks; `publish`/`open` measure the production store.
`--profile` enables a CPU profile in the bounded child. Loads retain one byte buffer per domain;
scans count matches without retaining JS strings. Time and cumulative heap, buffers and RSS are
recorded for source, one culture and paths. Zstd/validation/copy/read timings explain throughput.
Page ID columns load before the separate 50-line decode timer. The hot selection stays identity/
source IDs, origins, occurrence indices, culture states and the picked culture's flags.

```powershell
node --import tsx --max-old-space-size=256 scripts/benchmark-game-text-snapshot.ts --task reblock1 --block-kib 256 --reference test-results/game-text-scale/snapshot-v2-1x.raw --file test-results/game-text-scale/snapshot-v3-final-1x-256.snapshot --output test-results/game-text-scale/snapshot-v3-final-1x-256-build.json
```

The Phase 2 joined projection is a layout probe of identities, states, facts, unknown reasons,
translations, sparse PO overrides, review/key changes and occurrences. Source metadata, full
comments, package coverage, complete origin membership and lossless domain hydration remain
work for later phases.

## Lossless UTF-16 and host queries

All snapshot string domains use canonical WTF-8. Well-formed strings have exactly their UTF-8
bytes; supplementary characters use four bytes. Lone surrogate code units use their generalized
three-byte encoding. A three-byte lead immediately followed by a three-byte trail in one entry is
rejected as a non-canonical pair, as are overlong, truncated and out-of-range sequences. Independent
entries may end and begin with those code units. Errors name the section as `SnapshotFormatError`.
The dictionary, A64 fences, sorting and IDs use the same bytes in TypeScript and Rust. Search and
case folding preserve lone surrogates. Encoding checks `isWellFormed()` before using `TextEncoder`;
decoding scans for surrogate sequences before using the fatal UTF-8 `TextDecoder` fast path.

The actual UE 5.7 and UE 5.8 manifest and archive serializers use RapidJSON and reject escaped lone
leads, lone trails and trail-then-lead sequences. Both TypeScript parsers now return
`malformed_manifest` / `malformed_archive` with file and character offset, matching those loaders.
The disposable process-lane probe invokes both serializers: six expected rejections and two accepted
pairs. PO acceptance remains UTF-8. Saved package strings preserve every UTF-16 code unit.
`fixtures/game-text-wtf8` contains shared golden bytes and genuine snapshots written by both builders.

The existing `TextCorpusQuery` API reads the pinned joined, package and localization layers.
`joined-v10` adds `query.package.order`, raw/slice namespace IDs and `query.place` projections;
native builders must emit these projections as well. Package order preserves the native reader's
path-component order. Folder ancestors, normalized asset keys, namespaces and UTF-16 label ranks
use numeric coordinates. Normalized object, package and manifest paths use packed WTF-8 byte
arenas. Group/facet scans and path, asset and namespace predicates decode only displayed labels.
Private byte arenas have u32 offsets; coordinate IDs remain local to that joined snapshot. Shared
file/path/namespace ID vectors retain their domains so dictionary compaction remaps them. Their
byte order is independent of append segments and remains stable after compaction. Hot numeric
columns remain in array buffers. Pages decode direct previews; full evidence objects are decoded
only for focus, explicit report or export. Matching row sets and count projections use bounded
Effect caches. One retained generation per host model is released on replacement or shutdown.

The refresh service's two-entry Effect cache retains the latest query projection for each
dictionary-generation/full-base pair. Incremental generations copy references to immutable
numeric buffers only when their exact physical layer keys remain dependencies. Patched and
derived columns stay private to the new query; full-base changes and dictionary compaction reset
reuse. Source search arenas copy retained WTF-8 bytes and decode only newly selected source IDs.
Reuse permits at most 8,192 newly selected IDs, 8,192 obsolete IDs and 32 MiB of obsolete source
bytes; beyond those bounds, the arena rebuilds from current sources. Old readers keep their
original buffers. Query preparation eagerly prepares source search, common counts and bounded
default presentation pages. Other package, culture and rule columns load on demand through the
pinned reader; preparation no longer inflates every physical column. The source arena trims
backing capacity when spare bytes exceed 25%. Non-ASCII searches skip sources known to contain
only lowercase ASCII, while other sources retain locale-sensitive folding. Raw focus lazily
builds a numeric reverse index instead of repeatedly visiting every localization line.
Refresh spans record reused-column count, source reuse and query-preparation duration.

Every host obtains builds through `GameTextIndexBuilder`: import, package refresh, dictionary,
compaction and joined refresh. `typeScriptIndexBuilderLayer` implements the existing signatures;
hosts select that capability through the public steps service. `GameTextIndexSteps` owns per-step
writer leases, structured spans, typed failures and cache invalidation. The convenience refresh
wrapper retains its overall refresh metrics. A persisted `joined.invalidated`
marker forces the next join refresh while retaining prior metadata for selected-file refreshes;
it is removed after successful publication. PO layers are invalidated by their content key and
review changes by the next review read/hash. Query boundaries record spans and duration metrics.

The native Project Index exposes bounded `Inventory` queries over one committed generation.
Rows contain package paths, opaque four-part package/sidecar signatures and optional header
gather evidence. Memory, binary and SQLite adapters derive these from their committed inventory,
without scanning disk or re-reading headers. The Game Text source refreshes that catalog once;
Workbench reuses the generation published by its project refresh. Selected bundles are verified
before and after extraction. A worker lacking this query capability fails with upgrade guidance.

Joined columns larger than the format's 128 MiB section limit are published as physical
`.chunk0`, `.chunk1`, … sections. `join.meta.chunks` maps their logical names; both asynchronous
and synchronous readers reconstruct the same numeric buffers and apply logical overlays. Equal
unpatched aliases share their buffer; patched columns retain their own buffer so an alias still
sees its pinned base values.
Long logical names use short `join.chunk<column>.<part>` physical names to fit the directory's
31-byte name field. Readers use the metadata mapping rather than deriving physical names.

`joined-v11` supports stable source conflicts in one flat overlay over the full base. Joined
metadata v4 adds `sourcePatches.raw` and `sourcePatches.slice`; each names sorted query-row indices,
replacement-list starts and shared source IDs in the overlay. Each projection is bounded to 8,192
rows and 8,192 source IDs. Readers splice the base source arena and derive its packed start/end
columns, copying unchanged runs without retaining row objects. These list patches cannot overlap
fixed-size patches of the same source/range columns. Both read paths preserve unpatched aliases.
Successive overlays flatten their list replacements over the same full base. Metadata v3 full
layers and earlier fixed-size overlays remain readable; the new content-key prefix prevents older
builders from reusing an unsupported metadata-v4 overlay. This is separate from the unchanged
physical snapshot/WTF-8 format v4.

Incremental refresh checks the metadata generation before opening a previous overlay base.
After compaction it rebuilds from current inputs. Saved-only joins have no manifest layer;
their source edits use an empty manifest source vector instead of requesting an absent layer.
Restoring the original inputs uses a full publication when their content key equals the retained
base, preventing an overlay from overwriting the base it references.
Count baselines are cached per target/culture selection, so Workbench target selection cannot
evict another culture's baseline and make otherwise equivalent facet/search requests recount
the entire target. These caches are bounded Effect caches owned by the query generation.

`package-text-v5` stores each package record with its Blueprint representation copies folded into
their authored sites ([Compiled Blueprint copies](../products/game-text.md#compiled-blueprint-copies)).
Occurrence rows are places only, so joins, units, counts and facets read them unchanged. Each
place has `occurrence.copies`: bit 0 when it has copies, bit 1 when a copy holds other text, and
the copy count from bit 2. Copies are sparse rows in their places' order (`copy.object`,
`copy.kind`, `copy.source`, `copy.class`). `copy.kind` holds the kind in bits 0–1, bit 2 when the
copy has its place's text (its source is then empty), bits 3–4 for the gather table's runtime or
editor-only bit for the copy's own text, and bit 5 when it has its place's class (its class is then
empty), so stored records keep each copy's audience evidence through refreshes. `package.blueprints` keeps the reader's `blueprintClasses` as JSON
(empty without a Blueprint), so a decoded shard round-trips to the folded record. A place's
`occurrence.audience` is the rollup over the place and its copies, each classified from its own
evidence. Bit 1 of `occurrence.copies` counts only copies the game runs (generated class, its
animation instances, class default), never a skeleton. `joined-v14` reads
`occurrence.copies` and sets query signal bit 6 (`compiled_copy_differs`). A change to a copy's
text or to a place's copy flags is a package-structure change, so the join rebuilds in full; edits
to the place's own text keep the incremental path and its signal bits.

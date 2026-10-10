# Game Text snapshots

`@ue-shed/game-text` owns Plan 057's derived package-text, localization and joined-target
snapshots. The pure format is available from both entry points; the Effect Node store and its
source adapter are available from the main entry. Libraries and CLI provide the same layer as
Workbench. This domain storage stays outside the native Catalog and needs no Rust protocol change
or new dependency. Localization import is available now; package import and joins remain Phases 4–5.

The Node adapter uses built-in zstd and CRC32, verified on Node 24 and 26. Store activation on a
runtime without zstd fails with typed upgrade guidance. Other package exports remain loadable.

## Format and lazy reads

Layout version 3 uses magic `UESHT003` inside the existing `game-text-v1` cache namespace.
Old derived generations are rejected and rebuilt. Integers are little endian; payloads are
four-byte aligned. The 48-byte header contains version, section count, file length, directory end,
directory CRC32 and header CRC32. Reserved bytes must be zero.

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
UTF-8 string blocks. Domain-specific numeric relationships need their layer's semantic validator.

Standalone Phase 2 files deduplicate separately by domain. The Phase 3 shared index below replaces
those independent dictionaries with project-wide IDs across all layers. Blocks target 256 KiB of raw bytes,
including local offsets; an oversized single string gets its own bounded block. Each domain has
a small `u32` block-start-ID column, checked for order, counts and agreement with loaded blocks.
Lookup binary-searches that column. UTF-8 is checked once per payload plus each string boundary.
Domains remain contiguous on disk and avoid both unrelated reads and a global 4 GiB offset limit.

`reader.section(name)` retains numeric columns on first use. String blocks are temporary.
`reader.strings(domain, ids)` groups requests by block and reads only the touched blocks, including
padding in each positioned read. `reader.domain(domain)` explicitly loads contiguous blocks in
64 MiB positioned reads, checks padding and every block's raw CRC, and decompresses frames in
sequence into one domain buffer. It returns block byte/ID indexes, lookup and a plain Unicode
lowercase substring scan. The caller owns that buffer; page reads still load only touched blocks.

## Store lifecycle

The configured cache root contains `game-text-v1/<hash-of-project-and-target-keys>`, beside
`catalogs-v4`. Both `SnapshotStore.open()` and `writer()` require an Effect scope. The reader
holds its physical file open until scope release, preserving that generation through publication
and retirement. Windows tests retire the old filename before reading its previously unloaded
strings through the retained handle.

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
format/PO options and the authored content hash. Importer version 4 separates shared ID layers.
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

Each file uses layout version 3, with the following logical localization columns (importer version 4):

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
Its versioned target key uses `shared-index-v1:<target>` inside `game-text-v1`. One existing
`SnapshotStore` writer lock publishes a checksummed `index.meta` root atomically. The root contains
the store generation, immutable segment descriptors, independent content-keyed layers and the
active path-to-key mapping. Root JSON is capped at 16 MiB and segments at 4,096. Layers carry the
store generation and segment count on which their IDs depend. Readers retain all layer and segment
handles before returning; an open racing retirement retries against the new root.

All string content shares one u32 ID space, including identical text used across domains. An
append-only `strings-<nonce>.snapshot` contains only new strings, in 256 KiB blocks, allocated
contiguously from the next project-wide ID. First-use domains own storage: source, identity,
`culture.<culture>`, paths and comments. A cross-domain ID reads its owning block; it does not
require another copy. Culture folder recognition includes three-letter and regional/script tags
such as `fil`, `es-419` and `sr-Latn-RS`; names beyond the snapshot domain-name limit use the
generic culture owner. Bulk `domain()` loads physical ownership segments; complete semantic text
searches must also follow cross-domain IDs (native translations can reuse source IDs). Each bulk
result exposes its existing Phase 2 timings and byte buffer.

Content addresses use SHA-256's 32-bit prefix plus exact UTF-8 string equality. A real prefix
collision test proves distinct strings remain distinct. Each segment has sorted 8,192-row hash
pages, a small fence column and a Bloom prefilter (20 bits/string, seven probes). Fingerprints use
unsigned deltas; IDs occupy a parallel compressed u32 page. Append reads bounded matching pages
rather than loading the complete hash index. The decoded page budget is 64 MiB, prefilters 128 MiB
and string blocks 32 MiB; pending new strings flush at 250,000 strings or 64 MiB of accounted
UTF-8/UTF-16/container storage. An initial 8 MiB page budget thrashed in the 1× probe. The stronger
prefilter reduced that probe's one-file hash reads from 714 MB to 11.9 MB.
Same-domain segments are searched first, then other domains for exact cross-domain deduplication.
Segment minimum/maximum UTF-8 lengths reject impossible batches before reading filters. At 10×,
the earlier 16 MiB filter cache repeatedly cleared itself and reread 7.18–11.6 GB/file. The larger
bounded cache evicts individual segments, retaining the filters needed for repeated file strings.

Retained read callbacks live outside segment producer scopes. Keeping a callback beside the
producer closures retained their completed string arrays: the 1× joined rebase sampled 722 MiB of
heap. Moving the callback to the adapter instance reduced sampled heap to 171 MiB (189 MiB
including pre-GC traces). A multiple-segment regression test checks resident heap after releasing
producer arrays.

Localization and joined layers contain no string blocks or per-domain dictionaries. Their logical
string columns are modular u32 deltas with zigzag encoding, independently compressed at zstd 1.
The reader verifies checksums, reconstructs the IDs in place, checks their segment dependency and
retains the decoded columns. Sorting makes adjacent differences small: the measured 1× manifest
shrinks from 1.34 to 0.34 MiB. Plain independent IDs preserve file-cache reuse; manifest-row
references were rejected because they would require validating another layer. Each layer's
`shared.meta` describes its ID columns, encoding and store dependency.
Bounds validation uses indexed typed-array iteration, keeping identical dependency guards:
10× validation falls from 571 to 167 ms and page-column loading from 825 to 453 ms.

For changed files, old/new ID-column comparison records a conservative upper bound on obsolete
string bytes without scanning other layers. Once the bound exceeds both 8 MiB and 25% of total
UTF-8 bytes, the writer takes an exact live-ID census. Only an exact threshold crossing rebuilds
the store; false candidates reset the bound. Explicit `compact(true)` measures the complete
operation even for a one-string change, demonstrating why tiny edits should not trigger it.
Compaction streams live strings once, builds an old-to-new u32 mapping, remaps every active layer,
verifies persisted files, and publishes the new root under the same lock. Content keys stay
unchanged; stale historical keys can be rebuilt. Old readers keep their handles through retirement.
Interruption before the root rename leaves the old generation visible; tests include a killed
compaction child and dead-lock recovery. Retired and interrupted candidates are deleted after a
successful compaction. Temporary disk occupancy includes both generations until publication;
readers' old handles can retain their files' allocation until scope release.

The shared measurement mode reads the retained projects sequentially under the existing heap,
RSS and stage watchdog. `--select cold|projection|compact|reader|refresh` can isolate stages. Cold
build is the sum of separately bounded file stages; it is not a single unbounded target stage. At 1× the
joined projection replays the saved Phase 2 raw sections, without corpus construction or a join.
At 10× it rebases the already-retained Phase 2 synthetic width probe; it remains a format-size
projection, not a semantic 10× join or a real-project compression forecast. The index forecast
must also preserve the declared widths: the saved probe's repeated ID pattern leaves dictionary
variants unreferenced. Compaction prunes 26,085,533 strings / 1.84 GiB UTF-8, so its 883.62 MiB
total cannot establish the 1 GiB forecast target. Keeping all declared widths costs 1,202.12 MiB;
the measured compacted 1× total is 92.36 MiB. The package estimate uses the projected occurrence
and identity/source columns; it charges no second string copy,
and still omits package headers, additional coverage and full origins. Component sizes include
hash pages, prefilters, directories, stat hints and both retained root publications. Total disk
occupancy also includes historical layer files. Reader probes run in fresh children, retain bulk
buffers cumulatively, and use the same hot/page columns and picked native culture as Phase 2.
Native translations borrowed from the already-loaded source domain add no second bulk buffer.
The synthetic 10× projection has separate invented translations, which are explicitly loaded too.
The [shared index measurements](game-text-shared-index-measurements.md) record full component
sizes, per-file cold imports, refresh IO, compaction and the Phase 2 reader comparison.

```powershell
node --import tsx scripts/benchmark-localization-import.ts --project test-results/game-text-scale/project-1x --cache test-results/game-text-scale/shared-final4-1x --output test-results/game-text-scale/shared-final4-1x.json --mode shared
```

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

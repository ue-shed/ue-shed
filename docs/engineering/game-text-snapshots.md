# Game Text snapshots

`@ue-shed/game-text` owns Plan 057's derived package-text, localization and joined-target
snapshots. The pure format is available from both entry points; the Effect Node store and its
source adapter are available from the main entry. Libraries and CLI provide the same layer as
Workbench. This domain storage stays outside the native Catalog and needs no Rust protocol change
or new dependency. Importer and join semantics remain Phases 3–5.

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

Strings are deduplicated separately for source text, identities (line/occurrence IDs and keys/namespaces),
each culture's translations, package/object/property paths and comments/review data. Blocks target 256 KiB of raw bytes,
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

## Measurement

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

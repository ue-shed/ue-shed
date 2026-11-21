# Binary Project Index

The native Project Index uses an immutable binary Catalog owned by `uasset-io`. The parser,
inspection libraries, storage-neutral coordinator, and public protocol are unchanged. Libraries,
CLI, and Workbench use the same adapter; there is no runtime backend selector.

## Format and lifecycle

The disposable cache lives under `catalogs-v10/<project-hash>`. An atomic JSON manifest selects a
base snapshot and, when there is one, a delta snapshot over it, and retains the previous
generation's base and delta. Existing SQLite, DuckDB and older `catalogs-v*` caches are ignored;
the first refresh builds the new format from source. Old cache directories are not deleted or
converted automatically.

Header profile 3 includes raw package flags, gatherable-text summary count/offset, and an exact
`TextProperty` probe over the complete name map. Plain and dictionary header pages expose this
optional evidence as `headerData` using uasset-io minor 9; older minors omit these fields.
Older workers must be upgraded before using candidate pruning. The saved-header scan opts in
with `headerData: true` and exposes the projection in `package.header_data`. These fields
require no payload read, and remain generic inspection evidence rather than Game Text policy.
Profile 3 adds each package's dependencies (see [Package dependencies](#package-dependencies)).

The snapshot contains seven length-delimited sections: compact inventory, shared strings and a
sorted lexicon, posting directory, posting lists, packed header records, a sparse row index, and
tombstones. The row index divides the inventory into chunks of 128 rows and records, for each
chunk, its first row's path, its inventory offset and the checksum of its decoded bytes; then the
ids of the map rows. Integers are little-endian, including the full unsigned file signatures.
Inventory rows also carry a copy of their record's 17-byte header data, so inventory pages read no
records. CRC32 checksums cover every decoded section, every stored section, the header, and
individual records/posting lists. These detect accidental corruption, not malicious changes. The
file magic (`UESHC008`) versions the encoding; incompatible derived evidence is rebuilt.

Every section is zstd-compressed (level 3) as independent 64 KiB blocks behind an index of block end
offsets, so a query decodes only the blocks its postings and record windows touch, and whole
sections compress and decompress their blocks in parallel. A block that does not compress smaller is
stored raw. The header records each section's stored length, decoded length, decoded checksum and
stored checksum, the package, map and shared-string counts, and a checksum of itself. On a local UE
5.7 project with about 11,000 packages compression takes the snapshot from 9.7 MB to 1.9 MB. On a
project of about 800,000 packages a reader's first inventory or map page takes about 5–8 ms and its
first class or serialized-name page 30–45 ms, against 120–165 ms when the whole inventory was
decoded first.

Exact classes and serialized names have postings. Prefix and suffix queries inspect the class
dictionary. Results follow relative-path order and hydrate bounded pages. Readers check the header
and the inventory's row count when opened and retain the physical file, even before their first
query. A query never decodes the whole inventory: it finds a cursor by searching the row index's
paths and decoding the one chunk the cursor falls in, reads map pages from the row index's map
list, and decodes only the chunks holding the rows a page returns (with the neighbouring chunk when
a package's sidecars continue into it), several threads decoding a page's spread-out chunks
together. Each chunk is checked as it is decoded: its checksum, its paths ordered from its
row-index path to before the next chunk's, its map rows against the list, and its record ranges. A
reader keeps the chunks it decoded between queries until it holds 2,048 (about 260,000 rows); past
that a query's end releases them, so paging through a whole inventory never holds it all decoded.
Shared strings and the posting directory are decoded and checked on first use, their checksums,
UTF-8, lexicon order and directory entries checked on several threads; payloads and selected
postings are checked when accessed. Dictionary pages number each distinct class and serialized name
by its shared-string id, copying each string once rather than hashing its text. Refresh and status
opens read every stored byte against the stored checksums (no block is decompressed for it) and
compare the header's counts with the manifest summary. A refresh never holds the committed
inventory decoded: it compares the enumeration with it, and copies its kept rows, as streams a
batch of blocks at a time, and decodes the rest only if it writes a new generation. The walk lists
the project with each directory's path stored once and each file's name beside it, and compares and
orders those paths as their two parts without joining them; a path is built whole only for a
package whose header is read.

Package dependencies have a third posting kind, keyed by the dependency's package name (see
below).

Count requests union up to 16 filters against that same generation. They read checked postings
and inventory IDs without hydrating headers; a package matching several filters counts once.

## Unions and header fields

A `union` query (uasset-io v1.27) pages the packages any of up to 16 header filters matches, each
once, in path order. It selects the postings of every filter into one set and merges their rows
as a single filter does, so base and delta segments, hidden rows, cursors and page bounds behave
exactly as for one filter. A host that needs several filters makes one pass instead of one query
per filter followed by a merge.

Header queries take `fields`, the header fields each item carries. A field left out is never
copied from a record, never given a page string and never serialized: `classes` alone sends no
serialized names, and `matchedSerializedNames` keeps only the names the query's serialized-name
filters ask for, so a host still learns which packages matched a name. Records are still read
and checked whole; only what the page carries changes. Without `fields` a page is unchanged.
`MemoryCatalog` projects the same way, and the mutation sequence compares unions and projections
with it on every page, plain and dictionary, across bases, deltas and compaction.

A page's records sit in compressed blocks spread over the records section. A page groups its
record windows into batches of up to 64 distinct blocks (4 MiB decoded), reads each batch's
blocks with one read per run of blocks stored back to back, and decodes them on several threads.
Nothing is kept between queries.

On the TypeScript side a dictionary page frame is validated once. A hand-written walk applies
the frame's exact wire rules (exact keys, trimmed non-empty strings, safe non-negative integers,
list bounds) and falls back to the schema for any frame it does not accept, so invalid frames are
reported as before. Expansion then checks only the domain bounds the wire leaves open (path,
string, cursor, signature and failure lengths) and the references, in the same pass that
resolves them, instead of walking the page through a second schema. Both are tested against the
schemas they replace on mutated and generated pages.

On a project of about 800,000 packages, the benchmark's five queries (maps, four header filters;
23,006 header packages, 17.1 MB of frames) went from 411 ms to 213 ms warm with the same pages and
bytes. Asking the same filters as one union with `classes` and `matchedSerializedNames` takes
171 ms and 6.8 MB, folds in 26 ms instead of 99 ms, and holds about 200 MiB of Node memory instead
of about 290 MiB, with the same DataTable, StringTable, `TextProperty`, texture and Enhanced Input
packages and classes. The query worker's peak memory is unchanged.

A sibling OS file lock excludes other writers and survives quarantine/clear operations. Readers
do not take that lock. Process termination releases it. A second writer receives a typed unavailable
error rather than publishing from stale state. Native IO now requires Rust 1.89 for standard file
locking; parsing and inspection retain their existing Rust requirement.

A warm no-op publishes generation metadata while reusing the physical snapshots with no evidence
writes and without decoding anything beyond the inventory. New files are synced and reread against
their stored checksums before manifest publication.

## Base and delta snapshots

A small refresh writes only a delta. A delta is a complete snapshot of its own (rows, strings,
postings, records and row index) holding every entry the generation added or replaced since the
base, and its tombstones section names the base rows the generation no longer holds (removed or
replaced), with the fingerprint of the base header it belongs to and how many packages and maps it
hides. Readers merge the base's live rows with the delta's in path order; the two never share a
path. Inventory, map and posting pages, cursors, counts, bundle signatures (a package's sidecars
may sit in the other snapshot), dictionary pages (a string in both snapshots is carried once) and
dependency walks all read the merged generation. Status and writer opens check the delta against
its base and the summary's counts against both.

Each delta replaces the previous one: it carries the previous delta's surviving rows (their
records copied as stored, its strings kept with their ids) and the refresh's changes. A refresh
writes a delta while the delta's entries plus the base rows it hides stay within 16,384 and 5% of
the base, with the same mount points, and while the delta carries at most 262,144 strings;
otherwise it compacts into a new base, copying the base's live records and remapping the delta's
into the base's strings. A rebuild always writes a base. A changed refresh that writes a base
copies unchanged packed records block by block and derives every posting list from the records
written, so committed postings are never read. On a project of about 800,000 packages a one-file
edit writes a delta of a few kilobytes instead of a 185 MB base.

A writer finds base rows by path or id through the row index, decoding only the stretch of
inventory it needs, so a delta commit and a targeted refresh never decode the whole base
inventory. The writer open still reads every stored byte of both snapshots against their stored
checksums.

## Inventory digest

Each complete summary carries `inventoryDigest`, a SHA-256 over every inventory fact: each
package's path, its bundle stamps (its own and its `.uexp`, `.ubulk` and `.uptnl` size and modified
time) and its 17-byte header data. Each package contributes a leaf (the SHA-256 of its facts);
leaves are summed as 256-bit integers, and the digest is the SHA-256 of the package count and the
sum. The manifest keeps the sum, so a delta commit subtracts the old leaves of the bundles it
touched and adds the new ones instead of reading every package, and a base commit sums its leaves
as it writes its rows. The digest depends only on the facts: a fresh build, a warm no-op, deltas,
compaction and a rebuild of the same files give the same digest. A partial summary has none.

## Targeted refresh

A refresh may name the files that changed (`changedPaths`, as an operating system file watcher
reports them). It then lists only those files' directories, compares only their bundles (a package
and its sidecars, whatever case its extensions use) with the committed entries, reads only the
changed packages' headers, and commits as a delta; the result, change report and digest are what a
full walk would give. It walks instead when it cannot be sure of that: no committed generation, a
partial one (only a walk rereads header failures), evidence from an older index profile, changed
mount points, more than 4,096 paths, a path that may be a directory, a `.uproject` or `.uplugin`, a
path in another case than the content root or a directory on the way to it, or a plugin path in a
plugin-inclusive index. The summary metrics say which (`targeted`, `walked_because`).

## Change journal refresh

A refresh told nothing (no `changedPaths`) reads the volume's change journal instead of walking,
where there is one. The manifest keeps the journal position each generation's content roots were
listed at (`change_journal`: each root's final path, volume and file id, and each volume's journal
id and next position), taken before the walk or the read, so anything that changes while the roots
are listed is read next time. A refresh given `changedPaths` keeps the committed position, which
still covers everything it did not look at.

The journal is read with `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` (`crates/fast-fs`), which needs no
administrator rights but leaves names out of its records: each names the changed file and its
parent directory by id. Each parent is opened by id and kept when its final path lies below a
content root, so the refresh learns which directories changed, not which files. It lists those
directories as the walk would and compares every bundle they hold now or held in the committed
generation, then continues as a targeted refresh: the same result, change report and digest as a
walk. A directory renamed, moved or deleted below a root falls back to a walk (its entries went
with it), as does a parent that is gone with no record of where it was, a changed content root (a
retargeted junction, a plugin root added or removed), a replaced or wrapped journal, more than
16,384 directories to resolve or 4,096 changed, and every reason a targeted refresh walks;
`walked_because` names it and `journal` says when the journal was used. A directory this user
cannot open counts as outside the roots: listing the roots could not enter it either. Other
platforms and file systems keep no journal, so their refreshes walk (`usn_unsupported`).

Probes that did not pay for themselves: listing directories with `FindFirstFileExW`
(`FindExInfoBasic`, with or without `FIND_FIRST_EX_LARGE_FETCH`) or `NtQueryDirectoryFile` on
handles opened relative to their parent measured the same as `std::fs::read_dir` (the per
directory open, query and close cost the same; the large fetch buffer was slower), and opening
packages relative to a directory handle with `NtCreateFile` was about 7% slower than `File::open`
with whole paths at 24 header workers.

Header workers encode records as they read them. Each keeps its own string dictionary and writes
records with its own string ids, sending with each record the strings it first met there; staging
gives those strings their shared ids in staging order and rewrites the record's ids. Shared ids
therefore follow first use in path order, as if one thread had encoded every record, whichever
worker read which package. A worker's records reach staging in the order it encoded them, including
records a reread replaces, which are released rather than staged.

The refresh coordinator stages entries in path order once it has recorded the unchanged ones, so
the next generation is written as entries arrive: inventory rows and records are compressed a
batch at a time, unchanged rows are copied in between, and each record's posting keys are counted.
At commit the posting lists are placed in one flat array from those counts in one pass over the
written records, while the shared strings encode beside it; sections are then written behind a
placeholder header, the posting lists streamed as they compress, and the header written last.
Neither the inventory, the records nor the posting lists are held whole. Entries staged outside
path order (adapter tests do this) are buffered and sorted at commit instead, and a path staged
again keeps its last record. Shared strings keep their ids across generations; a refresh that adds
none copies the committed strings section as stored. Persisted ordering and encoding are
deterministic and do not depend on how entries were staged.

Interrupted unpublished files are removed on successful subsequent publication; writer opens also
clean retired snapshots (bases and deltas the manifest no longer names) when a committed manifest
exists. Invalid manifests or damaged snapshots
are quarantined by writers and rebuilt. Query opens report errors without mutating the cache.
An error during atomic manifest publication preserves the candidate snapshot and requires reopening
the writer: rename may have succeeded before a later sync error. Cleanup owns a filename only after
exclusive creation succeeds, so a collision cannot delete an existing snapshot.
Windows recovery can move files individually into quarantine when an open reader prevents a
directory rename. An interrupted partial quarantine is recoverable on the next writer open.

## Package dependencies

Each header record carries its package's dependencies as Unreal's Asset Registry records them:
the package name as a string ID plus one byte of `EDependencyProperty` bits (`hard` 1, `game` 2,
`build` 4). The parser follows UE 5.8 `LoadDependenciesFromPackageHeader`: imports are hard, and
game when the import is used in game; soft package references are game per their bit; extra build
dependencies are build. Like the Asset Registry, it drops the hard edges on `/Script/CoreUObject`,
`/Script/Engine`, `/Script/BlueprintGraph` and `/Script/UnrealEd`, drops self-references, merges
names case-insensitively, and treats an external actor's edges to its own world as editor-only.

Dependency postings map each dependency name to the packages that reference it, so a dependents
walk reads postings instead of headers. The lexicon sorts by ASCII-folded text, then by bytes, so
every casing of a name is one contiguous range and a lookup ignores case as Unreal's `FName` does.

Names resolve to indexed packages through the mount table that the manifest summary records for
the generation: `/Game/` maps to `Content/`, and a plugin-inclusive catalog adds each content
plugin's `/<Name>/` mount. The longest mount wins, then `.uasset` before `.umap`, matching paths
case-insensitively. A name that resolves to no indexed package (script packages, engine content,
plugins outside the catalog, packages not on disk) is returned without a `packagePath`.

A forward walk reads the records of the requested paths and follows resolved targets. A reverse
walk turns paths into names (so it works for packages deleted since the refresh) and follows the
dependency postings one level at a time, reading each level's posting lists in stored order. It
reads referrers' records only when an edge filter needs their properties. The `classes` filter
reads the exact-class postings; it selects results and does not narrow the walk. Names resolve to
exact paths first, and only a miss builds the case-insensitive path index.

Pages recompute the walk from the generation and continue after the cursor path, so a page costs
the whole walk. A page also ends early, with a cursor, before its distinct strings would exceed
the dictionary page bound (131,072). A package records at most 65,504 dependencies, so one package
always fits; a package with more records the header failure `dependencies_over_limit`. On a project of about 700,000 packages, a reverse walk reaching 97,000 packages
takes about 0.4 s per page beyond opening the catalog (0.2 s with `classes`, 0.5 s with an edge
filter), and a 20-root transitive forward walk about 0.3 s. On the same project, dependencies add
about 3–10% to a full build with a warm file cache, about 200 MB to its peak memory, about 0.3 s to
an unchanged refresh, and 5% to the snapshot (160 MB).

Plugin content is opt-in. `plugins: true` discovers plugins under `Plugins/` as Unreal's
`FindPluginsInDirectory` does (skip `Content` directories, take the first `.uplugin` in a directory
and stop descending, mount only descriptors with `CanContainContent`). It builds a separate catalog
whose identity is the project root plus `#plugins`, so a plugin-inclusive refresh never replaces
the content-only generation other callers rely on.

Known gaps: the walk does not apply `CoreRedirects` or package relocation, it mounts every content
plugin whether or not the project enables it, it does not read `AdditionalPluginDirectories`, and
names fold ASCII case only.

A refresh that asks for `changes` lists the paths whose signature differs from the base generation
(new or changed, sidecars included) and the paths it removed, up to 65,536 in total or the
request's `maximumChanges` (at most 1,048,576). Past that it sets `complete: false`, lists none and
counts them in `total`, and the caller should treat the change set as unknown. Re-reading headers
for a new profile is not a change on disk. A rebuild, or the first refresh of a new catalog, has no
base generation, and every path counts as changed.

## Bounds and tradeoffs

The manifest is capped at 1 MiB and each binary section at 512 MiB. Decoders validate lengths,
counts, IDs, ordering, UTF-8, and booleans before use. These are implementation limits, not an
unbounded storage promise. Builds retain staging and indexes in memory. Unused dictionary strings
remain until the next base is written. Open handles can delay physical storage reclamation.

The hardening measurements show faster fresh builds and query workloads, approximately tied warm
refresh, and smaller caches. Single-package repair and short-lived catalog opens remain slower
than SQLite. See [the measured report](../research/custom-catalog-hardening-2026-09-05.md) for
separate timings and memory observations. The parser was not optimized in this change.

## Validation and dependencies

No build or test compiles a database engine. The runtime crates are pinned
`crc32fast` 1.5.0 (MIT OR Apache-2.0) and `zstd` 0.13 (MIT, already used by the Game Text index);
the existing atomic manifest helper remains in use.

```sh
cargo test --locked -p uasset-io --all-targets
cargo tree --locked -p uasset-io -e normal
```

The architecture gate verifies that the native dependency tree has no database engine.

Tests cover deterministic mutations diffed against the in-memory reference Catalog on every query
kind, page size, count and dependency walk through a base, many deltas, compaction and further
deltas (walked and targeted refreshes side by side), every conformance scenario run again with
deltas forced, unsigned signatures, damaged
files, impossible counts, bounded manifests, failed write/sync checkpoints, writer exclusion,
quarantine, old readers, and process termination at six publication boundaries. Process-kill tests
do not simulate a machine power failure or establish a long-duration durability soak.

The current published native npm artifact supports Windows x64 only. Its packed consumer is tested
with the fixture and an empty PATH; Linux native tests also run. macOS execution and hosted runner
timings are not established by local Windows/WSL results.

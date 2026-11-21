# Binary Project Index

The native Project Index uses an immutable binary Catalog owned by `uasset-io`. The parser,
inspection libraries, storage-neutral coordinator, and public protocol are unchanged. Libraries,
CLI, and Workbench use the same adapter; there is no runtime backend selector.

## Format and lifecycle

The disposable cache lives under `catalogs-v8/<project-hash>`. An atomic JSON manifest selects a
physical snapshot and retains the previous snapshot. Existing SQLite, DuckDB and older `catalogs-v*`
caches are ignored; the first refresh builds the new format from source. Old cache directories are
not deleted or converted automatically.

Header profile 3 includes raw package flags, gatherable-text summary count/offset, and an exact
`TextProperty` probe over the complete name map. Plain and dictionary header pages expose this
optional evidence as `headerData` using uasset-io minor 9; older minors omit these fields.
Older workers must be upgraded before using candidate pruning. The saved-header scan opts in
with `headerData: true` and exposes the projection in `package.header_data`. These fields
require no payload read, and remain generic inspection evidence rather than Game Text policy.
Profile 3 adds each package's dependencies (see [Package dependencies](#package-dependencies)).

The snapshot contains five length-delimited sections: compact inventory, shared strings and a
sorted lexicon, posting directory, posting lists, and packed header records. Integers are
little-endian, including the full unsigned file signatures. Inventory rows also carry a copy of
their record's 17-byte header data, so inventory pages read no records. CRC32 checksums cover every
decoded section, every stored section, the header, and individual records/posting lists. These
detect accidental corruption, not malicious changes. The file magic (`UESHC006`) versions the
encoding; incompatible derived evidence is rebuilt.

Every section is zstd-compressed (level 3) as independent 64 KiB blocks behind an index of block end
offsets, so a query decodes only the blocks its postings and record windows touch, and whole
sections compress and decompress their blocks in parallel. A block that does not compress smaller is
stored raw. The header records each section's stored length, decoded length, decoded checksum and
stored checksum, the package, map and shared-string counts, and a checksum of itself. On a local UE
5.7 project with about 11,000 packages compression takes the snapshot from 9.7 MB to 1.9 MB.

Exact classes and serialized names have postings. Prefix and suffix queries inspect the class
dictionary. Results follow relative-path order and hydrate bounded pages. Readers check the header
and the inventory's row count when opened and retain the physical file, even before their first
query. The inventory, shared strings and posting directory are decoded and checked on first use;
payloads and selected postings are checked when accessed. Dictionary pages number each distinct
class and serialized name by its shared-string id, copying each string once rather than hashing its
text. Refresh and status opens read every stored byte against the stored checksums (no block is
decompressed for it) and compare the header's counts with the manifest summary. A refresh never
holds the committed inventory decoded: it compares the enumeration with it, and copies its kept
rows, as streams a batch of blocks at a time, and decodes the rest only if it writes a new
generation.

Package dependencies have a third posting kind, keyed by the dependency's package name (see
below).

Count requests union up to 16 filters against that same generation. They read checked postings
and inventory IDs without hydrating headers; a package matching several filters counts once.

A sibling OS file lock excludes other writers and survives quarantine/clear operations. Readers
do not take that lock. Process termination releases it. A second writer receives a typed unavailable
error rather than publishing from stale state. Native IO now requires Rust 1.89 for standard file
locking; parsing and inspection retain their existing Rust requirement.

A warm no-op publishes generation metadata while reusing the physical snapshot with no evidence
writes and without decoding anything beyond the inventory. Changed refreshes copy unchanged packed
records block by block and derive every posting list from the records written, so committed
postings are never read. They still write a complete new physical file; this is not an append log
or an in-place update format. New files are synced and reread against their stored checksums
before manifest publication.

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
clean retired snapshots when a committed manifest exists. Invalid manifests or damaged snapshots
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
remain until a full rebuild. Open handles can delay physical storage reclamation.

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
kind, page size, count and dependency walk, unsigned signatures, damaged
files, impossible counts, bounded manifests, failed write/sync checkpoints, writer exclusion,
quarantine, old readers, and process termination at six publication boundaries. Process-kill tests
do not simulate a machine power failure or establish a long-duration durability soak.

The current published native npm artifact supports Windows x64 only. Its packed consumer is tested
with the fixture and an empty PATH; Linux native tests also run. macOS execution and hosted runner
timings are not established by local Windows/WSL results.

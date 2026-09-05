# Binary Project Index

The native Project Index uses an immutable binary Catalog owned by `uasset-io`. The parser,
inspection libraries, storage-neutral coordinator, and public protocol are unchanged. Libraries,
CLI, and Workbench use the same adapter; there is no runtime backend selector.

## Format and lifecycle

The disposable cache lives under `catalogs-v4/<project-hash>`. An atomic JSON manifest selects a
physical snapshot and retains the previous snapshot. Existing SQLite and DuckDB caches are ignored;
the first refresh builds the new format from source. Old cache directories are not deleted or
converted automatically.

The snapshot contains five length-delimited sections: compact inventory, shared strings and a
sorted lexicon, posting directory, posting lists, and packed header records. Integers are
little-endian, including the full unsigned file signatures. CRC32 checksums cover every section
and individual records/posting lists. These detect accidental corruption, not malicious changes.
The file magic versions the encoding; incompatible derived evidence is rebuilt.

Exact classes and serialized names have postings. Prefix and suffix queries inspect the class
dictionary. Results follow relative-path order and hydrate bounded pages. Readers load metadata
when opened and retain the physical file, even before their first query. Payloads and selected
postings are checked when accessed. Refresh opens verify all section checksums and summary counts.

A sibling OS file lock excludes other writers and survives quarantine/clear operations. Readers
do not take that lock. Process termination releases it. A second writer receives a typed unavailable
error rather than publishing from stale state. Native IO now requires Rust 1.89 for standard file
locking; parsing and inspection retain their existing Rust requirement.

A warm no-op publishes generation metadata while reusing the physical snapshot with no evidence
writes. Changed refreshes reuse unchanged packed bytes and remap existing postings, adding/removing
only affected memberships. They still write a complete new physical file; this is not an append
log or an in-place update format. New files are synced and verified before manifest publication.

Interrupted unpublished files are removed on successful subsequent publication; writer opens also
clean retired snapshots when a committed manifest exists. Invalid manifests or damaged snapshots
are quarantined by writers and rebuilt. Query opens report errors without mutating the cache.
An error during atomic manifest publication preserves the candidate snapshot and requires reopening
the writer: rename may have succeeded before a later sync error. Cleanup owns a filename only after
exclusive creation succeeds, so a collision cannot delete an existing snapshot.
Windows recovery can move files individually into quarantine when an open reader prevents a
directory rename. An interrupted partial quarantine is recoverable on the next writer open.

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

Normal builds and tests do not compile a database engine. The only new runtime crate is pinned
`crc32fast` 1.5.0 (MIT OR Apache-2.0); the existing atomic manifest helper remains in use.

```sh
cargo test --locked -p uasset-io --all-targets
cargo test --locked -p uasset-io --all-targets --features catalog-oracle
cargo tree --locked -p uasset-io -e normal
```

`catalog-oracle` enables SQLite only for adapter and differential tests. Depot runs it in a separate
conditional job so normal IO checks and release builds do not inherit the database build. The
architecture gate verifies the default dependency tree and test-only module boundary.

Tests cover deterministic SQLite differential mutations and paging, unsigned signatures, damaged
files, impossible counts, bounded manifests, failed write/sync checkpoints, writer exclusion,
quarantine, old readers, and process termination at six publication boundaries. Process-kill tests
do not simulate a machine power failure or establish a long-duration durability soak.

The current published native npm artifact supports Windows x64 only. Its packed consumer is tested
with the fixture and an empty PATH; Linux native tests also run. macOS execution and hosted Depot
timings are not established by local Windows/WSL results.

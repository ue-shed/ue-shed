# Game Text publication and query preparation (2026-11-01)

The native publication/preparation changes reduce a fresh backend Game Text build on top of
parser-speed PR #196 (`4ba9ee1dbb7353887db52a61ee3638e6e8f517ec`). Both complete all-language CSV exports
and starter localization check reports are byte-identical on the two private, read-only corpora.
The projects and their contents are not fixtures or product defaults.

| Input          | Scope                   | #196 baseline median | Final median | Wall saving |
| -------------- | ----------------------- | -------------------: | -----------: | ----------: |
| UE 4.27 corpus | Catalog ready, n=5      |             30.421 s |     29.021 s |        4.6% |
| UE 4.27 corpus | First-ever catalog, n=3 |             35.626 s |     33.640 s |        5.6% |
| UE 5.7 corpus  | Catalog ready, n=5      |              3.025 s |      2.928 s |        3.2% |
| UE 5.7 corpus  | First-ever catalog, n=3 |              3.408 s |      3.263 s |        4.3% |

## Measurement boundary

The build measurement runs the headless configured refresh, selects its localization target and
fetches the first workspace page. It excludes shell project selection, the shell's earlier refresh
and renderer work. The normal Workbench path has a ready shared catalog; its status check is still
inside the build. First-ever catalog creation is a separate measured mode. Both start with an empty
Game Text application cache. Operating-system file caches are uncontrolled.

Each pair uses the same Node 26.13.0 host, separate immutable release readers and identical inputs.
Baseline/final order alternates by pair. No build, test or second project scan runs concurrently.
This Windows 11 x64 machine has a Ryzen 9 5950X, 64 GiB RAM and 16 Rayon threads. Builds use the normal
fat-LTO release profile. These are Windows measurements, not a Linux performance claim. RSS is the
sampled peak of the process tree; its variation does not establish the cause of a memory change.

The [sanitized data](game-text-publication-2026-11-01.json) retains every final sample, ranges, sampled
RSS, answer hashes and release reader/source-patch hashes. It includes one fresh-process sample per
variant/corpus for unchanged refresh, open, full CSV export and localization checks. Those operations
provide regression evidence, not precise speed claims. Extra native timing runs are excluded from
the headline samples because that instrumentation has measurable overhead.

## Retained changes

- **Transient string lookup:** use the existing Fx hasher for the byte-to-shared-ID map. IDs still
  follow sorted byte/domain order; hash iteration does not assign them. Optional coarse timers split
  dictionary loading, lookup building, missing strings, encoding, insertion and final ID mapping.
- **Dictionary frames:** batch at most 4 MiB of raw frame contents for parallel compression. An
  oversized frame runs alone. Compression levels, frame boundaries and section order stay unchanged.
  A scalar-versus-parallel test compares complete snapshot bytes, including oversized-frame behavior.
- **Sorted-run merge:** replace the heap head once and move the unique key rather than clone it.
  The diagnostic merge interval fell from about 3.70 to 3.18 seconds. Existing cross-run-size and
  thread-count byte equivalence also covers empty and Unicode strings.
- **Query preparation:** construct raw and sliced projections independently, retain the longest
  string's character count, and prepare the target prefix once. Diagnostic entry preparation fell
  from about 1.09 to 0.63 seconds, with process CPU in the interval falling from 2.17 to 1.61 seconds.
  Translation indexing then limits the parallel group, so the total benefit is smaller.

The composition is the performance result. The small preliminary ablations do not establish an
independent percentage gain for every retained change. The cold localization merge already overlaps
package extraction; nested/parallel wall spans and process CPU intervals cannot be added to the
full-scan wall time. See [the earlier dependency analysis](../engineering/game-text-scan-phase-4-5.md).

## Rejected or bounded designs

**Dictionary materialization from the lookup:** passed shared-ID/WTF-8 parity tests, but did not
reduce dictionary load time in joining and slowed the large full scan. Removed. A copying/allocation
explanation is plausible but was not isolated experimentally.

**Prepared immutable layer read cache:** a 64 MiB writer-session prototype passed 198 native tests,
including overflow/abandonment refunds, byte equality with disk, pinned readers after clear and
compaction remapping. The diagnostic join-load interval fell from 0.651 to 0.555 seconds (185 cache
hits, 349 misses), without an established full-scan benefit. Removed along with its lifecycle code.
It reused bytes only after successful persistence and verification; it did not overlap publication.

**Redo WAL or commit batching:** the existing immutable files, verification and atomic manifest
switch already provide coherent publication. The root commit is roughly 6 ms, about 0.02% of a
30-second scan. A new journal cannot remove sorting, global-ID assignment or query construction, so
an alternative journal was ruled out by attribution rather than implemented.

**Deeper publish/join overlap:** joining needs finalized global IDs. Only about 0.4–0.7 seconds of
late package encoding/writing remains eligible to overlap with the current join algorithm. This is
an optimistic bound, not a benchmark result. A compound asynchronous generation API would add pending
writer, cancellation and recovery semantics. That protocol was not implemented after the bounded
read-view trial failed to justify its extra machinery. The atomic publication path is unchanged.

Snapshots are persistent query columns, not presentation objects. Commands still have one serialized
writer; immutable preparation and encoding run in parallel inside the commands. Readers retain their
generation pins, and failed/cancelled work still follows the existing cleanup and recovery paths.

## Reproduction and checks

The explicit benchmark lane exposed an old harness assertion: it expected one dictionary lookup
after a one-byte PO edit, while both #196 and this checkpoint reported 134. The native importer
probes changed blocks; the separate localization import test checks its reuse bound and every
refreshed entry. The harness now checks one parsed file and nonzero fresh dictionary work, keeping
its cached-edit rejection and original-byte restoration assertions. No production importer change
was needed.

Build each revision with `cargo build --locked --release -p uasset-io --bin uasset`, preserve its reader
under a distinct filename, and point `UE_SHED_UASSET_EXECUTABLE` at it for each invocation. Use the
same host source and `RAYON_NUM_THREADS=16` for both. For a private project supplied by the caller:

```powershell
pnpm benchmark:game-text-engine --project $project --output $output --runs 1 --long-runs 1 --stages build --project-index-cache $catalog
```

Prewarm the shared catalog outside timing. For a first-ever catalog run, replace
`--project-index-cache $catalog` with `--cold-project-index`. Use a new output/cache directory for
every build. For behavioral evidence, request `--stages build,cached-reopen,open,lines-export,loc-check`
and hash the actual `lines.csv` and `report.json` files, not just the benchmark's row-count sample.
The check uses the same explicit starter rules on both revisions. Do not put private exports in Git.

The verification set for this checkpoint is `pnpm check` on Node 26, the complete Node test suite on
Node 24, `pnpm test:game-text:fuzz --native` with 2,000 TypeScript and 100 native seeds, the Game Text
scale/soak/benchmark lanes, all-target GNU Windows-layout Clippy, and
`pnpm test:uasset-engine-matrix` with separate UE 5.7 and UE 5.8 retained fixture inputs. The engine
matrix regenerates source models against installed headers and compares the retained engine-saved
bytes with their oracle evidence; it does not regenerate private project assets. Full logs, input
metadata fingerprints and experimental binaries/patches remain in the local artifact directory.

# Game Text scan work: streaming and preparation (2026-11-02)

The retained changes reduce discarded projection work, native diagnostic-string allocation and
query preparation. Two streaming designs were implemented, verified and removed after separate
controls failed to establish enough additional benefit. The ordinary rich parser model, output
contracts, shared-string IDs, query results and snapshot format remain stable.

This follows [publication preparation](game-text-publication-2026-11-01.md), PR #197. The baseline is
its exact head, `36a90bb7151970275e3cf79b75c9b7cc9175c522`. The
[sanitized measurements](game-text-scan-work-2026-11-02.json) contain the raw samples, separate trial
cohorts, binary/source fingerprints, complete-output fingerprints and fixed-list parser evidence.
Private content, paths and raw output files stay outside the repository.

## Full-build measurements

| Workload       | Catalog                     | #197 median | Retained median | Reduction |
| -------------- | --------------------------- | ----------: | --------------: | --------: |
| UE 4.27 corpus | Ready catalog, 5 pairs      |    29.165 s |        27.257 s |      6.5% |
| UE 4.27 corpus | First-ever catalog, 3 pairs |    34.047 s |        31.804 s |      6.6% |
| UE 5.7 corpus  | Ready catalog, 5 pairs      |     2.900 s |         2.796 s |      3.6% |
| UE 5.7 corpus  | First-ever catalog, 3 pairs |     3.246 s |         3.134 s |      3.5% |

The Windows 11 x64 host uses a Ryzen 9 5950X, 64 GiB, Node 26.13.0 and 16 Rayon workers.
Readers are immutable normal release builds: Rust 1.98.1, fat LTO, one codegen unit. Each pair
alternates order; no builds, tests or other full-project scans run alongside a measured scan.
Operating-system file caches are uncontrolled. The corpora have different workloads, so this is
not an Unreal-version comparison. RSS is recorded, with no overall memory-reduction guarantee.

The timed operation is the headless configured refresh, localization-target selection and first
workspace page. Ready-catalog creation happens outside that timer; first-ever mode creates an
empty catalog inside it. Both use a fresh Game Text application cache. Shell project selection,
the shell's preceding refresh and rendering are excluded. Unchanged refresh, reopen, complete CSV
and localization checks are recorded separately and excluded from the headline.

The 50.893 s large-corpus first-ever baseline sample includes 20.829 s of catalog refresh, versus
4.451–4.561 s in the other two baseline samples. All samples, including this outlier, enter the
reported ranges and medians.

## Streaming was tested first

| Trial                                     | Decision | UE 4.27 control → trial | UE 5.7 control → trial |
| ----------------------------------------- | -------- | ----------------------: | ---------------------: |
| Broad property/pin streaming              | Reject   |       28.369 → 28.282 s |        2.874 → 2.852 s |
| Pin-only streaming                        | Reject   |       28.844 → 28.966 s |        2.879 → 2.876 s |
| Deferred pin diagnostic paths             | Keep     |       28.783 → 27.686 s |        2.883 → 2.842 s |
| Query preparation and zero-result pruning | Keep     |       28.069 → 27.100 s |        2.854 → 2.814 s |

Each row has its own three alternating pairs. Streaming controls already contain the inexpensive
discarded-property shortcut. The initial streaming-plus-shortcut improvement therefore cannot be
attributed to streaming alone. Broad streaming was slower in the large corpus's extraction stage
than that control; pin-only streaming also failed to establish a dependable gain.

The broad visitor consumed completed root properties and pins, retained decoder-owned reads and
Blueprint identity, and discarded provisional facts on export errors. Nested values still used
ordinary codecs within one root property. The narrower trial consumed only graph pins. Both
matched all 141 saved fixture packages in forward and reverse export order (34,812 successful
export comparisons), including occurrences, gaps, ordering, classes and error messages. Deliberate
late truncations did not leak provisional text or poison later replay. Those experimental APIs,
implementations and tests were removed; their patches and readers remain in the local experiment
archive. A fully recursive event decoder was not implemented or ruled out.

## Retained implementation

- Text projection skips omitted values, scalar native fields and empty containers before building
  paths that cannot produce occurrences or coverage gaps. Unsupported/raw evidence remains visited.
- Native pin and saved-FText readers defer 71 eager diagnostic formatting sites through borrowed
  `Display` paths. Recursive text histories use a trait-object boundary to bound monomorphization.
  Every read, version gate, resource bound and failure message retains its existing behavior.
- Immutable normalized path columns prepare beside query columns. Final folder and asset labels
  reuse derived facts in their original encounter order, preserving IDs, ranks and column order.
- Trigram construction tracks touched keys, sorts them, and resets only those entries between
  sizing and writing. Dense tables remain allocated; there is no sparse-map or paging claim.
- Resolved unit strings are formatted once per identity tuple and referenced through an indexed
  pool. Unresolved unit formatting and semantic occurrence/group membership remain unchanged.
- Numeric columns hash directly into transient Fx equality buckets, avoiding an encoded byte
  buffer solely for hashing. Full vector equality still proves aliases. Persisted CRC integrity
  checks remain unchanged. A separate five-sample component benchmark compared encoded CRC,
  borrowed CRC and Fx at several column lengths; Fx was fastest at every tested length here.

The four query ideas and additional zero-result projection pruning were measured as a combination;
no independent whole-scan percentage is claimed for each. Parallel tasks share immutable inputs,
produce separate owned columns and finish before publication. Existing worker controls, atomic
manifest publication, generation pins, cancellation and recovery stay on their established path.

## Output and input evidence

Both complete all-language CSV exports and complete starter localization check reports match in
bytes and SHA-256 on both corpora. All 22/6 dictionary files match completely, preserving shared IDs.
All 12,068/11,624 active encoded data sections match in bytes and order (989/128 MB raw).
Metadata comparison normalizes only physical filenames/sizes, generation nonces and the joined key
derived from a generation. All remaining metadata, section ordering and non-joined input keys match.
The input metadata fingerprints are unchanged across 196,323 project files.

The separate single-thread allocation harness compares unfiltered fixed lists and the UE 5.8
fixture. Its complete text and generic-inspection digests match exactly. Its counting-allocator
measurements are not elapsed Game Text scan time. Host phase durations and diagnostic checkpoint
work can overlap and must not be added together.

## Verification commands

- `pnpm check` on Node 26 and the complete Node suite on Node 24.
- Native Game Text and inspection tests, parser tests and all-target Clippy.
- `pnpm test:game-text:fuzz --native` with 2,000 TypeScript and 100 native seeds.
- Game Text scale, lifecycle soak and benchmark lanes; the benchmark lane also runs on Node 24.
- GNU Windows-layout all-target Clippy.
- `pnpm test:uasset-engine-matrix` against UE 5.7 and UE 5.8 retained fixture projects, including
  fresh verification and native/WASM/saved-review parity. Retained mode skips legacy 4.27/5.3
  regeneration; saved legacy fixture audits remain part of the portable checks.

No release, merge or authored project-content write is part of this experiment.

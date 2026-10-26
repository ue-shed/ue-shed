# Game Text cold scan, Plan 059 Phase 4.5

Phase 4 moved the query engine to one session with column batches, sinks and prompt
cancellation. This phase applies what it taught to the cold scan that builds the index: keep the
stages that can run at once running at once, keep every core busy where the work is parallel, and
keep the answers byte-identical. [The attribution](game-text-scan-attribution.md) is the
evidence; every decision below cites it.

## 1. What a cold scan costs today

Released 10-culture project, one traced cold build (about 112 s). The stages run one after
another, in this order:

| Stage                |      Wall | Where the time goes                                                                            |
| -------------------- | --------: | ---------------------------------------------------------------------------------------------- |
| Package inventory    |   9.7 s\* | \*A cold project index the Workbench never pays; it pays status and pages, 3.7 s.              |
| Localization parse   |    15.5 s | 8 TS workers, 97 s busy: `builder.feed` 51 s, string runs 28 s, snapshot write 9 s.            |
| Localization publish | 13.5–16 s | Native, 1.2 cores: read and sort runs 5.1 s, merge 2.9 s, remap and encode 4.3 s.              |
| Package extraction   |    37.4 s | 208 s CPU on 5.6 cores. 8 workers wait 84 s for jobs behind the coordinator's 20 s of staging. |
| Bundle verification  |     6.1 s | `stat` of every package and sidecar, before and after extraction.                              |
| Package prepare      |     5.5 s | TS workers convert, validate, sort and write shard snapshots.                                  |
| Package publish      |     7.8 s | Native: string interning and mapping 6.0 s on one core.                                        |
| Join                 |    15.6 s | Native, 1.7 cores: a dozen serial steps of 0.4–1.8 s; only query columns run in parallel.      |
| Open and first page  |     2.0 s | Engine.                                                                                        |

The generated 1× project (69 s) has no extraction; its localization parse is 12.7 s, publish
9.4 s, package publish 12.9 s (interning 11.2 s) and join 16.3 s.

Cancellation already works: every interrupt returns in under 0.3 s and every child is gone
within 2.8 s. The process-tree peak is 4.4 GiB, driven by the reader's 3.3 GiB during
extraction; Node peaks at 2.2 GiB while parsing localization files and the writer at 2.2 GiB in
the join.

## 2. Decisions

1. **Measure what the Workbench pays.** The engine benchmark builds its package source with a
   fresh project-index cache and the default `refreshProjectIndex`, so every cold build pays a
   cold project-index refresh of 6–9.4 s that a Workbench user never sees
   (`apps/workbench/src/main/workbench-live.ts:154-161,191-193`). The benchmark warms the project
   index once per project, outside the measured build, and builds with
   `refreshProjectIndex: false`, as the Workbench does. The CLI's first-ever run still pays the
   refresh; that is recorded, not optimised.
2. **The localization branch runs beside package extraction.** The localization files and the
   packages are disjoint inputs that publish disjoint layers; only the join needs both
   ([attribution §4](game-text-scan-attribution.md#4-why-the-stages-are-sequential)). The
   writer is idle while the reader extracts, so the one writer session is enough — no second
   session, no second lease:
    - `prepareTarget` keeps one `withSession`. Inside it, the localization import (parse, then
      publish) and the package refresh's selection and read run concurrently. The package
      refresh's import and publish start only after both finish; then the join.
    - The package refresh reads the writer's manifest when it chooses between cold and batch
      publication, not at its start, so a localization publish in between can't make it stale.
      Native commands stay serialized by the client's semaphore.
    - Failure semantics are unchanged: a localization import failure fails the target with the
      same error as today, and the package branch is interrupted rather than left running. The
      source-view fallback still runs only after the session is released.
    - Memory: the localization parser pool and the package prepare pool each budget against half
      of available memory today; while both can run, each gets an explicit half of one budget.
    - Progress keeps its phases; both branches report into the one reporter.
3. **The reader's coordinator only coordinates.** Workers serialize each package's staged record
   themselves; the coordinator appends the bytes to its group file and emits the result. It
   refills the job window before it writes, so a worker never waits behind staging. Each group
   file keeps the same records. Their order within a group file is completion order, which
   already varies from run to run (`crates/uasset-io/src/direct_executor/project_io.rs:637,949`);
   the package prepare step orders them, so the package-text snapshots stay byte-identical.
   Then the worker count is measured at 8, 12 and 16 on the released project. Choose the
   smallest count within 5% of the best wall time, and record the reader's peak working set for
   each; a count that raises the reader's peak above 5 GiB isn't eligible.

    _Amended after measurement._ Twelve workers was the eligible count, but with the localization
    branch beside extraction the process tree peaked at 6.01 GiB even at eight workers. The reader's
    memory is its decoded export models: a 39 MB Blueprint holds about 600 MB while it decodes, and
    the peak is the early cluster of large packages in flight at once, not buffered output or
    allocator retention ([attribution](game-text-scan-attribution.md)). So the reader bounds what
    it decodes at once by **input bytes**, not by worker count: a job starts only while the
    in-flight packages' file sizes stay within a budget, and a package larger than the budget runs
    alone. Twelve workers stay the default. The budget is chosen by measurement, the largest of
    256 and 192 MiB that keeps the whole tree under 6 GiB with the localization branch running
    beside extraction on the released project; requests can set it as they set the worker count.

4. **The join runs its independent steps in parallel.** Steps that read the same finished inputs
   and write disjoint outputs run together (`rayon::join`/`scope`): for example query places,
   the dependency graph, summary state and the translation search cache, each after what it
   reads. The implementation records the step graph it uses in a comment beside the code. The
   joined snapshot is byte-identical to today's.
5. **Package publication interns in parallel.** Collecting and deduplicating each domain's
   strings, and mapping each layer's strings to shared IDs, run per layer in parallel; shared IDs
   are assigned in the same order as today, so every published snapshot is byte-identical.
6. **Localization publication encodes its layers in parallel.** After the dictionary IDs are
   assigned, remapping, encoding and publishing the 21 layers run in parallel; the merge of the
   sorted runs stays serial unless it parallelises without changing IDs. Snapshots stay
   byte-identical.
7. **The writer parses localization files.** _Added after the first results._ Plan 059's own
   lesson is that bulk data stays in Rust, and the localization import is the largest piece that
   still doesn't: TypeScript workers spend 97 s of CPU decoding 1.4 GB of manifests, archives and
   PO files, write staged snapshot files, and the native writer reads them back. Running the
   branch beside extraction hid that cost; it didn't remove it, and the branch is now the longer
   one (35 s against 29 s for the package read) and Node's 2.7 GiB share of the memory peak.
    - A new writer command imports a target's localization files: it reads, decodes (UTF-16LE or
      UTF-8 by BOM), hashes and parses each file in parallel, bounded by input bytes as the reader
      is, and feeds the rows straight into the cold localization publication — no staged files, no
      TypeScript workers. It answers with what `prepareLocalizationFile` returns today for each
      file (key, content hash, provenance, relative path, format, input bytes) and the same
      diagnostics, with the same error codes and messages.
    - The parsers port `@ue-shed/localization`'s manifest, archive and PO parsers rule for rule;
      the TypeScript parsers are the specification, cited by file and line in the Rust. They stay in
      `@ue-shed/localization` for everything that isn't the index (evidence reads, PO writing).
    - Both the cold import and the single-file import go through the command, so the index has one
      parser. `localization-import-worker.ts` and the cold staging path are deleted;
      `prepareLocalizationFile` stays exported, deprecated, until its last caller outside the index
      moves.
    - Byte identity is the gate: every localization layer and dictionary equals the TypeScript
      path's on both benchmark projects, both canonical corpora and the corpus fixture's files, and
      a differential test feeds both parsers the fixture's files plus generated edge cases (BOMs,
      PO escapes and line continuations, empty and duplicate entries, invalid input) and compares
      rows and diagnostics.
8. **The reader writes the package-text shard snapshots.** _Added with decision 7, for the same
   reason._ Package text still crosses TypeScript in bulk: the reader serializes every record to
   NDJSON (505 MB on the released project), TypeScript workers decode it, convert it to columns
   (`package-text-columns.ts`), sort it and write staged shard snapshots, and the writer reads
   those back. The prepare step is 4.5 s on the critical path, and its workers are most of
   Node's remaining 2.4 GiB high.
    - The reader's workers convert each package's record to its column rows themselves, in Rust,
      with no JSON. The coordinator adds the rows to their shard's builder, and a shard is ordered
      and written as soon as its last package arrives (the request already names every shard's
      packages), so the reader holds at most the shards in progress. The snapshots are the bytes
      the TypeScript prepare step writes today; the writer's cold publication reads them as now.
    - `package-text-columns.ts`'s encoder is the specification, ported rule for rule (string
      domains, flags, the copy encoding, gap reasons); the Rust cites it where a rule isn't obvious.
    - One encoder for the index: the incremental package refresh (`replacePackageTextRecords`)
      and the retained-record replay the benchmark and tests use go through the same Rust
      conversion. The reader accepts staged records as an input in place of packages for that
      replay. The TypeScript prepare worker, its protocol and the NDJSON staging are deleted;
      `packageTextColumns` stays only if a reader of stored columns still needs it, and then as
      the decoder's counterpart in tests, not on the index path.
    - Byte identity is the gate: every package-text snapshot equals the TypeScript path's on both
      benchmark projects and both canonical corpora, and a differential test converts the corpus
      fixture's records and generated edge cases through both encoders and compares the columns.
9. **Deferred, with reasons:**
    - _Export decoding_ is the reader's real compute (118 s CPU). It needs a profile of the
      decoder, not a scheduling change.
    - _Bundle verification_ (6.1 s) checks that no package changed during the scan; it stays as
      is until it is the largest remaining serial step.

## 3. Instrumentation

The probes stay: the `*.stage_ms.*` attributes on `PackageText.refresh`,
`LocalizationSnapshot.importColdTarget`, `GameTextIndexSource.inventory` and
`package-text.cold`, the native cold-scan counters behind `UE_SHED_COLD_SCAN_MEASURE_DIR`, and the
memory and cancellation probe scripts. Every change in this phase keeps its stage visible to the
recorder, including the new concurrency: the localization branch and the package read each keep
their own span, so their overlap is measurable.

## 4. Order of work, one commit per step at least

1. **Docs.** This specification, the attribution, and Plan 059's status and phase list.
2. **The benchmark measures what the Workbench pays** (decision 1), and the baseline is
   re-measured at the start of this branch: one cold build per project.
3. **The reader's coordinator** (decision 3), then the worker-count measurement.
4. **The localization branch beside extraction** (decision 2).
5. **The join's parallel steps** (decision 4).
6. **Parallel package interning** (decision 5).
7. **Parallel localization encoding** (decision 6).
8. **The writer parses localization files** (decision 7), measured against the results recorded at `08296cfd`.
9. **The reader writes the package-text shard snapshots** (decision 8).
10. **Parity and measurements:**
    - every joined, package and localization snapshot byte-identical to the baseline's on both
      canonical corpora and both benchmark projects;
    - the corpus fixture exact on both canonical corpora;
    - one 10,000-line fuzz run, incremental and full scans agreeing;
    - every exported file byte-identical to Phase 4's on both canonical corpora;
    - cold build wall, the stage table above, process-tree peak and cancellation, against the
      step 2 baseline, three runs each on both projects.

    Then the owner review.

## 5. STOP conditions

- A snapshot or exported file differs from the baseline's.
- A fixture or fuzz disagreement.
- The process-tree peak rises above 6 GiB on the released project.
- Cancellation gets slower than 0.5 s to return or 3 s for the children to exit.

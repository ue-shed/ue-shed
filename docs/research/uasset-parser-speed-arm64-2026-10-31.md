# UAsset parser speed on ARM64 (2026-10-31)

This investigation records a new baseline on the local ARM64 machine. Earlier desktop timings
remain separate measurements. The starting parser is commit
`3d7e0ba2e686ba96e9e53973ab75cc34ce138fe5`; its source and executable were preserved before edits.

These results describe the overnight checkpoint, committed as `6254a1fc`. The subsequently
authorized [source follow-up](uasset-parser-speed-followup-2026-10-31.md) records seven further
trials, including final-configuration ablations and the retained common-scalar decoding shortcut.

## Machine and measurement

Ubuntu 24.04, ARM64 Qualcomm Kryo-4XX Gold/Silver, eight cores, 5.4 GiB RAM. Single-thread
replays are pinned to gold core 6 (maximum 2.304 GHz). Rust 1.99.1, release with fat LTO,
one codegen unit and debug information for sampling. The power policy remains unchanged.
The device tree identifies a Xiaomi POCO X3 NFC (Huaxing), `qcom,sm7150`; CPU 6 reports implementer
`0x51`, part `0x804`.

The committed corpus has 140 packages, 13,709,449 bytes, 17,454 exports, 17,405 decoded assets,
49 skipped exports and zero decode errors. Inputs and reference package headers are loaded before
timing, the embedded model is initialized before warmups, and outputs are dropped inside the timer.
The decode lane reuses parsed headers and their existing graph memo after warmup; combined reparses
each package. Neither includes process
startup or file reads. A fresh decode session is used for each replay, so tag metadata is reused
within one operation rather than between samples.

The clean library probe uses the system allocator. The shipping native reader uses mimalloc;
native process measurements must retain their startup, read and serialization boundary and be
reported separately. The standalone benchmark's locked dependencies are held fixed across
variants; its serde/serde_json versions differ from the root workspace lock.

Every initial distribution retains 21 samples after three warmups, with calibrated batches targeting
at least 30 ms. Interleaved experiments reverse revision order and rotate workload order between
blocks. CPU frequency and temperature snapshots accompany paired samples. Sampling traces use
`perf record -e cpu-clock:u` with DWARF stacks; instruction, cycle and syscall traces investigate
changes that timing alone cannot explain.

## Initial baseline

Milliseconds per complete workload sweep, p50. These are the original machine-specific numbers;
they are not a comparison with the earlier desktop.

| Workload   | Headers |  Decode | Parse + decode | Streaming inspection JSON |
| ---------- | ------: | ------: | -------------: | ------------------------: |
| corpus     |  23.276 | 104.881 |        132.756 |                   184.544 |
| level      |  16.694 |  64.417 |         82.221 |                   125.583 |
| table      |   2.398 |  23.726 |         26.207 |                    36.534 |
| blueprints |   0.377 |   2.897 |          3.723 |                     4.214 |
| small      |   4.162 |  10.862 |         16.522 |                    20.800 |

`corpus` is all 140 inputs. `level` is `L_CameraLoad`, `table` is the 10,000-row
`DT_LargeScalars`, `blueprints` is the five graph fixtures, and `small` excludes the large
level and table. Full samples and machine/build metadata are in
[baseline.json](evidence/uasset-speed-2026-10-31/baseline.json).

## Final comparisons

The ordinary release build changes source only; shipping compiler and allocator defaults are
unchanged. Values below are milliseconds per complete workload sweep, the median of three
interleaved block medians (15 samples per block after three warmups). The original parser was
remeasured in the same window. These workloads overlap; their times must not be added.
The original whole-corpus baseline changes from 132.756 ms initially to 133.651 ms in the final
window (under 1% drift); the large-table baseline remains within 0.1%.

System allocator, preloaded input:

| Workload             | Parse + decode before |  After | Less time | Streaming JSON before |   After | Less time |
| -------------------- | --------------------: | -----: | --------: | --------------------: | ------: | --------: |
| All 140 packages     |               133.651 | 82.220 |     38.5% |               185.518 | 136.519 |     26.4% |
| Large level          |                81.156 | 51.977 |     36.0% |               124.868 |  95.467 |     23.5% |
| 10,000-row table     |                26.182 | 11.125 |     57.5% |                36.805 |  21.993 |     40.2% |
| Five Blueprints      |                 3.732 |  3.419 |      8.4% |                 4.218 |   3.910 |      7.3% |
| 138 smaller packages |                16.535 | 14.534 |     12.1% |                20.790 |  18.654 |     10.3% |

All five operations, raw samples, build commands and frequency/temperature observations are in
[ordinary.json](evidence/uasset-speed-2026-10-31/ordinary.json). The corpus combined reduction is
38.7%, 38.0%, 38.3% across the three paired blocks.

The same in-memory comparison using **mimalloc 0.1.52**, matching the shipping reader:

| Workload             | Parse + decode before |  After | Less time |
| -------------------- | --------------------: | -----: | --------: |
| All 140 packages     |               106.222 | 68.840 |     35.2% |
| Large level          |                71.135 | 46.924 |     34.0% |
| 10,000-row table     |                22.136 |  9.713 |     56.1% |
| Five Blueprints      |                 2.342 |  2.099 |     10.4% |
| 138 smaller packages |                11.120 |  9.458 |     14.9% |

Both allocator builds match the original oracle on all 140 fixtures and 267 malformed inputs.
Raw distributions: [mimalloc.json](evidence/uasset-speed-2026-10-31/mimalloc.json).

The shipping native CLI boundary includes process startup, warm-file reads, decode, JSON and stdout
pipe transfer. It uses mimalloc and alternates executables every run:

| Input     | Original CLI | Optimized CLI | Less time | Paired block range |
| --------- | -----------: | ------------: | --------: | -----------------: |
| level     |      187.380 |       159.201 |     15.0% |        11.1%–19.2% |
| table     |       73.438 |        59.209 |     19.4% |        16.4%–21.6% |
| blueprint |       14.438 |        14.479 |     -0.3% |         -0.3%–6.2% |

The small fresh Blueprint process has no reliable improvement. Its startup/transfer noise is large
relative to the parser change; the in-memory five-Blueprint comparison remains separate.
Raw distributions: [native.json](evidence/uasset-speed-2026-10-31/native.json).

### Allocation and instruction evidence

The counting lane parses, **retains all decoded exports**, projects text, then drops the models.
Its warm passes 2 and 3 agree exactly. Input reads are excluded. Streaming inspection peak is a
separate measurement; these are allocation counters, not clean throughput timings.

| Metric                                |   Original |  Optimized | Reduction |
| ------------------------------------- | ---------: | ---------: | --------: |
| Allocations                           |    864,957 |    685,986 |     20.7% |
| Requested bytes                       | 99,276,777 | 60,999,690 |     38.6% |
| Peak live bytes, retained models      | 34,713,040 | 28,941,405 |     16.6% |
| Peak live bytes, streaming inspection | 27,347,894 | 26,209,954 |      4.2% |

Fixed-work whole-process hardware counters record 35.8% fewer user instructions, 34.9% fewer user cycles
and 42.9% fewer branch misses. The run includes 105 combined sweeps plus startup and
initialization. Overlapping PMU aliases are counted once. The final decode trace has moved toward
byte comparisons, actual value decoding and allocation; removing an out-of-line symbol through
inlining alone is not treated as evidence that its work disappeared.

[allocations.json](evidence/uasset-speed-2026-10-31/allocations.json) and
[traces.json](evidence/uasset-speed-2026-10-31/traces.json) retain counts, error ABI sizes, flat
sampling summaries, hardware observations and the rejected allocator/syscall evidence.

## Correctness oracle

Each retained experiment must match the starting executable on the complete package and decoded
model fingerprint, owned inspection JSON and streaming inspection JSON. A separate deterministic
corpus has 267 truncations/bit mutations of scalar tables and modern/legacy Blueprints. Error kind,
message, path and offset remain part of the fingerprints. The preserved baseline is deterministic
across repeated fingerprint runs. Exact truncation/XOR recipes and source hashes are retained in
[mutations.json](evidence/uasset-speed-2026-10-31/mutations.json); the original fixtures are never
modified.

Targeted replay tests also compare every truncation and byte corruption against ordinary parsing,
including cursor state after failure, current payload values, boolean flags, relocated spans and
root serialization-control prefixes. A real-level integration test compares the new package session
with individual decoding for every export.
The full comparison hashes and fixture counts are in
[oracle.json](evidence/uasset-speed-2026-10-31/oracle.json).

UE 5.7 and UE 5.8 are unavailable on this machine. Both discovery calls returned unavailable, and
`test:uasset-engine-matrix` stops at missing UE 5.7. Correctness here is relative to the existing
parser and retained fixture evidence; fresh Unreal conformance has not been performed.

## Retained source changes

The initial header trace attributed 12.78% of self samples to out-of-line byte reads and another
5.97% to archive booleans. The decode trace included byte/name reads, repeated type-tree parsing,
backward suffix searches and allocation. These are sampling proportions within each lane, not
independent speedup predictions. Disassembly also exposed large successful `Result` copies around
bounded readers, motivating the compact-error and selective-inlining experiments.

- Keep primitive byte loads visible to the optimizer and move error construction out of hot paths.
- Store archive, package, property and asset diagnostic data behind one pointer. This reduces a
  property-value `Result` from 104 to 32 bytes and a unit `Result` from 104 to 8 on this target.
  Diagnostics are allocated on failure; public accessors, error-chain types and diagnostic text
  remain unchanged. Golden tests protect the established debug format and downcasts.
- Allocate exact capacity when joining resolved object paths. Strings remain independently owned.
- Compare class suffixes directly where checking the last component has identical meaning.
- Carry diagnostic paths as borrowed formatting values; successful row reads do not allocate them.
- Reuse validated tagged-property layouts across DataTable rows. Every payload is decoded normally;
  a mismatch leaves the cursor unchanged and returns to the ordinary parser. The boolean value
  flag can vary and is copied from the current bytes.
- Use an optional `AssetDecodeSession` for repeated UObject layouts within one immutably borrowed
  context. Existing per-export APIs remain available. Metadata budgets limit acceleration, never
  accepted packages; repeated layout misses disable replay. Libraries, native readers and WASM
  projections share the implementation.
- Retain up to four recent UObject layouts per class, capped at 64 classes and 16 KiB of serialized
  header metadata per layout. Eight consecutive misses disable a class's accelerator. Direct raw
  record construction copies validated tag metadata and relocates spans in one pass.

## Rejected or superseded experiments

[experiments.json](evidence/uasset-speed-2026-10-31/experiments.json) records the 24 source
experiments, their dispositions, parent/candidate executables and incremental block medians. The
first exploratory experiment has an explicitly marked potentially overlapping block; the final
comparison is rerun independently with competing checks finished.

The initial inlining hints gave only small gains and were superseded by keeping the constant-size
byte reader visible to its callers. A combined ancestry-borrowing experiment reduced instructions but
regressed large-table streaming inspection under the system allocator. For 32 inspections,
`strace` recorded 149 heap-growth calls before and 2,820 after. Hardware counters showed fewer
user cycles while system time increased. That variant was reverted; smaller allocation counts alone
were insufficient evidence of an improvement. Borrowing only the schema-provider ancestry was
subsequently measured independently and retained; native generated-class ancestry remains unchanged.

Delaying UObject layout capture until a class's second appearance reduced small-package decode
time by about 4–5%, but increased whole-corpus parse-plus-decode by 2.6% in both paired blocks.
The retained cache therefore learns from the first successful stream. Avoiding work for unique
classes did not compensate for the measured aggregate regression.

Shared `ObjectPath` storage was tested with both `Arc<String>` and `Arc<str>`, preserving public
methods, serialization and model fingerprints. The first variant increased header parsing by
17–20%. Sharing the empty placeholder and allocating exact path-concatenation capacity recovered
header speed, but decoding and owned inspection still regressed. Ordinary owned strings were
restored; the representation's smaller handle did not make it faster.

Forcing every scalar reader inline helped before compact errors, but regressed level combined
parsing by about 3% when added to the compact-error implementation. The final source keeps the
selective hints. A lazy native-math diagnostic variant improved isolated level decoding but did not
improve complete workload time, so it was also reverted.

Comparing a complete replay header before checking its fragments improved the large table, but
level and smaller-package results were mixed. Restricting that shortcut to streams without a
UObject serialization-control prefix reduced the table gain and still regressed other combined
lanes. Both variants matched all oracle fingerprints and were rejected after three paired blocks.

## Profile-guided build experiments

Compiler PGO and LLVM BOLT are measured separately from the ordinary release build. They do not
change shipping build defaults. PGO training and profile use must keep source, dependencies, target
and other compiler flags fixed; see the [Rust compiler's PGO guide](https://doc.rust-lang.org/rustc/profile-guided-optimization.html).
BOLT uses an executable linked with relocations, instrumentation profiles from the same corpus, and
`ext-tsp` block ordering with `cdsort` function ordering and cold splitting. See
[LLVM's BOLT guide](https://github.com/llvm/llvm-project/blob/main/bolt/README.md).

All transformed builds must pass the same rich-model and inspection fingerprints before timing.
Fixture-trained gains are evidence for these workloads rather than a portable performance guarantee.

<!-- BUILD_RESULTS_START -->

The trained builds use two interleaved blocks per lane, with 15 samples after three warmups.
PGO trains combined and streaming JSON on corpus/small/table/Blueprint workloads (25 runs plus
two warmups each). BOLT instruments the PGO executable and trains the same eight lanes with nine
runs plus two warmups. These are training-corpus results, without a held-out evaluation set.
Each arrow below is its own interleaved comparison; the stage gains are not multiplied.

| Workload | Ordinary → PGO (ms) | Less time | PGO → PGO+BOLT (ms) | Less time |
| -------- | ------------------: | --------: | ------------------: | --------: |
| corpus   |     82.429 → 72.729 |     11.8% |     72.505 → 69.663 |      3.9% |
| level    |     52.619 → 44.270 |     15.9% |     45.657 → 43.754 |      4.2% |
| table    |      11.150 → 9.469 |     15.1% |       9.398 → 9.754 |     -3.8% |
| small    |     14.532 → 13.279 |      8.6% |     13.310 → 12.499 |      6.1% |

BOLT is mixed: the table combined lane regresses and level streaming JSON has no clear gain.
It is retained as an experiment rather than adopted as a universal build setting. Full distributions:
[pgo.json](evidence/uasset-speed-2026-10-31/pgo.json),
[bolt.json](evidence/uasset-speed-2026-10-31/bolt.json).

A separate `-Ctarget-cpu=native` build matches all fingerprints but does not improve the corpus or
level combined workload consistently. Generic target settings remain unchanged. Its corpus
comparison is 83.098 → 84.018 ms.
[nativeCpu.json](evidence/uasset-speed-2026-10-31/nativeCpu.json) retains the measurements.

<!-- BUILD_RESULTS_END -->

<!-- EXTRA_BUILD_START -->

Additional compiler experiments, all with identical fixture/malformed fingerprints:

- `panic=abort` reduces corpus combined time by 3.3% and level combined by 5.0%. It changes panic behavior and is an isolated build experiment.
- `opt-level=s` increases corpus combined time by 15.1%, and streaming JSON regresses more. It is rejected.

Raw samples: [panicAbort.json](evidence/uasset-speed-2026-10-31/panicAbort.json),
[optSize.json](evidence/uasset-speed-2026-10-31/optSize.json).

The same training was repeated with mimalloc, with fresh profiles for that executable:

| Workload | Ordinary mimalloc → PGO (ms) | Less time | PGO → PGO+BOLT (ms) | Less time |
| -------- | ---------------------------: | --------: | ------------------: | --------: |
| corpus   |              68.939 → 58.199 |     15.6% |     58.163 → 58.665 |     -0.9% |
| level    |              47.034 → 39.315 |     16.4% |     39.452 → 39.222 |      0.6% |
| table    |                9.969 → 8.174 |     18.0% |       8.068 → 8.228 |     -2.0% |
| small    |                9.520 → 8.299 |     12.8% |       8.301 → 8.005 |      3.6% |

[pgoMimalloc.json](evidence/uasset-speed-2026-10-31/pgoMimalloc.json) and
[boltMimalloc.json](evidence/uasset-speed-2026-10-31/boltMimalloc.json) retain all samples.

Finally, the trained mimalloc executable was compared **directly** with the original mimalloc
parser, with three interleaved blocks rather than multiplying stage gains:

| Workload   | Original (ms) | Optimized + PGO+BOLT (ms) | Less time |
| ---------- | ------------: | ------------------------: | --------: |
| corpus     |       107.457 |                    57.971 |     46.1% |
| level      |        71.238 |                    39.286 |     44.9% |
| table      |        21.998 |                     7.972 |     63.8% |
| blueprints |         2.348 |                     1.817 |     22.6% |
| small      |        11.123 |                     8.053 |     27.6% |

This is fixture-trained build tuning, separate from the ordinary shipping release.
[trainedMimalloc.json](evidence/uasset-speed-2026-10-31/trainedMimalloc.json) contains the direct
comparison, including header, decode, combined, owned and streaming inspection lanes.

The original-versus-PGO-only mimalloc comparison was also repeated directly in three blocks,
keeping the mixed BOLT stage separate:

| Workload   | Original (ms) | Optimized + PGO (ms) | Less time |
| ---------- | ------------: | -------------------: | --------: |
| corpus     |       107.956 |               58.188 |     46.1% |
| level      |        71.755 |               39.980 |     44.3% |
| table      |        22.031 |                8.023 |     63.6% |
| blueprints |         2.346 |                1.870 |     20.3% |
| small      |        11.075 |                8.321 |     24.9% |

[pgoDirectMimalloc.json](evidence/uasset-speed-2026-10-31/pgoDirectMimalloc.json) retains the
complete direct comparison. All trained variants preserve the original fingerprints; ordinary
shipping build settings remain unchanged.
One final PGO level-JSON pair overlapped executable hashing and was remeasured in full after the
timing run. [timing-exclusions.json](evidence/uasset-speed-2026-10-31/timing-exclusions.json)
preserves the excluded samples, their timing window and the replacement reason.

<!-- EXTRA_BUILD_END -->

Raw profiles, preserved executables, mutation inputs and experiment logs are under the ignored
`out/uasset-speed-2026-10-31/` directory. The final comparisons below use the original executable
again, interleaved with the retained implementation; incremental experiment gains are not multiplied.

## Verification

Final static checks pass, including 119 architecture tests. The standalone probe also passes
formatting and clippy with warnings denied. Production source hashes still match the measured build.

The final source passes `pnpm run uasset:check` (707 Rust tests passed, eight ignored), including
parser/inspection/IO tests and clippy,
generated-source checks, WASM browser smoke, the packed WASM consumer, native/WASM parity and
saved-review fixture checks. Windows layout checks also pass. Additional tests protect replay
fallback, forward and reverse export order, diagnostic debug formatting and error-source downcasts.

The final WASM build was separately compared with the preserved **original** native executable
under Node 24.21.0 and Node 26.13.0. Both pass inspection parity for 23 fixtures, authoring parity
for 12, compact projections for 13 plus Blueprint/Level Sequence coverage, and typed failures/limits.
Data Authoring adoption conformance also passes through its copied host and rebuilt native reader,
discovering 18 fixture tables and opening the composite scalar table. All three isolated
game-text host-responsiveness tests pass as well.

The full portable gate is **not green**. Its public-package consumer install fails with pnpm
`ENOTDIR` while opening the optional Windows engine package's `package.json`. The repository lane
passes static, type, contract and release checks, then encounters UI test failures in unchanged
camera-review, game-text, operations and translation files. That test run was stopped; it is not
reported as a pass. These failures were not repaired as part of the parser investigation.
UE 5.7 and UE 5.8 remain unavailable, so neither fresh engine check passes.
Commands, outcomes, limitations and preserved executable hashes are in
[verification.json](evidence/uasset-speed-2026-10-31/verification.json).

## Reproducing the measurement

On this host, first source `out/uasset-speed-2026-10-31/setup/env.sh` to select the locally installed
toolchain and libraries. Other machines can use their installed toolchain.

Build the standalone probe with the checked-in lockfile and release profile. Set
`CARGO_PROFILE_RELEASE_DEBUG=1` when collecting symbolized profiles. Generate the package list from
the paths in [corpus.json](evidence/uasset-speed-2026-10-31/corpus.json), resolving each against the
checkout root, and verify its input hashes. Use the same list and input path spelling for both
executables: inspection JSON includes the supplied source path.

```sh
cargo build --locked --release \
  --manifest-path tools/benchmarks/uasset-decode/Cargo.toml --bin parser-speed
taskset -c 6 tools/benchmarks/uasset-decode/target/release/parser-speed \
  --list packages.txt --operation combined --runs 21 --warmups 3 --batch-ms 30
taskset -c 6 tools/benchmarks/uasset-decode/target/release/parser-speed \
  --list packages.txt --evidence evidence.jsonl
perf record -e cpu-clock:u -F 499 --call-graph dwarf,16384 -- \
  taskset -c 6 tools/benchmarks/uasset-decode/target/release/parser-speed \
  --list packages.txt --operation decode --runs 31 --warmups 3 --batch-ms 100
```

Choose an appropriate CPU on another machine. Interleave the preserved and candidate executables,
reverse their order between blocks, and keep builds, tests and profiling out of the timing window.
The original probe source and executables, source archives, complete raw samples, training profiles,
perf data, syscall traces and verification logs remain under `out/uasset-speed-2026-10-31/` on this
machine. The checked-in evidence retains raw final timing samples and the smaller reproducible
fixture, mutation, allocation and source-hash records.

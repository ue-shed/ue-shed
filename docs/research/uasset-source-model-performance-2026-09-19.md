# Source-model parser optimization (2026-09-19)

The first allocation pass recovers the common-corpus JSON slowdown while retaining the additional
native values. Generated layouts, analyzer rules, serialization order, limits, and public JSON
remain unchanged.

## Changes

- Box the optional Skeleton pose in the owned `AssetOutput`. On this 64-bit build its size falls
  from 512 to 400 bytes, saving 112 bytes for every asset record. The Rust field becomes
  `Option<Box<PropertyValueOutput>>`; JSON is unchanged.
- Borrow resolved struct names, retaining owned formatting for numbered names, and reuse the
  resolution in tagged struct decoding.
- Carry native diagnostic breadcrumbs as borrowed formatting arguments. Format them only when
  an error is produced. Apply the same existing archive-reader convention to property leaf reads.
- Decode sized-array elements directly from the supplied layout, without cloning that layout into
  a temporary array node. Keep layout validation before reads and all resource checks.

No layout cache or second compiled representation was needed for these gains. Layout validation and
the intermediate native value tree remain possible future targets if profiling justifies them.

## Method

Windows, Ryzen 9 5950X, Rust `1.93.0-nightly (b6d7ff3aa 2025-11-14)`, release with thin LTO and one
codegen unit. Compare main `09d3797`, expanded source-model baseline `4f81433`, and this optimization.
The baseline executable was preserved before editing. All variants read identical fixture bytes.

The common corpus contains the 71 packages present on main, totaling 12,781,052 input bytes.
The six new native fixtures are a separate case: main cannot decode all their exports. Timings
exclude file reads and process startup. Each process performs an initial call, two warmups,
calibration, and 11 adaptive batches targeting at least 25 ms each. Three interleaved blocks rotate
revision order and shuffle cases; values below are medians of 33 samples. Outputs are dropped within
the timed operation. No builds or other benchmark processes ran concurrently.

Memory is the median process peak working set across those three processes, sampled through the
Windows process API. It includes executable/runtime/input storage and allocator retention, so it
is not a measurement of live Rust allocations. Output accounting runs in separate processes.

## Results

| Operation                               | Main (ms) | Before (ms) | Optimized (ms) | Change from before |
| --------------------------------------- | --------: | ----------: | -------------: | -----------------: |
| 71 packages, headers                    |    10.594 |      10.598 |         10.541 |              -0.5% |
| 71 packages, owned inspection           |   106.561 |     109.134 |        107.038 |              -1.9% |
| 71 packages, streaming JSON             |    86.469 |      91.045 |         85.293 |              -6.3% |
| Large level, owned inspection           |    81.931 |      85.512 |         78.502 |              -8.2% |
| Large level, streaming JSON             |    62.461 |      66.255 |         60.792 |              -8.2% |
| 10,000-row DataTable, streaming JSON    |    20.129 |      20.593 |         20.764 |              +0.8% |
| Animation, streaming JSON               |     0.069 |       0.456 |          0.245 |             -46.4% |
| Skeleton, streaming JSON                |     0.012 |       0.023 |          0.019 |             -17.4% |
| Six new native fixtures, streaming JSON |         — |       0.319 |          0.250 |             -21.8% |

The small header/DataTable differences are not evidence of a meaningful improvement or regression.
Animation remains slower than main because it now exposes substantially more native channel data:
61,603 JSON bytes versus 11,423. The large level contains 16,527 decoded assets. Its JSON is unchanged
by this pass, as are all other fixture outputs.

| Peak working set              | Main (MiB) | Before (MiB) | Optimized (MiB) |
| ----------------------------- | ---------: | -----------: | --------------: |
| 71 packages, owned inspection |      68.77 |        76.35 |           72.62 |
| Large level, owned inspection |      66.00 |        73.16 |           69.81 |
| 71 packages, streaming JSON   |      40.31 |        40.83 |           40.65 |

Owned common-corpus inspection saves 3.73 MiB (4.9%) versus the expanded parser. It still uses more
memory than main because the expanded property/output models are larger. Streaming memory is
essentially unchanged. These fixture measurements are not a claim about end-to-end disk scans,
process startup, or every project.

The local raw measurements, manifests, preserved baseline, and standalone comparison harness are
under ignored `out/source-codegen/perf/` (`optimization-summary.json`,
`optimization-measurements.json`, and `optimization-run.py`). The maintained single-package
benchmark can reproduce individual workloads on each revision:

```sh
cargo run --release -p uasset-inspection --example benchmark_inspection -- <package> 100 3
```

## Correctness evidence

Both owned and streaming inspection JSON are byte-identical to `4f81433` for all 77 fixture inputs
(154 output comparisons). A regression test checks that successful nested native reads do not
format paths, while invalid booleans, counts, and sized-array strides retain their exact paths and
offsets. Existing invalid-layout, truncation, limits, and source-model field-order tests remain in
place. Fresh-process Unreal conformance and the full `pnpm check` gate passed, including native/WASM
parity, packed consumers, and standalone Data Authoring adoption. The final TypeScript test suite
passed 1,241 tests, with 50 opt-in integration tests skipped.

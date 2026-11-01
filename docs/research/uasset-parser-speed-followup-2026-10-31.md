# UAsset parser follow-up: source ablations and scalar decoding (2026-10-31–2026-11-01)

The completed overnight investigation was committed and pushed as `6254a1fc0ed1c5f90a1ad2ba121f0137dff5cb30` on `perf/uasset-parser-speed-arm64-2026-10-31` before this user-authorized continuation. The original parser at `3d7e0ba2e686ba96e9e53973ab75cc34ce138fe5`, its binaries, and all earlier measurements remain preserved. The old scheduled continuation remains disabled. This new authorization began after the original cutoff; final measurements continued into 1 November UTC.

This batch measured seven further source trials with mimalloc 0.1.52, including three final-configuration ablations. Only trial 30 is retained: 37 production lines plus regression coverage in `codec.rs`. No public model/API, allocator, compiler profile, or fixture changes were made.

## Final independent measurements

These are ordinary release builds, without PGO/BOLT. Preloaded input excludes startup and disk reads. Three interleaved blocks, 15 samples after three warmups, pinned CPU 6; rotated workloads and reversed variant order. Values are medians of block medians. Positive percentages mean less elapsed time. All five operations, paired block medians, exact rejected-source patches, counters, and source hashes are in [followup.json](evidence/uasset-speed-2026-10-31/followup.json). Every raw sample and thermal/frequency reading is preserved losslessly in [followup-raw.json.gz](evidence/uasset-speed-2026-10-31/followup-raw.json.gz); decompress with `gzip -dc followup-raw.json.gz`. The JSON index records its SHA-256. Workloads overlap and must not be summed.

Against the pushed overnight checkpoint, recompiled in the same source location:

| Workload             | Before ms | After ms | Less time | Paired blocks         |
| -------------------- | --------: | -------: | --------: | --------------------- |
| All 140 packages     |    68.580 |   66.897 |     +2.5% | +3.0% / +2.1% / +2.5% |
| Large level          |    46.845 |   45.966 |     +1.9% | +2.7% / +1.9% / +1.4% |
| 10,000-row table     |     9.671 |    8.995 |     +7.0% | +5.6% / +6.9% / +7.6% |
| Five Blueprints      |     2.038 |    2.050 |     -0.6% | -0.6% / -2.2% / -0.6% |
| 138 smaller packages |     9.328 |    9.333 |     -0.1% | +0.1% / -0.3% / +0.0% |

The five-Blueprint lane regresses 0.6% in the checkpoint comparison (2.038 to 2.050 ms); the 138-package smaller aggregate is flat. Retention favors the consistent corpus, level, and table gains, rather than claiming a uniform improvement.

Against the preserved initial parser, measured directly rather than multiplying stage gains:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   106.256 |   66.650 |    +37.3% | +37.1% / +37.3% / +37.3% |
| Large level          |    71.191 |   46.424 |    +34.8% | +34.5% / +36.6% / +34.6% |
| 10,000-row table     |    22.081 |    9.031 |    +59.1% | +58.9% / +59.1% / +59.7% |
| Five Blueprints      |     2.342 |    2.046 |    +12.6% | +12.6% / +17.2% / +12.6% |
| 138 smaller packages |    11.211 |    9.353 |    +16.6% | +16.9% / +15.8% / +17.1% |

The fresh native CLI boundary was not remeasured in this continuation. Its earlier results and all PGO/BOLT results in the [overnight report](uasset-parser-speed-arm64-2026-10-31.md) apply to that checkpoint, not this new source.

## All seven trials

Trials 25–30 compare independently with the checkpoint. Trial 31 compares the combination directly with trial 30. These percentages are incremental parse-plus-decode results and must not be added. Every trial matched the original on all 140 fixtures and 267 malformed inputs before timing; the raw evidence retains every measured operation and paired block.

| Trial | Disposition  | Corpus | Level | Table | Smaller |
| ----- | ------------ | -----: | ----: | ----: | ------: |
| 25    | Rejected     |  -0.1% | -0.8% | +1.2% |   +0.7% |
| 26    | Rejected     |  -0.5% | -2.0% | -0.5% |   -1.7% |
| 27    | Rejected     |  -0.2% | -0.8% | -0.1% |   -0.6% |
| 28    | Not retained |  +1.5% | -0.1% | -1.3% |   +0.4% |
| 29    | Rejected     |  -4.0% | -5.7% | -4.2% |   -1.5% |
| 30    | Retained     |  +2.4% | +1.5% | +4.3% |   +0.0% |
| 31    | Rejected     |  -0.4% | +1.4% | -0.2% |   -0.2% |

### 25: Replace forced Span/cursor inlining with ordinary inline hints.

No consistent combined gain; several decode lanes regressed.

### 26: Restore owned schema ancestry traversal.

Level combined time rose about 2%, and smaller packages slowed about 1.7%.

### 27: Restore cloning the complete replay stream before relocating records.

Main combined lanes were slightly slower; keep direct record construction.

### 28: Resolve struct name, module, and native type path once per StructFacts.

Initially saved 1.5% corpus time, but that benefit did not survive combination with the better scalar path (31).

### 29: Generic exact-width scalar shortcut using ScalarKind and a size lookup.

Added dispatch outweighed reader work avoided: corpus was 4.0% slower, level 5.7% slower.

### 30: Direct exact-width arms for common Int/Float/Double/Object/Bool tags.

Removes the extra enum/size dispatch from 29. Unexpected widths, source bounds, binary/native flags, and all other types retain the ordinary decoder.

### 31: Combine 28 and 30, compared directly with 30.

Corpus combined time regressed in all three blocks. Extra source complexity did not improve the main aggregate.

## Why the retained path preserves behavior

The existing skipped-serialization and unresolved-type handling runs first. For non-binary/native tags, a few common scalar arms require the exact payload width and a valid source slice, then construct the same value with safe little-endian loads. Zero-byte Bool payloads use the current tag flag. Every unexpected width, out-of-range span, other type, and binary/native case returns to the existing decoder; no error is replaced with a shortcut diagnosis. Names, enums, containers, native structs, and all header validation retain their ordinary paths.

Regression tests compare tagged scalar values and relocated spans with the established bounded typed decoder, and cover all 64 low tag-flag combinations with zero/one-byte Bool payloads, including skipped/native precedence and trailing-byte raw reasons.

## Trace and counter evidence

Fixed work is 105 combined corpus sweeps plus initialization/startup, with no competing build or timing job. This kernel reports identical events through overlapping PMU aliases; each is counted once.

| Metric        |     Checkpoint |       Retained | Reduction |
| ------------- | -------------: | -------------: | --------: |
| instructions  | 36,350,059,096 | 35,287,293,167 |     +2.9% |
| cycles        | 16,477,893,907 | 15,964,178,669 |     +3.1% |
| branches      |  7,200,586,265 |  7,101,688,525 |     +1.4% |
| branch-misses |     24,082,382 |     23,064,095 |     +4.2% |

The rejected generic scalar trial executed about 2.5% more instructions and 4.3% more cycles than its checkpoint run. This supports the diagnosis that the extra enum/type/size dispatch outweighed avoided reader setup. Consolidating struct identity alone reduced instructions about 1.4%, but the extra corpus timing gain did not survive combination with the retained scalar path. Fresh 499 Hz cpu-clock/DWARF decode profiles and record logs are preserved with the counters. Profiled timings are not throughput measurements.

## Verification and limits

- Retained release probe: all 140 fixtures and 267 malformed inputs match the original, including complete decoded models, both inspection outputs, and diagnostic kind/text/path/offset.
- Focused scalar/Bool regression tests and parser all-target clippy with warnings denied pass.
- Final static checks pass, including 119 architecture tests. The lossless evidence audit validates
  966 distributions containing 14,490 retained samples and confirms all three preserved original
  binaries are unchanged.
- The UAsset portion of `pnpm check` passes: 708 Rust tests, eight ignored, plus native/WASM/browser and saved-review checks. The overall command exits 1 at the package-consumer installation; the portable gate is not green.
- Windows layout check exit 0; final WASM versus original native reader exits 0 on Node 24.21 and 0 on Node 26.13.
- Fresh UE 5.7 and UE 5.8 discovery: 5.7 unavailable, 5.8 unavailable. Engine-matrix exit 1. No fresh Unreal conformance passed.
- Frozen production source hashes match before and after final timing.

The full check stops at the public-package consumer installation: pnpm reports `ENOTDIR` opening the optional `@ue-shed/engine-win32-x64/package.json`. UAsset, engine-process, type, architecture, and release-test phases passed before that failure. Its log is `out/uasset-speed-2026-10-31/continuation/verification/full-check.log`. This attempt does not reach the broader UI test phase; its earlier failures remain documented in the overnight report and were not repaired here. The machine, corpus, probes, allocator boundaries, and reproduction method follow the overnight report. Raw executables, source snapshots, perf data, logs, and unabridged intermediate artifacts remain under `out/uasset-speed-2026-10-31/continuation/`.

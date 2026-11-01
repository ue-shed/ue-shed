# UAsset parser speed: source and layout experiments (2026-11-01)

The user-authorized extension has a cutoff of **2026-11-01 10:52 UTC (17:52 GMT+7)**. This checkpoint changes parser source and ownership work; allocator and compiler settings remain fixed. It includes no new PGO, BOLT, target-CPU, panic-mode or allocator tuning.

“Original” means **before the entire session**, commit `3d7e0ba2e686ba96e9e53973ab75cc34ce138fe5`. Round control `97d555be8008f60bbc1a373467f9ea5241d22030` already contains the earlier overnight and scalar improvements. See the [overnight report](uasset-parser-speed-arm64-2026-10-31.md) and [first follow-up](uasset-parser-speed-followup-2026-10-31.md) for trials 1–31. The [first source checkpoint evidence](evidence/uasset-speed-2026-10-31/source-core-1.json) remains preserved independently.

## Retained source

Core 2 retains the first source checkpoint’s validated layouts, lazy semantic recipes, final-slot decoding and general DataTable rows. It adds a bounded complete type-prefix read with the original diagnostic fallback, length-bucket lookups for the immutable embedded schema and qualified native identities, and safe one-pass Latin-1 conversion. The public owned model and API remain unchanged.

The source manifest, archived source, binary hashes and source checks before/after verification identify this checkpoint. A benchmark’s checkout HEAD can name the preceding commit while uncommitted changes are measured; it is not used as the sole source identity.

Direct comparison with the pre-session original, ordinary release and held mimalloc:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   106.422 |   56.262 |   +47.13% | +47.13% / +47.02% / +46.81% |
| Large level          |    70.367 |   39.154 |   +44.36% | +43.95% / +45.03% / +44.84% |
| 10,000-row table     |    22.011 |    6.549 |   +70.25% | +69.15% / +70.58% / +70.46% |
| Five Blueprints      |     2.350 |    1.962 |   +16.48% | +16.17% / +16.61% / +17.07% |
| 138 smaller packages |    11.111 |    8.769 |   +21.08% | +20.72% / +21.08% / +21.55% |

Direct comparison with the earlier pushed round control `97d555be`:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.791 |   56.640 |   +15.20% | +15.20% / +15.57% / +15.12% |
| Large level          |    45.565 |   39.269 |   +13.82% | +14.48% / +15.11% / +12.94% |
| 10,000-row table     |     9.039 |    6.624 |   +26.72% | +26.69% / +23.99% / +27.82% |
| Five Blueprints      |     2.048 |    1.962 |    +4.18% | +4.28% / +0.96% / +5.67%    |
| 138 smaller packages |     9.342 |    8.749 |    +6.35% | +6.22% / +6.28% / +6.96%    |

Direct comparison with the first extension checkpoint `8b8fbaa6`:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.488 |   56.592 |    +7.96% | +7.48% / +8.88% / +7.78% |
| Large level          |    43.043 |   39.220 |    +8.88% | +8.82% / +9.38% / +8.80% |
| 10,000-row table     |     6.992 |    6.614 |    +5.41% | +4.07% / +6.19% / +5.41% |
| Five Blueprints      |     2.052 |    1.962 |    +4.39% | +2.71% / +4.35% / +4.86% |
| 138 smaller packages |     9.279 |    8.763 |    +5.56% | +5.43% / +5.71% / +5.68% |

The library workload preloads bytes and excludes process startup and file reads. Parse plus decode includes dropping the result. Workloads overlap and must not be summed. Improvements from separate variants are not added or multiplied; combined source is measured directly. The same candidate can have different absolute medians in separate measurement windows. Block results expose small or mixed effects. “Cold” in the experiment notes means a layout is rarely reused within a parse; all library timings still have warmups. It does not mean a cold filesystem or CPU cache.

All library operations on the full corpus, compared directly with the pre-session original:

| Operation     | Original ms | Current ms | Less time | Paired blocks               |
| ------------- | ----------: | ---------: | --------: | --------------------------- |
| parse         |      19.244 |     12.121 |   +37.01% | +35.35% / +36.63% / +38.03% |
| combined      |     106.422 |     56.262 |   +47.13% | +47.13% / +47.02% / +46.81% |
| decode        |      87.783 |     43.237 |   +50.75% | +51.38% / +50.38% / +50.23% |
| inspect-json  |     163.831 |    109.586 |   +33.11% | +33.11% / +32.44% / +34.02% |
| inspect-owned |     152.054 |     99.592 |   +34.50% | +34.90% / +34.50% / +34.18% |

Operations with a negative incremental result against the previous source checkpoint are shown explicitly below. Mixed blocks indicate uncertainty; these results are not hidden by the parse-plus-decode aggregate.

| Workload / operation | Previous ms | Current ms | Less time | Paired blocks            |
| -------------------- | ----------: | ---------: | --------: | ------------------------ |
| Large level / parse  |       8.640 |      8.745 |    -1.21% | +1.97% / -4.25% / -1.77% |

## Shipping CLI boundary

Fresh native processes read the file, decode, serialize JSON and transfer stdout to the harness, with a warm filesystem:

| Workload         | Before ms | After ms | Less time | Paired blocks               |
| ---------------- | --------: | -------: | --------: | --------------------------- |
| Large level      |   176.830 |  142.440 |   +19.45% | +15.57% / +22.62% / +24.10% |
| 10,000-row table |    70.319 |   52.383 |   +25.51% | +25.92% / +26.38% / +25.51% |
| One Blueprint    |    14.063 |   13.884 |    +1.27% | +1.27% / +2.76% / +3.65%    |

The single-Blueprint process lane differs from the five-Blueprint library lane. A small mixed process result does not establish a startup win. These are direct original-to-checkpoint results, not an inferred incremental CLI improvement from older measurement windows.

## Why the source changes work

The first extension checkpoint reuses validated layouts and semantic recipes, prepares recipes only after a layout is actually reused, writes values into final record slots, resolves struct facts once, and borrows temporary names and initial native ancestry paths. DataTable rows permit changing payload widths and a bounded set of omitted layouts. All other header bytes and the terminator still match before replay, and a miss preserves the cursor for the ordinary parser. Learning limits bound optional acceleration metadata; they never reject a package.

Current payloads, flags, versions, GUIDs, bounds, filters and native postprocessing remain part of decoding. Shortcuts return to the existing diagnostic path on unusual inputs. Rich types, spans, raw reasons and owned outputs are compared with the initial parser. New callback APIs and changed Rust field types are reported separately from existing owned API results.

Core 2 reads a complete 12-byte type-name prefix together only when every field is valid. Short, negative, out-of-range and resource-limited cases follow the original field-by-field failure path, preserving cursor position, error priority, depth and allocation checks. This reduces repeated cursor/Result work without accepting a different wire format.

For schema lookup, byte length chooses a small candidate list before full string comparison. This index applies only to the immutable built-in model. Caller-owned models retain vector order, duplicate precedence and mutation behavior. Qualified native identities still require both the complete module and name to match, including the existing overrides. Hash maps, sorted indexes and nested maps were measured separately; none was selected merely because of its asymptotic complexity.

ANSI strings retain Unreal’s one-byte-to-one-code-point mapping; valid UTF-8 byte sequences are still interpreted as separate Latin-1 code units. encoding_rs performs the conversion with fewer intermediate operations. Its ASCII case copies already validated bytes without entering the previous UTF-8 lossy converter. Its alloc-only feature set adds six locked dependencies to the root graph, with no existing package upgrades. Version 0.8.42 declares the same Rust 1.88 minimum as this parser; verification here used stable Rust 1.99.1, not a fresh 1.88 toolchain.

The tradeoffs are bounded acceleration metadata, one-time index construction, more source to maintain, and the string-conversion dependency. All package/header checks and owned output fields remain required. Row-by-row callbacks demonstrated a different and sometimes faster ownership boundary, but exposing that boundary would be a separate API decision. Their numbers do not count toward this existing-API result.

## Allocation and trace evidence

The counting System allocator reports logical allocation requests, not RSS or allocator page usage. It parses a package, retains decoded exports, projects text/Blueprint data and drops the result. Request totals cover the corpus; peak is maximum additional live requested bytes for a package. Warm passes 2/3 exclude initialization/digest work. Instrumented times are excluded from speed claims.

| Metric                  |   Original | Checkpoint | Reduction |
| ----------------------- | ---------: | ---------: | --------: |
| alloc_count             |    864,957 |    628,286 |   +27.36% |
| alloc_bytes             | 99,276,777 | 59,284,532 |   +40.28% |
| peak_live_bytes         | 34,713,040 | 28,943,237 |   +16.62% |
| inspect_peak_live_bytes | 27,347,894 | 26,209,954 |    +4.16% |

Fixed-work counters and traces are diagnostic evidence, not throughput measurements. The A55/A78 PMU aliases on this kernel report identical events and are counted once; their labels do not identify the actual CPU. Raw counters, self/call-tree reports, sample-loss logs and source-specific binaries remain preserved. Lossless trace-compression hashes identify any archived raw captures.

Fixed-work comparison with the previous source checkpoint uses the same 105 corpus sweeps (101 samples, three warmups and one calibration):

| Event         |       Previous |        Current | Reduction |
| ------------- | -------------: | -------------: | --------: |
| instructions  | 32,364,073,441 | 29,479,464,369 |    +8.91% |
| cycles        | 14,730,446,554 | 13,451,646,279 |    +8.68% |
| branches      |  6,426,996,838 |  5,715,755,589 |   +11.07% |
| branch-misses |     21,440,862 |     18,553,614 |   +13.47% |

The new 249 Hz DWARF capture reports zero lost samples. Metadata cloning/drop, allocation/free, header comparisons and ordinary fallback decoding remain visible; percentages in a profile are shares of that capture, not absolute speed changes.

The metadata census counted 147,607 property records, with GUIDs present in only 46 records. Sparse GUID storage improved the large table but slowed other workloads and changed Rust field types, so record-size reduction alone was not a sufficient selection rule. A nested-header cache hit 25,125 times in 25,956 reads yet failed to improve throughput. Sharing type nodes, broader word comparisons and smaller handles also sometimes reduced work without reducing elapsed time. The exact causes of some layout/code-generation regressions remain unresolved.

## Every measured source trial and comparison

There are 104 numbered measured variants/comparisons across 127 matrices. Repeat comparisons are not new source variants. Each comparison names its actual baseline. Visitor/row callbacks consume borrowed results; their ownership boundary differs from retaining a complete owned result. Derived stress packages and codec probes are parser tests, not fresh Unreal saves. Prepared but unrun ideas are not described as failed measurements.

### 32: Stable generic-object routing

Cache repeated class dispatch only for providers that promise stable class information. Rejected: small/Blueprint/table regressions outweighed modest level gains.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.803 |   66.297 |    +0.76% | +1.09% / +0.04% / +0.94% |
| Large level          |    45.856 |   45.183 |    +1.47% | +1.17% / +1.47% / +1.82% |
| 10,000-row table     |     9.037 |    9.655 |    -6.84% | -0.26% / -8.14% / -6.84% |
| Five Blueprints      |     2.053 |    2.084 |    -1.50% | -1.35% / -1.70% / -1.50% |
| 138 smaller packages |     9.347 |    9.563 |    -2.32% | -2.10% / -2.90% / -2.32% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.495 |  121.396 |    +0.90% | +1.26% / +2.71% / -2.58% |
| Large level          |    86.869 |   86.320 |    +0.63% | +0.40% / +1.20% / +2.58% |
| 10,000-row table     |    19.320 |   19.412 |    -0.47% | -4.02% / -0.62% / +0.07% |
| Five Blueprints      |     2.451 |    2.493 |    -1.71% | -1.71% / -9.37% / -1.78% |
| 138 smaller packages |    12.879 |   13.131 |    -1.96% | -2.09% / -1.96% / -1.99% |

### 33: Fuse replay construction and value decoding

Validate all headers, then construct and decode each record in one walk. Rejected: decoding a temporary record increased copies and slowed tables.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    67.446 |   68.937 |    -2.21% | -0.65% / -2.68% / -2.77%  |
| Large level          |    46.172 |   46.837 |    -1.44% | -2.55% / -0.03% / -0.86%  |
| 10,000-row table     |     9.035 |    9.859 |    -9.12% | -12.75% / -8.80% / -6.48% |
| Five Blueprints      |     2.051 |    2.048 |    +0.16% | -0.08% / +0.14% / +0.40%  |
| 138 smaller packages |     9.332 |    9.289 |    +0.46% | +2.50% / +0.62% / +0.18%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.353 |  124.239 |    -0.72% | -1.49% / -0.04% / -0.38% |
| Large level          |    87.007 |   86.757 |    +0.29% | +0.56% / +0.07% / +0.83% |
| 10,000-row table     |    19.322 |   20.317 |    -5.15% | -5.17% / -4.45% / -1.73% |
| Five Blueprints      |     2.449 |    2.456 |    -0.30% | +0.21% / +0.17% / -0.56% |
| 138 smaller packages |    12.894 |   12.806 |    +0.68% | +0.37% / +0.95% / +0.53% |

### 34: Prepare common scalar decisions

Attach scalar decoding plans to each validated layout, alongside temporary-record fusion. Rejected: planning did not offset the temporary-record cost.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    66.814 |   67.223 |    -0.61% | -0.27% / -0.61% / -2.54%  |
| Large level          |    45.944 |   45.549 |    +0.86% | +0.86% / +0.29% / +0.91%  |
| 10,000-row table     |     8.997 |   10.066 |   -11.88% | -9.79% / -12.41% / -7.32% |
| Five Blueprints      |     2.048 |    2.050 |    -0.08% | +0.32% / -0.27% / -0.09%  |
| 138 smaller packages |     9.338 |    9.340 |    -0.02% | +3.00% / -0.23% / +0.10%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.801 |  122.301 |    -0.41% | -0.48% / +0.54% / -1.85% |
| Large level          |    87.243 |   86.508 |    +0.84% | +0.55% / +0.29% / +2.17% |
| 10,000-row table     |    19.348 |   20.379 |    -5.33% | -5.61% / -0.91% / -6.07% |
| Five Blueprints      |     2.450 |    2.461 |    -0.44% | -0.53% / +0.01% / -0.60% |
| 138 smaller packages |    13.224 |   12.843 |    +2.88% | -0.63% / +0.59% / +2.88% |

### 35: Validate common leaf headers with fixed words

Compare all 24 stable leaf-header bytes and the current bool flag using safe integer loads. Retained as the common leaf-header validator in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    67.148 |   66.629 |    +0.77% | +1.25% / +1.45% / -0.19%   |
| Large level          |    46.562 |   45.792 |    +1.65% | +3.02% / +0.81% / -0.42%   |
| 10,000-row table     |     8.967 |    8.069 |   +10.01% | +10.58% / +9.35% / +11.73% |
| Five Blueprints      |     2.051 |    2.048 |    +0.16% | +0.84% / -0.18% / -0.04%   |
| 138 smaller packages |     9.388 |    9.342 |    +0.49% | +3.50% / +0.56% / -0.48%   |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.132 |  122.168 |    -0.03% | +1.84% / -0.24% / -0.15% |
| Large level          |    87.856 |   86.763 |    +1.24% | +1.52% / +0.78% / +0.92% |
| 10,000-row table     |    19.223 |   18.446 |    +4.04% | +4.62% / +4.04% / +3.84% |
| Five Blueprints      |     2.458 |    2.458 |    -0.03% | -0.17% / +0.19% / +0.12% |
| 138 smaller packages |    12.875 |   12.777 |    +0.76% | +1.24% / +0.76% / -3.75% |

### 37: Decode in the final vector slot

Push the record before decoding so its value is written in its final location. Retained final-slot decoding as part of core1; not a useful independent winner.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.492 |   66.146 |    +0.52% | +1.87% / +0.13% / +0.52% |
| Large level          |    45.699 |   45.424 |    +0.60% | +1.00% / -0.07% / +0.48% |
| 10,000-row table     |     8.939 |    8.676 |    +2.95% | +2.85% / +4.05% / +2.46% |
| Five Blueprints      |     2.049 |    2.055 |    -0.27% | -0.69% / -0.27% / -0.44% |
| 138 smaller packages |     9.384 |    9.370 |    +0.15% | +3.36% / -0.39% / -1.01% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.923 |  119.176 |    +2.25% | +1.98% / +1.77% / +2.42% |
| Large level          |    87.394 |   85.254 |    +2.45% | +2.16% / +2.91% / +2.26% |
| 10,000-row table     |    19.313 |   18.882 |    +2.23% | +1.82% / +2.23% / +3.34% |
| Five Blueprints      |     2.454 |    2.458 |    -0.15% | -0.15% / -0.23% / -4.31% |
| 138 smaller packages |    13.264 |   12.837 |    +3.22% | +0.20% / +3.83% / -0.92% |

### 38: Compact privately owned object paths

Use Box<str> inside the private ObjectPath representation while preserving its public methods. Not retained in core1: compatible private representation, but broader combinations regressed cold/level lanes.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.506 |   65.948 |    +0.84% | +1.52% / +0.78% / +0.56% |
| Large level          |    45.713 |   44.981 |    +1.60% | +1.87% / +0.97% / +2.70% |
| 10,000-row table     |     9.019 |    9.037 |    -0.20% | +0.28% / +0.40% / -1.00% |
| Five Blueprints      |     2.048 |    2.054 |    -0.26% | +0.06% / -0.75% / -0.23% |
| 138 smaller packages |     9.327 |    9.381 |    -0.58% | -0.11% / -0.48% / -1.11% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.547 |  120.259 |    +1.06% | +1.55% / +2.32% / +0.73% |
| Large level          |    87.406 |   85.643 |    +2.02% | +2.14% / +1.49% / +2.64% |
| 10,000-row table     |    19.215 |   19.277 |    -0.33% | -0.50% / -0.64% / +0.30% |
| Five Blueprints      |     2.453 |    2.449 |    +0.16% | +0.20% / -0.02% / +0.10% |
| 138 smaller packages |    12.862 |   12.889 |    -0.21% | -0.21% / +1.22% / -0.42% |

### 39: Prepare scalars with separate construction and decoding walks

Keep ordinary two-pass ownership while reusing scalar plans. Not retained alone: weak aggregate benefit.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.399 |   66.916 |    +0.72% | +0.78% / +0.38% / +1.09% |
| Large level          |    45.895 |   45.710 |    +0.40% | +0.25% / +1.66% / -0.74% |
| 10,000-row table     |     8.977 |    9.060 |    -0.93% | -0.18% / -2.33% / +0.28% |
| Five Blueprints      |     2.045 |    2.045 |    -0.01% | -2.42% / +0.01% / +0.84% |
| 138 smaller packages |     9.331 |    9.315 |    +0.17% | +4.90% / -0.54% / +0.37% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.838 |  120.084 |    +3.03% | +3.03% / +3.33% / -1.55% |
| Large level          |    87.228 |   85.563 |    +1.91% | +2.28% / +1.30% / +2.00% |
| 10,000-row table     |    19.352 |   19.292 |    +0.31% | -0.09% / +0.21% / +1.50% |
| Five Blueprints      |     2.455 |    2.448 |    +0.27% | +0.27% / +0.33% / +0.76% |
| 138 smaller packages |    12.860 |   12.728 |    +1.02% | +1.02% / +0.99% / +1.09% |

### 41: Cache complete struct-resolution facts

Memoize pure qualified-struct facts within one decode session. Rejected: small-package overhead and hashing/cloning costs.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.591 |   66.093 |    +0.75% | +0.82% / +0.23% / +0.43% |
| Large level          |    45.761 |   45.055 |    +1.54% | +2.43% / +0.67% / +1.54% |
| 10,000-row table     |     9.024 |    9.048 |    -0.26% | -0.27% / +1.34% / -0.94% |
| Five Blueprints      |     2.051 |    2.074 |    -1.12% | -0.99% / -1.26% / -1.12% |
| 138 smaller packages |     9.328 |    9.485 |    -1.69% | -1.69% / -1.55% / -1.71% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.326 |  122.323 |    +0.00% | +1.25% / -0.28% / -1.40% |
| Large level          |    87.486 |   86.683 |    +0.92% | +0.51% / +0.32% / +2.00% |
| 10,000-row table     |    19.380 |   19.451 |    -0.37% | +0.81% / -1.02% / -0.42% |
| Five Blueprints      |     2.449 |    2.491 |    -1.70% | -1.31% / -3.77% / -1.27% |
| 138 smaller packages |    12.871 |   13.048 |    -1.37% | -0.71% / -1.47% / -1.57% |

### 42: Store fewer redundant header ranges

Recover expected header bytes from the parent source slice. Rejected: extra lookup/bounds work slowed tables.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.394 |   66.516 |    -0.18% | +0.20% / -0.52% / +0.40% |
| Large level          |    45.863 |   46.112 |    -0.54% | -0.59% / +0.91% / -0.64% |
| 10,000-row table     |     9.038 |    9.346 |    -3.41% | -2.61% / -3.15% / -4.00% |
| Five Blueprints      |     2.048 |    2.040 |    +0.37% | +3.92% / +0.37% / +0.43% |
| 138 smaller packages |     9.349 |    9.327 |    +0.24% | -0.03% / +0.74% / -2.15% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.999 |  121.375 |    +0.51% | +1.38% / +0.30% / -0.05% |
| Large level          |    86.997 |   86.972 |    +0.03% | -1.09% / +0.95% / -0.12% |
| 10,000-row table     |    19.213 |   19.686 |    -2.47% | -2.80% / -2.57% / -1.13% |
| Five Blueprints      |     2.449 |    2.448 |    +0.05% | -0.01% / +0.10% / -0.30% |
| 138 smaller packages |    12.891 |   12.826 |    +0.50% | +3.44% / +0.50% / +0.28% |

### 44: Decode UTF-16 directly from bytes

Avoid the intermediate u16 vector; retain old malformed-input diagnostics. Rejected: no broad throughput gain.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.798 |   66.847 |    -0.07% | -0.70% / -0.18% / +0.46% |
| Large level          |    46.344 |   45.735 |    +1.31% | +0.72% / +2.07% / +0.90% |
| 10,000-row table     |     8.964 |    9.016 |    -0.58% | +0.24% / -0.74% / +0.43% |
| Five Blueprints      |     2.045 |    2.058 |    -0.64% | -0.66% / -0.77% / -0.44% |
| 138 smaller packages |     9.322 |    9.339 |    -0.19% | +0.21% / -0.19% / -0.60% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.252 |  122.491 |    -0.20% | -0.13% / +0.15% / -0.23% |
| Large level          |    87.659 |   86.874 |    +0.90% | -0.07% / +0.80% / +0.97% |
| 10,000-row table     |    19.306 |   19.261 |    +0.23% | +0.23% / +0.02% / -0.05% |
| Five Blueprints      |     2.452 |    2.473 |    -0.89% | -2.10% / -0.74% / -0.66% |
| 138 smaller packages |    12.889 |   12.904 |    -0.12% | -2.76% / +0.11% / -0.12% |

### 45: Build binary math breadcrumbs lazily

Delay formatting math error paths until an error needs them. Rejected: broader regressions despite a plausible allocation saving.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.833 |   67.876 |    -1.56% | -2.20% / -1.21% / -0.20% |
| Large level          |    46.265 |   45.991 |    +0.59% | +0.59% / -0.36% / +1.24% |
| 10,000-row table     |     9.022 |    9.044 |    -0.24% | -2.19% / -0.22% / +0.14% |
| Five Blueprints      |     2.047 |    2.088 |    -2.03% | -2.34% / -1.32% / -1.89% |
| 138 smaller packages |     9.327 |    9.459 |    -1.41% | -2.60% / -1.41% / -1.12% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.798 |  122.922 |    -0.10% | -1.41% / -0.00% / +0.08% |
| Large level          |    87.158 |   87.830 |    -0.77% | +0.73% / -4.38% / -0.77% |
| 10,000-row table     |    19.325 |   19.324 |    +0.00% | +0.11% / +0.00% / +0.18% |
| Five Blueprints      |     2.452 |    2.490 |    -1.54% | -1.71% / +2.44% / -1.71% |
| 138 smaller packages |    12.909 |   12.960 |    -0.40% | -2.30% / +2.51% / -0.40% |

### 46: Read vector/rotator components as one block

Validate a complete math value once, preserving ordinary truncation diagnostics. Rejected: no broad gain in the generic helper.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.907 |   66.829 |    +0.12% | +0.78% / +0.12% / -1.23% |
| Large level          |    45.668 |   46.318 |    -1.43% | -2.59% / -1.43% / -0.44% |
| 10,000-row table     |     9.080 |    9.002 |    +0.85% | -1.69% / +2.26% / +1.61% |
| Five Blueprints      |     2.050 |    2.045 |    +0.28% | +0.13% / +0.08% / +0.28% |
| 138 smaller packages |     9.314 |    9.325 |    -0.12% | -0.15% / +0.31% / -0.16% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.662 |  122.763 |    -0.08% | -0.08% / +0.47% / -1.13% |
| Large level          |    86.698 |   87.371 |    -0.78% | -1.13% / -0.71% / -0.28% |
| 10,000-row table     |    19.511 |   19.276 |    +1.20% | +0.91% / +1.69% / +0.37% |
| Five Blueprints      |     2.451 |    2.456 |    -0.18% | -0.20% / -0.37% / -0.18% |
| 138 smaller packages |    12.876 |   12.911 |    -0.27% | +0.01% / -0.36% / -0.27% |

### 49: Use compact struct-fact cache keys

Key pure facts by identity and module names instead of cloning/hashing a complete type tree. Rejected: cold workloads still regressed.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.693 |   65.980 |    +1.07% | +1.07% / +0.60% / +1.46% |
| Large level          |    45.935 |   45.689 |    +0.53% | +0.53% / +0.86% / +0.43% |
| 10,000-row table     |     9.039 |    9.181 |    -1.58% | -3.11% / -2.43% / +1.48% |
| Five Blueprints      |     2.044 |    2.112 |    -3.33% | -3.10% / -3.34% / -6.94% |
| 138 smaller packages |     9.351 |    9.599 |    -2.65% | -2.36% / -2.36% / -2.93% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.340 |  122.052 |    +0.24% | -0.20% / +0.44% / +1.02% |
| Large level          |    87.179 |   86.470 |    +0.81% | +1.88% / +0.81% / +0.08% |
| 10,000-row table     |    19.222 |   19.581 |    -1.86% | -1.16% / -2.00% / -1.28% |
| Five Blueprints      |     2.456 |    2.565 |    -4.42% | -7.17% / -4.42% / -3.22% |
| 138 smaller packages |    12.867 |   13.157 |    -2.25% | -2.43% / -2.02% / -2.39% |

### 50: Use a small linear struct-fact cache

Replace hashing with a bounded contiguous scan. Not retained: warm level gain with consistent cold-package regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.813 |   65.747 |    +1.59% | +1.13% / +2.35% / +1.32% |
| Large level          |    46.176 |   44.594 |    +3.43% | +2.80% / +4.31% / +3.83% |
| 10,000-row table     |     8.971 |    9.139 |    -1.87% | -1.96% / -0.55% / -2.33% |
| Five Blueprints      |     2.047 |    2.102 |    -2.68% | -2.57% / -2.68% / -2.58% |
| 138 smaller packages |     9.327 |    9.497 |    -1.82% | -1.62% / -2.06% / -1.82% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.828 |  123.496 |    -0.54% | -1.04% / -1.48% / +2.53% |
| Large level          |    86.995 |   87.623 |    -0.72% | -1.49% / -0.58% / -0.66% |
| 10,000-row table     |    19.275 |   19.701 |    -2.21% | -2.21% / -0.30% / -3.17% |
| Five Blueprints      |     2.455 |    2.523 |    -2.77% | -4.08% / -2.71% / -2.77% |
| 138 smaller packages |    12.872 |   13.136 |    -2.05% | -1.83% / -2.05% / -2.73% |

### 51: Share immutable type-parameter slices

Reduce repeated metadata cloning using Arc-backed slices. Rejected: cold regressions and a public Rust field-type change.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.891 |   67.197 |    -0.46% | +0.28% / -1.23% / -0.46% |
| Large level          |    45.901 |   46.344 |    -0.97% | -0.67% / -1.15% / -1.61% |
| 10,000-row table     |     9.030 |    8.648 |    +4.23% | +5.87% / +4.05% / +3.16% |
| Five Blueprints      |     2.046 |    2.118 |    -3.55% | -3.91% / -3.33% / -3.55% |
| 138 smaller packages |     9.348 |    9.732 |    -4.11% | -3.36% / -4.04% / -7.10% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.869 |  121.454 |    +0.34% | +0.07% / +2.79% / +0.34% |
| Large level          |    86.980 |   86.233 |    +0.86% | +0.86% / -1.87% / +1.31% |
| 10,000-row table     |    19.371 |   19.238 |    +0.68% | +0.36% / +0.74% / +0.49% |
| Five Blueprints      |     2.438 |    2.522 |    -3.42% | +2.67% / -3.50% / -3.41% |
| 138 smaller packages |    12.871 |   13.246 |    -2.92% | -2.93% / -3.17% / -2.92% |

### 52: Use thin shared pointers to parameter vectors

Shrink type nodes further using Arc<Vec<...>>. Rejected: severe table slowdown and a public API change.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.854 |   68.408 |    -2.32% | -2.32% / -1.51% / -4.02%    |
| Large level          |    45.651 |   45.185 |    +1.02% | +3.09% / +1.02% / +0.92%    |
| 10,000-row table     |     9.040 |   10.845 |   -19.97% | -19.87% / -20.04% / -20.12% |
| Five Blueprints      |     2.051 |    2.090 |    -1.92% | -1.84% / -3.44% / -1.77%    |
| 138 smaller packages |     9.359 |    9.619 |    -2.78% | -2.64% / -2.57% / -3.00%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   121.613 |  121.743 |    -0.11% | +1.10% / -0.66% / +0.16%    |
| Large level          |    87.005 |   85.096 |    +2.19% | +1.31% / +2.30% / +2.52%    |
| 10,000-row table     |    19.318 |   21.406 |   -10.81% | -10.98% / -10.91% / -10.75% |
| Five Blueprints      |     2.443 |    2.495 |    -2.12% | -1.56% / -2.43% / -2.12%    |
| 138 smaller packages |    12.862 |   12.990 |    -1.00% | -0.77% / -0.39% / -1.12%    |

### 53: Combine compact paths and header words

Test the combined result rather than adding independent percentages. Not retained: table/corpus gains with level and Blueprint regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    66.986 |   65.638 |    +2.01% | +2.96% / +1.65% / +2.40%   |
| Large level          |    45.748 |   46.206 |    -1.00% | -1.00% / -1.15% / -0.26%   |
| 10,000-row table     |     9.021 |    8.068 |   +10.56% | +9.80% / +10.27% / +10.81% |
| Five Blueprints      |     2.045 |    2.063 |    -0.90% | -0.64% / -0.99% / -0.84%   |
| 138 smaller packages |     9.330 |    9.467 |    -1.46% | +2.62% / -1.52% / -1.69%   |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.899 |  119.063 |    +2.33% | +2.22% / +3.56% / +2.14% |
| Large level          |    87.822 |   85.193 |    +2.99% | +2.41% / +2.99% / +2.74% |
| 10,000-row table     |    19.289 |   18.316 |    +5.04% | +5.12% / +4.90% / +5.46% |
| Five Blueprints      |     2.455 |    2.443 |    +0.52% | +0.06% / +0.25% / +0.94% |
| 138 smaller packages |    12.876 |   12.954 |    -0.61% | -0.61% / -0.88% / -0.13% |

### 54: Prepare vector/rotator recipes per layout

Resolve math identity once and decode exact-width values from validated layouts. Retained math recipes in the combined core1 implementation;24192 guard/bit cases passed.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.586 |   64.954 |    +2.45% | +2.75% / +2.45% / +1.74% |
| Large level          |    46.021 |   44.493 |    +3.32% | +2.93% / +2.28% / +6.54% |
| 10,000-row table     |     8.989 |    8.633 |    +3.97% | +3.97% / +3.76% / +5.45% |
| Five Blueprints      |     2.046 |    2.056 |    -0.52% | -1.85% / -0.67% / -0.36% |
| 138 smaller packages |     9.332 |    9.404 |    -0.77% | -0.77% / -0.81% / -0.86% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.100 |  118.215 |    +3.18% | +0.16% / +3.45% / +3.32% |
| Large level          |    87.706 |   83.809 |    +4.44% | +2.48% / +5.09% / +3.27% |
| 10,000-row table     |    19.277 |   18.900 |    +1.96% | +1.96% / +1.93% / +2.62% |
| Five Blueprints      |     2.449 |    2.459 |    -0.40% | -0.27% / -0.72% / -0.24% |
| 138 smaller packages |    12.887 |   12.864 |    +0.17% | -0.10% / -0.10% / +4.22% |

### 55: Allocate single-child shared metadata directly

Avoid an intermediate vector for the overwhelmingly common one-child case. Rejected for production: public API change and cold-workload regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.523 |   65.724 |    +1.20% | +1.86% / +1.20% / -0.36% |
| Large level          |    45.958 |   45.186 |    +1.68% | +2.11% / +2.25% / +0.34% |
| 10,000-row table     |     9.024 |    8.705 |    +3.54% | +2.58% / +3.93% / +8.45% |
| Five Blueprints      |     2.046 |    2.109 |    -3.09% | -1.62% / -2.79% / -4.46% |
| 138 smaller packages |     9.342 |    9.605 |    -2.82% | -2.91% / -2.82% / -2.91% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.936 |  120.745 |    +0.98% | +0.68% / +1.24% / +0.31% |
| Large level          |    86.977 |   84.919 |    +2.37% | +1.98% / +2.84% / +2.37% |
| 10,000-row table     |    19.313 |   19.322 |    -0.05% | -1.08% / +3.89% / +0.33% |
| Five Blueprints      |     2.448 |    2.502 |    -2.18% | -2.42% / -2.31% / -2.02% |
| 138 smaller packages |    12.904 |   13.100 |    -1.52% | -1.88% / -1.65% / +0.11% |

### 56: Use a thin shared single-child node

Store one child directly behind an Arc; use a vector for longer lists. Rejected: severe table slowdown, public API change.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.576 |   68.489 |    -2.87% | +1.26% / -3.11% / -5.29%    |
| Large level          |    46.013 |   45.715 |    +0.65% | +0.05% / +2.23% / -0.94%    |
| 10,000-row table     |     9.032 |   10.956 |   -21.30% | -21.52% / -22.50% / -19.73% |
| Five Blueprints      |     2.049 |    2.120 |    -3.47% | -3.47% / -3.57% / -2.14%    |
| 138 smaller packages |     9.331 |    9.614 |    -3.04% | -2.76% / -3.39% / -3.04%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   121.707 |  123.348 |    -1.35% | -1.36% / -1.31% / -1.75%    |
| Large level          |    86.931 |   86.942 |    -0.01% | +0.23% / +0.10% / -1.81%    |
| 10,000-row table     |    19.380 |   21.445 |   -10.66% | -11.06% / -11.20% / -10.26% |
| Five Blueprints      |     2.440 |    2.533 |    -3.83% | -0.20% / -3.79% / -4.18%    |
| 138 smaller packages |    12.877 |   13.162 |    -2.21% | -2.40% / -2.42% / -1.79%    |

### 57: Borrow invariant decode context

Pass a small depth-plus-root-reference value through recursion. Rejected alone: smaller arguments did not reliably improve elapsed time.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.659 |   67.073 |    -0.62% | -0.88% / -0.62% / +0.19% |
| Large level          |    45.751 |   45.959 |    -0.46% | -0.98% / +0.71% / -1.49% |
| 10,000-row table     |     9.034 |    8.979 |    +0.60% | +0.18% / +3.73% / +1.11% |
| Five Blueprints      |     2.048 |    2.064 |    -0.76% | -1.00% / -0.49% / -0.61% |
| 138 smaller packages |     9.339 |    9.377 |    -0.40% | -0.53% / -0.51% / -0.24% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.457 |  122.110 |    -0.54% | -0.61% / -0.59% / -0.43% |
| Large level          |    87.144 |   87.927 |    -0.90% | -0.50% / -0.40% / -0.90% |
| 10,000-row table     |    19.271 |   19.319 |    -0.25% | -0.90% / +0.70% / -0.25% |
| Five Blueprints      |     2.451 |    2.471 |    -0.79% | -0.09% / -1.01% / -0.69% |
| 138 smaller packages |    12.891 |   12.897 |    -0.05% | -0.35% / -0.05% / -0.07% |

### 58: Combine compact context and struct facts

Reduce argument size while retaining the bounded fact cache. Not retained: level gains with Blueprint/small regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.575 |   65.230 |    +2.02% | +1.65% / +1.64% / +2.48% |
| Large level          |    45.997 |   44.624 |    +2.99% | +2.92% / +3.28% / +2.80% |
| 10,000-row table     |     9.026 |    9.035 |    -0.10% | +0.75% / -1.53% / -0.10% |
| Five Blueprints      |     2.044 |    2.096 |    -2.54% | -2.60% / -2.27% / -2.63% |
| 138 smaller packages |     9.337 |    9.451 |    -1.22% | -1.22% / -1.28% / -2.69% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.736 |  122.563 |    -0.68% | -0.68% / -0.15% / -1.87% |
| Large level          |    86.978 |   86.677 |    +0.35% | -0.66% / +0.35% / -0.22% |
| 10,000-row table     |    19.304 |   19.767 |    -2.40% | -1.81% / -1.72% / -3.22% |
| Five Blueprints      |     2.447 |    2.508 |    -2.49% | -2.49% / +0.63% / -2.64% |
| 138 smaller packages |    12.913 |   13.067 |    -1.19% | -1.52% / -1.24% / -0.97% |

### 59: Carry a GUID predicate in private type specs

Store the only needed nonzero-GUID fact rather than copying Option<Guid>. Not retained alone: no reliable broad gain. Expanded codec oracle passed.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.896 |   66.402 |    +0.74% | +0.08% / +1.47% / -1.13% |
| Large level          |    45.589 |   46.215 |    -1.37% | +0.53% / +0.96% / -2.43% |
| 10,000-row table     |     9.019 |    9.055 |    -0.40% | -1.43% / -0.92% / +0.75% |
| Five Blueprints      |     2.049 |    2.058 |    -0.43% | -0.39% / -0.43% / -0.26% |
| 138 smaller packages |     9.331 |    9.349 |    -0.19% | -0.11% / -0.45% / +0.11% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.653 |  121.559 |    +0.08% | -0.19% / -0.07% / +0.57% |
| Large level          |    87.633 |   86.835 |    +0.91% | -0.24% / +1.36% / +0.38% |
| 10,000-row table     |    19.372 |   19.345 |    +0.14% | -0.09% / +0.44% / -3.75% |
| Five Blueprints      |     2.447 |    2.466 |    -0.80% | -0.80% / -0.77% / -0.85% |
| 138 smaller packages |    12.857 |   12.799 |    +0.45% | +0.45% / -1.72% / +0.64% |

### 60: Borrow temporary container type names

Avoid owning a String used only during array/set/map decoding. Retained borrowed temporary container names in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.453 |   65.807 |    +0.97% | +0.56% / +0.60% / +1.56% |
| Large level          |    45.588 |   45.303 |    +0.62% | +0.05% / +1.69% / +2.98% |
| 10,000-row table     |     8.962 |    9.010 |    -0.54% | -0.94% / -0.54% / +3.04% |
| Five Blueprints      |     2.045 |    2.034 |    +0.56% | +0.59% / +0.39% / +0.51% |
| 138 smaller packages |     9.333 |    9.392 |    -0.63% | +0.53% / -0.50% / -3.60% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.138 |  120.785 |    +1.11% | +0.26% / +1.00% / +1.24% |
| Large level          |    86.773 |   85.801 |    +1.12% | +1.15% / +1.71% / -0.12% |
| 10,000-row table     |    19.343 |   19.248 |    +0.49% | +0.21% / +0.39% / +0.55% |
| Five Blueprints      |     2.449 |    2.439 |    +0.43% | +0.57% / +0.51% / -5.25% |
| 138 smaller packages |    12.900 |   12.777 |    +0.96% | +1.10% / +0.32% / +2.88% |

### 61: Resolve struct identity and module once

Build all pure facts from one name/module resolution instead of repeated helper lookups. Retained single-pass struct facts in core1; frozen helper equivalence cases passed.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.730 |   66.432 |    +0.45% | +1.45% / +0.49% / +0.35% |
| Large level          |    46.361 |   44.838 |    +3.28% | +4.62% / +2.40% / +3.57% |
| 10,000-row table     |     9.032 |    9.154 |    -1.35% | -1.08% / -1.35% / -1.80% |
| Five Blueprints      |     2.080 |    2.055 |    +1.19% | +3.35% / -0.57% / +1.53% |
| 138 smaller packages |     9.333 |    9.342 |    -0.10% | -0.10% / +0.06% / -0.06% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.778 |  120.217 |    +1.28% | +0.74% / +1.17% / +1.85% |
| Large level          |    86.890 |   85.492 |    +1.61% | +1.61% / +2.20% / +1.91% |
| 10,000-row table     |    19.325 |   19.390 |    -0.34% | -0.02% / -1.28% / -0.70% |
| Five Blueprints      |     2.443 |    2.453 |    -0.43% | -0.27% / -3.98% / -0.63% |
| 138 smaller packages |    12.847 |   12.788 |    +0.46% | +0.39% / +0.46% / +0.46% |

### 62: Combine small scope and small type spec

Test argument-size reductions together. Rejected: consistent corpus and level regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.706 |   67.099 |    -0.59% | -1.12% / -0.59% / -0.49% |
| Large level          |    45.615 |   46.627 |    -2.22% | -2.48% / -2.22% / -1.30% |
| 10,000-row table     |     9.012 |    8.896 |    +1.28% | -0.42% / +1.08% / +1.37% |
| Five Blueprints      |     2.043 |    2.059 |    -0.79% | -0.74% / -0.71% / -1.00% |
| 138 smaller packages |     9.342 |    9.393 |    -0.55% | -0.74% / -1.23% / -0.25% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.549 |  122.091 |    +0.37% | -0.37% / +0.42% / -0.31% |
| Large level          |    87.200 |   87.586 |    -0.44% | -0.92% / -0.44% / +0.55% |
| 10,000-row table     |    19.332 |   19.197 |    +0.70% | -1.83% / +0.73% / +0.47% |
| Five Blueprints      |     2.443 |    2.462 |    -0.79% | -0.79% / -0.79% / -0.77% |
| 138 smaller packages |    12.861 |   12.970 |    -0.85% | -0.31% / -0.85% / -1.07% |

### 63: Combine borrowed names and one-pass struct facts

Remove repeated ownership and identity-resolution work together. Retained its two ownership/resolution components in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.693 |   65.499 |    +1.79% | +1.68% / +1.71% / +2.22% |
| Large level          |    45.581 |   44.808 |    +1.69% | +1.64% / +1.35% / +3.56% |
| 10,000-row table     |     9.048 |    8.989 |    +0.66% | +0.76% / -0.90% / +0.52% |
| Five Blueprints      |     2.042 |    2.031 |    +0.54% | +0.62% / +0.71% / +0.54% |
| 138 smaller packages |     9.365 |    9.223 |    +1.51% | +1.53% / +1.39% / +2.11% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.284 |  120.170 |    +0.92% | -2.01% / +1.16% / +1.14% |
| Large level          |    86.823 |   85.374 |    +1.67% | +1.91% / +1.35% / +2.47% |
| 10,000-row table     |    19.296 |   19.264 |    +0.17% | -0.58% / +0.17% / +0.51% |
| Five Blueprints      |     2.446 |    2.439 |    +0.30% | +0.25% / +0.58% / +0.75% |
| 138 smaller packages |    12.897 |   12.728 |    +1.31% | +1.31% / +2.12% / +1.27% |

### 64: Use prepared math with separate value walk

Isolate planning from fused final-slot construction. The separate construction/value-walk variant was not retained. Its prepared-math idea was incorporated into the later fused recipe path, which avoided the extra walk; the independent variant had mixed table/cold effects.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.587 |   65.185 |    +2.11% | +2.15% / +1.34% / +2.11% |
| Large level          |    45.744 |   44.033 |    +3.74% | +3.78% / +4.61% / +3.64% |
| 10,000-row table     |     9.045 |    9.120 |    -0.83% | +0.42% / -0.83% / -1.75% |
| Five Blueprints      |     2.047 |    2.046 |    +0.01% | -1.36% / -0.06% / +0.43% |
| 138 smaller packages |     9.323 |    9.330 |    -0.08% | +0.01% / -0.11% / -0.37% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.507 |  118.900 |    +2.94% | +1.47% / +3.08% / +5.55% |
| Large level          |    86.972 |   83.808 |    +3.64% | +3.60% / +3.83% / +3.01% |
| 10,000-row table     |    19.242 |   19.282 |    -0.21% | -0.30% / +0.56% / -0.21% |
| Five Blueprints      |     2.443 |    2.449 |    -0.24% | -0.24% / -0.39% / -0.36% |
| 138 smaller packages |    12.897 |   12.819 |    +0.61% | +0.65% / +0.39% / +0.46% |

### 65: Add a direct guarded math-record path

Skip reader/path setup for fully available qualified 24-byte vectors and rotators. Not preferred alone: modest benefit compared with prepared-layout decoding.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.840 |   65.813 |    +1.54% | +2.93% / +1.16% / +0.75% |
| Large level          |    45.298 |   45.184 |    +0.25% | +2.33% / +0.25% / +0.72% |
| 10,000-row table     |     9.042 |    9.079 |    -0.40% | -0.56% / +0.24% / +0.83% |
| Five Blueprints      |     2.043 |    2.047 |    -0.19% | +1.82% / +0.05% / -1.47% |
| 138 smaller packages |     9.322 |    9.331 |    -0.09% | -0.85% / -0.02% / +0.01% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.512 |  120.750 |    +0.63% | -0.46% / +0.51% / +0.80% |
| Large level          |    87.322 |   85.720 |    +1.84% | +2.62% / +0.99% / +1.84% |
| 10,000-row table     |    19.393 |   19.275 |    +0.61% | +0.54% / +0.78% / +0.44% |
| Five Blueprints      |     2.442 |    2.462 |    -0.80% | -0.91% / -0.13% / -0.80% |
| 138 smaller packages |    12.888 |   12.807 |    +0.63% | +0.78% / +0.56% / +0.87% |

### 66: Remove atomic reference counting from shared slices

Diagnostic Rc variant to explore sharing costs. Rejected for production: changes public types and Send/Sync, cold regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.516 |   65.313 |    +1.81% | +1.81% / +3.41% / +0.99% |
| Large level          |    46.347 |   44.359 |    +4.29% | +3.89% / +3.37% / +5.68% |
| 10,000-row table     |     8.955 |    8.663 |    +3.26% | +3.09% / +3.54% / +1.74% |
| Five Blueprints      |     2.044 |    2.082 |    -1.87% | -2.02% / -1.74% / -1.68% |
| 138 smaller packages |     9.329 |    9.478 |    -1.60% | -2.18% / -1.55% / -1.41% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.521 |  120.312 |    +1.80% | +0.87% / +2.20% / +1.89% |
| Large level          |    86.962 |   84.862 |    +2.42% | +2.58% / +2.27% / +3.00% |
| 10,000-row table     |    19.420 |   19.108 |    +1.61% | +2.00% / +0.64% / +4.04% |
| Five Blueprints      |     2.443 |    2.475 |    -1.28% | -1.46% / -1.82% / -1.19% |
| 138 smaller packages |    12.865 |   12.947 |    -0.64% | -1.02% / -0.64% / -0.55% |

### 67: Remove atomics from thin single-child nodes

Diagnostic Rc version of the thin-node representation. Rejected: severe table slowdown persists; breaks public types and Send/Sync.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.643 |   67.952 |    -1.96% | +2.69% / -2.32% / -2.05%    |
| Large level          |    45.537 |   44.626 |    +2.00% | +1.77% / +2.60% / +2.65%    |
| 10,000-row table     |     8.946 |   11.052 |   -23.54% | -22.06% / -30.92% / -23.54% |
| Five Blueprints      |     2.060 |    2.116 |    -2.74% | -2.68% / -3.56% / -0.04%    |
| 138 smaller packages |     9.336 |    9.557 |    -2.36% | -5.49% / -2.36% / -2.24%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   121.948 |  122.575 |    -0.51% | -1.94% / -1.01% / -0.27%    |
| Large level          |    86.932 |   85.543 |    +1.60% | +1.11% / +1.60% / +2.37%    |
| 10,000-row table     |    19.267 |   21.746 |   -12.87% | -12.87% / -11.21% / -13.03% |
| Five Blueprints      |     2.441 |    2.533 |    -3.78% | -3.78% / -3.37% / -3.69%    |
| 138 smaller packages |    12.892 |   13.035 |    -1.11% | -1.93% / -0.82% / -1.11%    |

### 68: Borrow the initial native ancestry path

An ancestry check needs to read the class path, not clone its owned storage. Retained borrowing of the initial native ancestry path in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.678 |   66.245 |    +0.65% | +0.48% / +0.34% / +2.08% |
| Large level          |    46.260 |   45.047 |    +2.62% | +2.62% / +3.30% / +0.92% |
| 10,000-row table     |     8.988 |    8.952 |    +0.41% | -0.31% / +1.64% / +0.08% |
| Five Blueprints      |     2.050 |    2.042 |    +0.43% | +0.60% / +0.76% / +0.28% |
| 138 smaller packages |     9.345 |    9.303 |    +0.45% | -0.02% / +0.45% / +0.49% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.769 |  120.777 |    +0.81% | +1.10% / +0.28% / +1.16% |
| Large level          |    88.150 |   87.066 |    +1.23% | +2.96% / +2.53% / +0.56% |
| 10,000-row table     |    19.411 |   19.311 |    +0.52% | +1.13% / +1.21% / -0.04% |
| Five Blueprints      |     2.447 |    2.454 |    -0.28% | -2.35% / +0.02% / -0.28% |
| 138 smaller packages |    12.906 |   12.799 |    +0.83% | +3.67% / +0.83% / +0.38% |

### 69: Borrow generated-class parent paths too

Read parent object paths from package tables during ancestry traversal. Not retained alone: table regression despite corpus/level gains.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.961 |   66.234 |    +1.08% | +1.08% / +1.13% / +1.08% |
| Large level          |    46.173 |   45.406 |    +1.66% | +0.44% / +0.83% / +2.15% |
| 10,000-row table     |     9.071 |    9.347 |    -3.03% | -3.90% / -3.03% / -3.86% |
| Five Blueprints      |     2.042 |    2.041 |    +0.07% | +0.27% / +0.07% / +0.26% |
| 138 smaller packages |     9.357 |    9.361 |    -0.04% | -4.45% / +0.27% / -0.04% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.654 |  121.427 |    +1.00% | +1.21% / +1.36% / +0.45% |
| Large level          |    87.258 |   86.353 |    +1.04% | +3.97% / +0.18% / +0.69% |
| 10,000-row table     |    19.160 |   19.554 |    -2.06% | -1.89% / -1.90% / -3.45% |
| Five Blueprints      |     2.445 |    2.449 |    -0.17% | -0.03% / -0.17% / -0.47% |
| 138 smaller packages |    12.889 |   12.901 |    -0.10% | +0.20% / +0.37% / -0.38% |

### 70: Borrow reference-validation inputs

Avoid allocating display strings solely to check reference validity. Not retained: corpus -0.26% mixed, table -1.41% mixed and small packages nearly flat. The tiny reference-validation saving did not establish a broad benefit.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.621 |   66.793 |    -0.26% | +0.06% / -1.84% / +0.67% |
| Large level          |    45.950 |   45.637 |    +0.68% | +0.30% / +0.14% / +2.06% |
| 10,000-row table     |     8.908 |    9.034 |    -1.41% | -2.25% / -1.50% / +1.05% |
| Five Blueprints      |     2.049 |    2.043 |    +0.28% | +0.18% / +0.69% / +0.13% |
| 138 smaller packages |     9.328 |    9.335 |    -0.08% | -0.09% / +0.23% / -0.08% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.879 |  121.556 |    +0.26% | +0.46% / +0.24% / +0.55% |
| Large level          |    87.058 |   86.518 |    +0.62% | +0.68% / +1.25% / +0.06% |
| 10,000-row table     |    19.453 |   19.368 |    +0.44% | +0.44% / -0.51% / +1.22% |
| Five Blueprints      |     2.443 |    2.450 |    -0.30% | -0.30% / +0.05% / -3.85% |
| 138 smaller packages |    12.890 |   12.831 |    +0.46% | +0.46% / +1.58% / -3.10% |

### 71: Borrow read-only name comparisons broadly

Use Cow resolution in private comparisons and validation sites. Not retained alone: weak aggregate gain and small-package regression.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.810 |   66.348 |    +0.69% | +0.69% / +0.77% / +0.33% |
| Large level          |    46.073 |   45.870 |    +0.44% | -0.27% / -0.38% / +0.82% |
| 10,000-row table     |     8.990 |    9.012 |    -0.24% | -0.92% / -0.47% / +0.62% |
| Five Blueprints      |     2.050 |    2.050 |    +0.01% | -0.42% / +3.83% / -0.19% |
| 138 smaller packages |     9.311 |    9.440 |    -1.39% | -1.39% / -0.35% / -1.54% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.250 |  121.019 |    +1.01% | +1.49% / +1.02% / +0.19% |
| Large level          |    87.065 |   85.072 |    +2.29% | +1.84% / +4.00% / +2.29% |
| 10,000-row table     |    19.299 |   19.372 |    -0.38% | -0.83% / +0.36% / -0.46% |
| Five Blueprints      |     2.464 |    2.458 |    +0.27% | -0.42% / +0.33% / -0.60% |
| 138 smaller packages |    12.904 |   12.824 |    +0.62% | +0.24% / +0.73% / +0.62% |

### 72: Prepare name, enum, string and math leaves

Reuse validated type interpretation; ordinary decoding owns every unsuccessful probe diagnostic. Retained prepared Name/Enum/String/math leaves and final-slot writes in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    66.638 |   63.834 |    +4.21% | +4.41% / +3.64% / +4.22%  |
| Large level          |    46.364 |   44.593 |    +3.82% | +3.82% / +4.12% / +2.89%  |
| 10,000-row table     |     8.970 |    8.084 |    +9.87% | +10.94% / +9.55% / +9.33% |
| Five Blueprints      |     2.049 |    2.068 |    -0.94% | -0.48% / -0.80% / -1.15%  |
| 138 smaller packages |     9.327 |    9.403 |    -0.81% | -0.83% / -0.96% / +2.14%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.081 |  118.708 |    +2.76% | +1.99% / +2.45% / +4.51% |
| Large level          |    87.587 |   84.973 |    +2.98% | +2.98% / +1.17% / +5.40% |
| 10,000-row table     |    19.275 |   18.284 |    +5.14% | +4.69% / +5.69% / +4.60% |
| Five Blueprints      |     2.449 |    2.469 |    -0.80% | -0.90% / -1.04% / -0.54% |
| 138 smaller packages |    12.895 |   12.908 |    -0.10% | -0.40% / -0.20% / -0.04% |

### 73: Use all leaf plans with a separate value walk

Check whether separate construction and decoding is preferable with more leaf kinds. Not preferred: less gain than final-slot fusion.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.699 |   65.458 |    +1.86% | -2.12% / +3.31% / +1.86% |
| Large level          |    45.885 |   44.279 |    +3.50% | +4.17% / +3.18% / +3.14% |
| 10,000-row table     |     8.946 |    8.511 |    +4.85% | +4.88% / +6.76% / +4.82% |
| Five Blueprints      |     2.049 |    2.048 |    +0.04% | -0.36% / -7.48% / +0.04% |
| 138 smaller packages |     9.343 |    9.381 |    -0.41% | -0.54% / -0.71% / -0.35% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.796 |  118.639 |    +2.59% | +2.55% / +3.02% / +2.19% |
| Large level          |    86.926 |   85.139 |    +2.06% | +4.23% / +2.42% / +2.00% |
| 10,000-row table     |    19.260 |   18.778 |    +2.50% | +2.73% / +2.91% / +2.47% |
| Five Blueprints      |     2.443 |    2.457 |    -0.57% | -0.57% / -0.44% / -0.55% |
| 138 smaller packages |    12.882 |   12.901 |    -0.15% | -0.50% / -0.15% / +0.14% |

### 74: Normalize private type dispatch to an enum

Replace repeated private string comparisons with compact type kinds. Rejected: normalization work did not pay off on this configuration.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.629 |   66.714 |    -0.13% | -0.24% / -0.06% / -0.09% |
| Large level          |    45.690 |   46.403 |    -1.56% | -3.33% / -0.76% / -1.56% |
| 10,000-row table     |     9.040 |    9.064 |    -0.26% | +1.71% / -0.60% / -0.30% |
| Five Blueprints      |     2.052 |    2.087 |    -1.69% | -2.08% / -4.72% / -1.02% |
| 138 smaller packages |     9.340 |    9.376 |    -0.38% | -0.44% / -0.14% / -0.59% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.103 |  124.842 |    -2.24% | -2.24% / -0.20% / -2.60% |
| Large level          |    87.516 |   88.758 |    -1.42% | -1.27% / -1.58% / -1.53% |
| 10,000-row table     |    19.442 |   19.631 |    -0.97% | -0.97% / -1.10% / -0.77% |
| Five Blueprints      |     2.446 |    2.491 |    -1.87% | -2.05% / -1.78% / -1.70% |
| 138 smaller packages |    12.949 |   12.952 |    -0.03% | +2.91% / -0.83% / +0.11% |

### 75: Combine enum dispatch and borrowed context

Test both compact representations together. Rejected: no reliable broad gain.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.432 |   66.797 |    -0.55% | -0.55% / +0.44% / -0.92% |
| Large level          |    45.642 |   45.798 |    -0.34% | -0.34% / -1.71% / +3.59% |
| 10,000-row table     |     9.055 |    8.981 |    +0.81% | +0.85% / +0.05% / +0.24% |
| Five Blueprints      |     2.050 |    2.050 |    -0.02% | -0.10% / -0.29% / -0.02% |
| 138 smaller packages |     9.318 |    9.266 |    +0.56% | +0.74% / +0.58% / -1.17% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.815 |  123.683 |    -1.53% | -0.97% / -2.25% / -1.46% |
| Large level          |    86.833 |   88.194 |    -1.57% | -1.53% / -2.42% / -0.93% |
| 10,000-row table     |    19.283 |   19.671 |    -2.01% | -2.13% / -1.27% / -2.12% |
| Five Blueprints      |     2.447 |    2.454 |    -0.29% | -0.15% / -0.30% / -0.18% |
| 138 smaller packages |    12.882 |   12.828 |    +0.42% | -0.20% / +1.43% / +0.49% |

### 84: Recycle metadata after a streaming callback

Add a visitor that retains reusable metadata while values remain freshly decoded. Not retained: metadata recycling accelerated callback work but imposed regressions on old owned callers and cold packages. Later independent-session and row-only experiments tested the ownership idea separately.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.760 |   68.021 |    -1.89% | -1.83% / -3.00% / -1.46% |
| Large level          |    45.512 |   46.884 |    -3.01% | -1.51% / -4.40% / -2.08% |
| 10,000-row table     |     9.031 |    9.174 |    -1.59% | -2.19% / -1.62% / -0.39% |
| Five Blueprints      |     2.050 |    2.086 |    -1.75% | +4.87% / -1.69% / -2.07% |
| 138 smaller packages |     9.308 |    9.486 |    -1.91% | -6.16% / -0.33% / -1.53% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.409 |  124.355 |    -1.59% | -2.82% / -1.30% / -1.09% |
| Large level          |    86.833 |   88.562 |    -1.99% | -2.19% / -1.84% / -1.39% |
| 10,000-row table     |    19.299 |   19.882 |    -3.02% | -4.39% / -1.67% / -3.02% |
| Five Blueprints      |     2.446 |    2.497 |    -2.07% | -2.02% / -2.57% / -0.79% |
| 138 smaller packages |    12.870 |   13.088 |    -1.69% | -1.34% / -1.95% / -1.83% |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.173 |   66.240 |    +1.39% | +1.85% / -3.45% / +1.35% |
| Large level          |    46.319 |   45.004 |    +2.84% | +1.87% / +3.47% / +2.84% |
| 10,000-row table     |     9.084 |    9.084 |    -0.01% | -0.22% / +0.18% / -0.12% |
| Five Blueprints      |     2.083 |    2.130 |    -2.27% | -2.05% / -1.87% / -2.64% |
| 138 smaller packages |     9.373 |    9.795 |    -4.50% | -4.62% / -4.19% / -4.42% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.384 |  124.788 |    -1.14% | -1.44% / -3.76% / -0.16% |
| Large level          |    88.921 |   88.749 |    +0.19% | +0.19% / +0.12% / +0.91% |
| 10,000-row table     |    19.582 |   19.526 |    +0.28% | +0.47% / -0.05% / +0.96% |
| Five Blueprints      |     2.496 |    2.543 |    -1.90% | -2.02% / -1.76% / -1.90% |
| 138 smaller packages |    12.952 |   13.333 |    -2.94% | -2.89% / -3.36% / -2.94% |

### 85: Use recycled callbacks in streaming JSON

Connect the first visitor design to the existing streaming inspection API. Not retained: JSON gains did not justify the owned-path and cold-package regressions. Later 102/103 tested an independent visitor session and preserved native postprocessing.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.894 |   68.452 |    -2.33% | -1.97% / -2.16% / -2.69% |
| Large level          |    45.589 |   47.634 |    -4.49% | -4.70% / -4.87% / -4.06% |
| 10,000-row table     |     9.075 |    9.230 |    -1.70% | -3.29% / -1.40% / -1.55% |
| Five Blueprints      |     2.070 |    2.106 |    -1.75% | -7.60% / -1.42% / -2.71% |
| 138 smaller packages |     9.313 |    9.616 |    -3.25% | -2.84% / -3.17% / -3.27% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.382 |  120.815 |    +0.47% | +0.50% / +0.82% / +0.28% |
| Large level          |    87.262 |   85.766 |    +1.71% | +1.71% / +2.28% / +0.76% |
| 10,000-row table     |    19.303 |   19.612 |    -1.60% | -1.90% / -2.12% / -1.60% |
| Five Blueprints      |     2.446 |    2.514 |    -2.81% | -2.81% / -2.49% / -3.08% |
| 138 smaller packages |    12.868 |   13.190 |    -2.50% | -2.73% / -1.77% / -3.86% |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.177 |   64.332 |    +4.24% | +3.83% / +4.66% / +4.13% |
| Large level          |    45.803 |   43.521 |    +4.98% | +5.14% / +4.80% / +4.90% |
| 10,000-row table     |     9.192 |    8.973 |    +2.38% | -0.40% / +2.94% / +3.65% |
| Five Blueprints      |     2.081 |    2.082 |    -0.08% | -0.21% / -0.01% / -0.08% |
| 138 smaller packages |     9.376 |    9.483 |    -1.13% | -1.10% / -1.73% / -1.40% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.888 |  121.377 |    +2.03% | +2.74% / +3.20% / +1.76% |
| Large level          |    89.885 |   85.035 |    +5.40% | +5.76% / +3.86% / +4.79% |
| 10,000-row table     |    19.577 |   19.385 |    +0.98% | +0.29% / +0.98% / +1.58% |
| Five Blueprints      |     2.498 |    2.509 |    -0.44% | -0.34% / -0.34% / -0.44% |
| 138 smaller packages |    12.969 |   13.112 |    -1.11% | -1.31% / -2.32% / -0.81% |

### 86: Replay rows with changing payload widths

Check all stable header fields while reading each current payload size. Retained the DataTable variable-width technique in the combined core1 implementation.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.495 |   66.159 |    +0.50% | +0.50% / +1.46% / -0.07% |
| Large level          |    45.845 |   45.292 |    +1.21% | +1.90% / +2.48% / +0.73% |
| 10,000-row table     |     8.960 |    8.973 |    -0.14% | -0.14% / -0.40% / -0.15% |
| Five Blueprints      |     2.048 |    2.045 |    +0.13% | +0.13% / -0.30% / +0.37% |
| 138 smaller packages |     9.337 |    9.341 |    -0.05% | +0.14% / -0.01% / -0.05% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.795 |  120.562 |    +1.01% | +1.48% / +1.07% / +0.55% |
| Large level          |    87.325 |   86.022 |    +1.49% | +1.49% / +1.22% / +4.55% |
| 10,000-row table     |    19.263 |   19.463 |    -1.04% | -0.25% / -1.04% / -1.61% |
| Five Blueprints      |     2.444 |    2.439 |    +0.20% | -0.12% / +0.20% / +0.15% |
| 138 smaller packages |    12.877 |   12.920 |    -0.34% | -0.36% / -0.31% / -2.10% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.186 |    9.098 |   +49.97% | +49.74% / +50.60% / +49.97% |
| stress-width-rotating    |    18.141 |    8.924 |   +50.81% | +51.05% / +52.81% / +50.63% |
| stress-width-shuffled    |    16.641 |    8.921 |   +46.39% | +46.37% / +47.88% / +46.27% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.896 |   19.485 |   +32.57% | +32.81% / +32.57% / +32.11% |
| stress-width-rotating    |    28.927 |   19.349 |   +33.11% | +33.00% / +33.50% / +32.95% |
| stress-width-shuffled    |    27.422 |   19.303 |   +29.61% | +29.75% / +29.15% / +29.67% |

### 87: Use variable-width replay for object streams too

Generalize variable payload validation beyond table rows. Rejected alone: normal corpus and level regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.807 |   68.511 |    -2.55% | -2.90% / -2.17% / -2.89% |
| Large level          |    45.901 |   47.113 |    -2.64% | -3.46% / -3.25% / -2.64% |
| 10,000-row table     |     8.990 |    8.980 |    +0.11% | -0.27% / +1.54% / -0.37% |
| Five Blueprints      |     2.045 |    2.074 |    -1.43% | -1.00% / -1.76% / -0.77% |
| 138 smaller packages |     9.330 |    9.441 |    -1.20% | -0.93% / -1.23% / -1.08% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.025 |  125.938 |    -2.37% | -1.87% / -2.37% / -2.98% |
| Large level          |    86.691 |   90.738 |    -4.67% | -4.67% / -4.52% / -5.55% |
| 10,000-row table     |    19.314 |   19.843 |    -2.74% | -4.44% / -1.11% / -2.74% |
| Five Blueprints      |     2.443 |    2.488 |    -1.84% | -1.80% / -1.77% / -6.46% |
| 138 smaller packages |    12.930 |   13.067 |    -1.06% | -0.92% / +1.44% / -2.11% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.129 |    8.994 |   +50.39% | +50.57% / +50.57% / +49.82% |
| stress-width-rotating    |    18.154 |    8.962 |   +50.64% | +50.79% / +50.22% / +51.00% |
| stress-width-shuffled    |    16.578 |    8.917 |   +46.21% | +46.18% / +46.07% / +47.17% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.898 |   19.693 |   +31.85% | +31.68% / +31.08% / +31.95% |
| stress-width-rotating    |    28.904 |   19.659 |   +31.99% | +31.90% / +31.72% / +32.32% |
| stress-width-shuffled    |    27.272 |   19.632 |   +28.01% | +28.17% / +27.95% / +27.94% |

### 88: Keep several recent table layouts

Use four MRU layouts and disable unsuccessful learning after repeated misses. Retained bounded adaptive row-layout learning in core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.524 |   66.771 |    -0.37% | +0.16% / -0.37% / -0.35% |
| Large level          |    46.031 |   46.058 |    -0.06% | +1.17% / -1.78% / -0.06% |
| 10,000-row table     |     8.959 |    8.714 |    +2.73% | -0.89% / +3.64% / +3.87% |
| Five Blueprints      |     2.043 |    2.056 |    -0.64% | -0.50% / +2.97% / -0.64% |
| 138 smaller packages |     9.322 |    9.373 |    -0.54% | -3.05% / -0.16% / -0.69% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.892 |  122.282 |    -0.32% | +0.04% / -0.32% / -0.21% |
| Large level          |    86.774 |   87.875 |    -1.27% | -1.58% / -0.72% / -1.10% |
| 10,000-row table     |    19.315 |   18.898 |    +2.16% | +2.35% / +1.56% / +1.50% |
| Five Blueprints      |     2.446 |    2.454 |    -0.34% | +2.89% / -0.63% / -0.21% |
| 138 smaller packages |    12.846 |   12.860 |    -0.11% | -0.03% / -0.37% / +0.18% |

API/dataset: **stress**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    18.269 |    9.186 |   +49.72% | +50.75% / +49.68% / +48.97% |
| stress-rotating-eight    |    18.015 |   14.254 |   +20.88% | +20.47% / +23.53% / +20.88% |
| stress-randomized        |    18.309 |   14.710 |   +19.66% | +19.66% / +20.51% / +19.34% |
| stress-mostly-uniform    |    10.468 |    8.703 |   +16.86% | +16.31% / +16.27% / +17.26% |
| stress-width-alternating |    18.239 |    9.020 |   +50.55% | +49.30% / +50.84% / +50.23% |
| stress-width-rotating    |    18.150 |    9.387 |   +48.28% | +48.37% / +48.57% / +47.68% |
| stress-width-shuffled    |    16.542 |   11.494 |   +30.52% | +30.73% / +28.81% / +30.28% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    28.585 |   19.415 |   +32.08% | +32.04% / +31.88% / +32.30% |
| stress-rotating-eight    |    28.614 |   24.514 |   +14.33% | +14.17% / +15.24% / +14.47% |
| stress-randomized        |    29.177 |   25.363 |   +13.07% | +13.07% / +13.18% / +12.53% |
| stress-mostly-uniform    |    20.804 |   19.013 |    +8.61% | +7.69% / +9.20% / +8.61%    |
| stress-width-alternating |    29.048 |   19.302 |   +33.55% | +33.73% / +33.55% / +32.99% |
| stress-width-rotating    |    28.879 |   19.744 |   +31.63% | +31.90% / +31.65% / +31.39% |
| stress-width-shuffled    |    27.438 |   21.961 |   +19.96% | +19.95% / +19.64% / +20.20% |

### 89: Combine adaptive layouts and variable widths

Cover both changing property order/default omission and changing payload sizes. Its adaptive variable-row technique was generalized into 97 and lazy preparation in 112/core1. This standalone implementation was not selected: its table gain coexisted with small/Blueprint regressions.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.583 |   66.517 |    +0.10% | -0.83% / +0.26% / +0.10% |
| Large level          |    45.880 |   46.271 |    -0.85% | -1.82% / +2.69% / -0.85% |
| 10,000-row table     |     8.953 |    8.667 |    +3.20% | +3.20% / +3.16% / +3.36% |
| Five Blueprints      |     2.048 |    2.056 |    -0.42% | -0.44% / -0.43% / -0.42% |
| 138 smaller packages |     9.326 |    9.364 |    -0.41% | -0.41% / -0.36% / -0.42% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.092 |  121.349 |    -0.21% | -1.58% / -0.21% / -0.25% |
| Large level          |    87.090 |   86.739 |    +0.40% | +0.87% / -0.65% / +0.40% |
| 10,000-row table     |    19.235 |   18.970 |    +1.38% | +1.61% / +0.84% / +1.44% |
| Five Blueprints      |     2.447 |    2.469 |    -0.92% | -0.92% / -0.61% / -1.36% |
| 138 smaller packages |    12.862 |   12.895 |    -0.25% | -0.10% / -0.42% / -0.21% |

API/dataset: **stress**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    18.243 |   10.987 |   +39.77% | +39.92% / +40.24% / +36.30% |
| stress-rotating-eight    |    18.323 |   14.034 |   +23.41% | +23.69% / +21.05% / +24.21% |
| stress-randomized        |    18.299 |   14.513 |   +20.69% | +20.63% / +19.97% / +21.34% |
| stress-mostly-uniform    |    10.352 |    9.154 |   +11.56% | +11.31% / +10.96% / +11.95% |
| stress-width-alternating |    18.172 |    8.887 |   +51.09% | +50.89% / +51.09% / +51.19% |
| stress-width-rotating    |    18.177 |    8.912 |   +50.97% | +50.97% / +50.87% / +50.83% |
| stress-width-shuffled    |    16.520 |    8.934 |   +45.92% | +46.04% / +46.01% / +44.95% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    28.651 |   21.359 |   +25.45% | +25.52% / +24.93% / +25.52% |
| stress-rotating-eight    |    28.600 |   24.452 |   +14.50% | +15.47% / +14.52% / +13.61% |
| stress-randomized        |    29.132 |   25.224 |   +13.42% | +11.69% / +14.08% / +13.42% |
| stress-mostly-uniform    |    20.868 |   19.482 |    +6.64% | +6.72% / +6.38% / +6.50%    |
| stress-width-alternating |    28.839 |   19.260 |   +33.21% | +33.18% / +33.01% / +33.38% |
| stress-width-rotating    |    29.050 |   19.273 |   +33.65% | +33.23% / +34.08% / +33.65% |
| stress-width-shuffled    |    27.412 |   19.276 |   +29.68% | +29.69% / +29.54% / +29.43% |

### 90: Separate visitor storage and stable generic routing

Keep the original owned cache layout and decode body while adding an opt-in streaming cache. Experimental only, not retained: old owned API cost, plus missing ordinary native postprocessing hooks identified after measurement. Current456case parity does not establish general equivalence.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.760 |   68.073 |    -1.97% | -1.63% / -1.97% / -2.55% |
| Large level          |    45.556 |   46.639 |    -2.38% | -3.13% / -0.61% / -2.26% |
| 10,000-row table     |     9.026 |    9.109 |    -0.92% | -1.36% / -2.11% / -0.92% |
| Five Blueprints      |     2.048 |    2.099 |    -2.47% | -2.77% / -2.32% / -2.47% |
| 138 smaller packages |     9.332 |    9.502 |    -1.83% | -2.00% / -7.04% / -1.54% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.029 |  122.804 |    -0.63% | -0.12% / -1.41% / -0.63% |
| Large level          |    87.212 |   87.396 |    -0.21% | -0.12% / -1.25% / +0.98% |
| 10,000-row table     |    19.224 |   19.405 |    -0.94% | -2.19% / -0.42% / -0.94% |
| Five Blueprints      |     2.446 |    2.494 |    -1.97% | -2.31% / -1.69% / -2.26% |
| 138 smaller packages |    12.876 |   13.002 |    -0.98% | -0.98% / -1.04% / -0.86% |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.300 |   62.579 |    +7.01% | +6.46% / +7.60% / +7.01% |
| Large level          |    46.151 |   41.961 |    +9.08% | +9.09% / +9.54% / +8.50% |
| 10,000-row table     |     9.110 |    9.006 |    +1.14% | +1.47% / -0.03% / +1.17% |
| Five Blueprints      |     2.083 |    2.087 |    -0.20% | -0.05% / -0.53% / +0.90% |
| 138 smaller packages |     9.394 |    9.575 |    -1.92% | -2.32% / -2.21% / -0.77% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.321 |  121.598 |    +1.40% | +1.16% / +1.22% / +1.92% |
| Large level          |    88.971 |   86.757 |    +2.49% | +2.64% / +2.49% / +2.51% |
| 10,000-row table     |    19.598 |   19.276 |    +1.64% | +2.23% / -0.50% / +1.68% |
| Five Blueprints      |     2.496 |    2.480 |    +0.65% | +0.54% / +0.57% / +0.85% |
| 138 smaller packages |    12.944 |   12.881 |    +0.48% | +0.48% / +0.48% / -2.17% |

### 91: Use the separate visitor in streaming JSON

Measure the consumer-facing result of the second visitor design. Experimental only, not retained: same incomplete generic-object prototype plus JSON integration; later102/103 restore the missing hooks.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.782 |   69.140 |    -3.53% | -6.10% / -3.21% / -3.53%    |
| Large level          |    45.821 |   47.738 |    -4.18% | -4.35% / -4.30% / -2.34%    |
| 10,000-row table     |     8.953 |    9.079 |    -1.41% | -1.51% / -1.76% / -0.75%    |
| Five Blueprints      |     2.046 |    2.292 |   -12.05% | -12.01% / -10.18% / -15.28% |
| 138 smaller packages |     9.344 |   10.029 |    -7.32% | -7.17% / -7.56% / -7.28%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   122.576 |  116.645 |    +4.84% | +4.05% / +5.23% / +3.82%    |
| Large level          |    87.828 |   81.491 |    +7.22% | +8.07% / +7.08% / +7.22%    |
| 10,000-row table     |    19.233 |   19.663 |    -2.24% | -1.27% / -3.45% / -2.24%    |
| Five Blueprints      |     2.445 |    2.751 |   -12.51% | -11.93% / -12.82% / -12.65% |
| 138 smaller packages |    12.859 |   13.852 |    -7.72% | -7.22% / -7.88% / -7.32%    |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    67.219 |   61.935 |    +7.86% | +7.51% / +11.92% / +7.58%  |
| Large level          |    46.440 |   41.129 |   +11.44% | +6.97% / +11.92% / +11.44% |
| 10,000-row table     |     9.170 |    9.130 |    +0.44% | +0.48% / +0.54% / -0.16%   |
| Five Blueprints      |     2.078 |    2.111 |    -1.58% | -8.23% / -1.20% / -1.70%   |
| 138 smaller packages |     9.367 |    9.586 |    -2.34% | -2.58% / -2.22% / -2.22%   |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   124.671 |  115.870 |    +7.06% | +7.19% / +6.55% / +7.50% |
| Large level          |    88.724 |   81.060 |    +8.64% | +8.60% / +8.32% / +8.96% |
| 10,000-row table     |    19.548 |   19.665 |    -0.60% | -0.60% / -0.71% / +0.17% |
| Five Blueprints      |     2.491 |    2.539 |    -1.93% | -2.74% / -1.26% / -1.93% |
| 138 smaller packages |    12.958 |   13.241 |    -2.18% | -2.04% / -2.46% / -0.63% |

### 92: Validate variable object/row layouts before allocation

Perform a complete metadata-free validation pass before constructing records. Rejected: two-pass validation still regressed ordinary corpus, level and table.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.043 |   68.230 |    -1.77% | -1.39% / -1.77% / -2.20% |
| Large level          |    46.183 |   46.987 |    -1.74% | -2.00% / -1.63% / -1.53% |
| 10,000-row table     |     8.980 |    9.257 |    -3.08% | -1.70% / -3.08% / -3.82% |
| Five Blueprints      |     2.045 |    2.056 |    -0.51% | -0.87% / -0.51% / -0.48% |
| 138 smaller packages |     9.328 |    9.395 |    -0.72% | -2.54% / -0.88% / -0.68% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.804 |  126.473 |    -3.83% | -3.70% / -4.47% / -2.66% |
| Large level          |    86.999 |   89.961 |    -3.40% | -2.83% / -3.40% / -3.29% |
| 10,000-row table     |    19.347 |   19.916 |    -2.94% | -3.23% / -2.60% / -0.12% |
| Five Blueprints      |     2.448 |    2.515 |    -2.74% | -3.25% / -2.74% / -1.32% |
| 138 smaller packages |    12.905 |   12.966 |    -0.48% | -0.73% / -0.81% / -0.41% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.247 |    9.305 |   +49.01% | +49.58% / +49.01% / +48.08% |
| stress-width-rotating    |    18.178 |    9.344 |   +48.60% | +48.47% / +48.55% / +49.00% |
| stress-width-shuffled    |    16.540 |    9.372 |   +43.34% | +43.34% / +42.72% / +43.55% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.773 |   20.105 |   +30.12% | +30.05% / +30.56% / +30.15% |
| stress-width-rotating    |    28.912 |   20.154 |   +30.29% | +30.42% / +30.04% / +29.89% |
| stress-width-shuffled    |    27.339 |   20.151 |   +26.29% | +26.42% / +25.78% / +26.57% |

### 93: Use two-pass variable validation only for rows

Keep the generic object path unchanged. Not preferred: width stress wins but slower ordinary table than the one-pass version.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.021 |   66.699 |    +0.48% | +0.62% / +0.61% / +0.12% |
| Large level          |    46.230 |   45.898 |    +0.72% | -0.16% / +1.01% / +1.42% |
| 10,000-row table     |     9.021 |    9.211 |    -2.10% | -0.06% / -2.10% / -4.52% |
| Five Blueprints      |     2.046 |    2.035 |    +0.57% | +0.57% / +0.56% / +0.81% |
| 138 smaller packages |     9.335 |    9.264 |    +0.76% | +0.00% / +0.47% / +0.91% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.476 |  121.426 |    +0.86% | -0.31% / +0.86% / +1.13% |
| Large level          |    87.208 |   85.712 |    +1.72% | +1.72% / +1.00% / +1.84% |
| 10,000-row table     |    19.320 |   19.468 |    -0.76% | -1.36% / -0.94% / -0.29% |
| Five Blueprints      |     2.449 |    2.435 |    +0.57% | +0.70% / +0.57% / -0.05% |
| 138 smaller packages |    12.882 |   12.808 |    +0.58% | +0.89% / +0.10% / +0.58% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.236 |    9.406 |   +48.42% | +48.84% / +48.04% / +48.42% |
| stress-width-rotating    |    18.195 |    9.433 |   +48.16% | +49.27% / +47.92% / +46.01% |
| stress-width-shuffled    |    16.548 |    9.267 |   +44.00% | +43.14% / +43.92% / +44.07% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.782 |   20.185 |   +29.87% | +30.11% / +29.43% / +31.54% |
| stress-width-rotating    |    28.924 |   19.662 |   +32.02% | +32.05% / +31.65% / +32.21% |
| stress-width-shuffled    |    27.406 |   19.712 |   +28.07% | +27.76% / +28.22% / +27.85% |

### 94: Bulk decode vector/rotator arrays

Prove the complete fixed-width array bytes exist, then decode without per-element paths and dispatch. Rejected: no ordinary corpus/level gain; no production adoption.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.622 |   67.019 |    -0.60% | -0.90% / -0.99% / +0.36% |
| Large level          |    46.137 |   46.233 |    -0.21% | -0.21% / +0.01% / -0.08% |
| 10,000-row table     |     8.950 |    8.920 |    +0.34% | +1.09% / -0.01% / +0.44% |
| Five Blueprints      |     2.048 |    2.051 |    -0.14% | -0.28% / -0.03% / -0.14% |
| 138 smaller packages |     9.340 |    9.352 |    -0.13% | -1.94% / +0.06% / -0.27% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.714 |  124.556 |    -2.34% | -2.34% / -1.81% / -1.87% |
| Large level          |    86.932 |   88.433 |    -1.73% | -2.69% / +0.89% / -1.85% |
| 10,000-row table     |    19.283 |   19.607 |    -1.68% | -2.79% / -1.66% / -1.19% |
| Five Blueprints      |     2.446 |    2.459 |    -0.52% | -1.03% / -0.40% / -0.43% |
| 138 smaller packages |    12.904 |   12.935 |    -0.23% | +0.24% / -2.22% / -0.16% |

### 95: Bulk decode additional core struct arrays

Extend the safe complete-block kernel to IntPoint, Color and LinearColor. Rejected: ordinary corpus/level regressions; no production adoption.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.648 |   67.145 |    -0.75% | -0.18% / -0.61% / -1.33% |
| Large level          |    45.362 |   45.825 |    -1.02% | -3.10% / -1.02% / -0.18% |
| 10,000-row table     |     9.009 |    9.071 |    -0.68% | -0.68% / +1.97% / -1.45% |
| Five Blueprints      |     2.046 |    2.063 |    -0.83% | +0.00% / -6.57% / -1.01% |
| 138 smaller packages |     9.347 |    9.336 |    +0.12% | +2.51% / +0.23% / +0.12% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.591 |  123.984 |    -1.14% | -1.12% / -0.47% / -1.34% |
| Large level          |    87.792 |   88.307 |    -0.59% | -0.08% / -0.45% / -1.25% |
| 10,000-row table     |    19.451 |   19.749 |    -1.54% | -2.79% / -1.65% / -1.19% |
| Five Blueprints      |     2.446 |    2.453 |    -0.28% | +0.07% / -4.27% / -0.38% |
| 138 smaller packages |    12.874 |   12.882 |    -0.06% | -0.18% / +0.22% / +0.11% |

### 96: Combine source candidates

Borrowed names, one-pass facts, prepared leaves, header words and borrowed ancestry paths. Not preferred: strong table gains with cold-package regressions; generalized97 selected.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.614 |   62.126 |    +6.74% | +6.59% / +8.01% / +6.68%    |
| Large level          |    46.326 |   43.435 |    +6.24% | +6.24% / +4.36% / +6.06%    |
| 10,000-row table     |     9.030 |    7.004 |   +22.44% | +22.10% / +22.17% / +23.15% |
| Five Blueprints      |     2.041 |    2.084 |    -2.09% | -1.83% / -2.11% / -2.09%    |
| 138 smaller packages |     9.328 |    9.388 |    -0.64% | -0.39% / -0.78% / -0.74%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |   122.465 |  116.539 |    +4.84% | +4.92% / +3.98% / +5.32%   |
| Large level          |    86.848 |   84.303 |    +2.93% | +3.30% / +3.19% / +2.44%   |
| 10,000-row table     |    19.286 |   17.259 |   +10.51% | +11.15% / +10.57% / +9.95% |
| Five Blueprints      |     2.441 |    2.488 |    -1.91% | -11.99% / -1.16% / -1.91%  |
| 138 smaller packages |    12.860 |   12.897 |    -0.29% | -0.40% / -0.15% / +0.13%   |

### 97: Combine source candidates with adaptive variable rows

Integrate variable payloads and several row layouts with prepared leaf callbacks. Retained generalized row replay and other components through lazy-plan version112/core1.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.759 |   62.520 |    +6.35% | +6.36% / +6.62% / +5.85%    |
| Large level          |    45.956 |   43.289 |    +5.80% | +5.80% / +5.80% / +4.78%    |
| 10,000-row table     |     8.939 |    7.366 |   +17.59% | +18.89% / +11.72% / +18.49% |
| Five Blueprints      |     2.054 |    2.055 |    -0.03% | -0.04% / +0.16% / +0.28%    |
| 138 smaller packages |     9.329 |    9.335 |    -0.07% | -0.38% / +0.08% / -0.07%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.808 |  119.095 |    +2.23% | +2.23% / +2.81% / +1.34% |
| Large level          |    87.537 |   86.492 |    +1.19% | +0.20% / +1.31% / +1.77% |
| 10,000-row table     |    19.285 |   17.771 |    +7.85% | +7.40% / +7.27% / +8.20% |
| Five Blueprints      |     2.445 |    2.467 |    -0.87% | -0.87% / -0.34% / -1.25% |
| 138 smaller packages |    12.892 |   12.885 |    +0.06% | -0.07% / +0.18% / +0.14% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.127 |    7.938 |   +56.21% | +58.12% / +54.96% / +56.21% |
| stress-width-rotating    |    18.204 |    7.901 |   +56.60% | +56.80% / +57.25% / +55.61% |
| stress-width-shuffled    |    16.570 |    7.891 |   +52.38% | +53.14% / +52.31% / +52.15% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.812 |   18.313 |   +36.44% | +36.44% / +36.38% / +36.69% |
| stress-width-rotating    |    28.837 |   18.663 |   +35.28% | +35.37% / +35.34% / +35.05% |
| stress-width-shuffled    |    27.409 |   18.651 |   +31.95% | +31.95% / +31.77% / +31.73% |

### 98: Combine source candidates with two-pass variable rows

Use one row layout and allocation-free validation on misses. Not retained: cold regressions and narrower/worse variable-width behavior than97.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    67.016 |   62.525 |    +6.70% | +7.07% / +6.52% / +7.09%    |
| Large level          |    46.260 |   43.500 |    +5.97% | +6.82% / +5.97% / +4.94%    |
| 10,000-row table     |     8.955 |    7.180 |   +19.82% | +20.41% / +20.61% / +19.41% |
| Five Blueprints      |     2.049 |    2.074 |    -1.22% | -1.25% / -4.14% / -0.82%    |
| 138 smaller packages |     9.337 |    9.473 |    -1.46% | -1.40% / -1.54% / -1.44%    |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.556 |  119.661 |    +1.56% | +3.19% / +1.27% / +0.25% |
| Large level          |    87.193 |   87.286 |    -0.11% | -0.14% / +0.46% / -0.09% |
| 10,000-row table     |    19.209 |   17.913 |    +6.75% | +8.20% / +6.54% / +6.73% |
| Five Blueprints      |     2.446 |    2.495 |    -2.00% | -1.78% / -2.14% / -2.00% |
| 138 smaller packages |    12.882 |   13.070 |    -1.46% | -2.66% / -1.41% / -1.83% |

API/dataset: **width**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.188 |    7.956 |   +56.26% | +55.98% / +56.16% / +56.54% |
| stress-width-rotating    |    18.148 |    8.548 |   +52.90% | +52.28% / +53.26% / +52.90% |
| stress-width-shuffled    |    16.560 |    8.575 |   +48.22% | +47.80% / +48.22% / +48.76% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    28.922 |   18.725 |   +35.26% | +35.37% / +34.24% / +35.00% |
| stress-width-rotating    |    28.885 |   19.236 |   +33.41% | +33.00% / +33.41% / +33.95% |
| stress-width-shuffled    |    27.378 |   19.416 |   +29.08% | +28.83% / +29.56% / +29.40% |

### 100: Cache nested property-stream headers

Reuse nested header layouts through a bounded, package-scoped cache. Rejected: high hit rate did not improve corpus time; level, Blueprint and small-package regressions. Baseline: round control 97d.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.467 |   66.912 |    -0.67% | +0.18% / -0.67% / -0.51% |
| Large level          |    45.930 |   46.431 |    -1.09% | -0.61% / -1.09% / -1.29% |
| 10,000-row table     |     9.033 |    9.042 |    -0.10% | +1.39% / -1.06% / -0.34% |
| Five Blueprints      |     2.045 |    2.094 |    -2.40% | -2.06% / -2.54% / -2.33% |
| 138 smaller packages |     9.354 |    9.574 |    -2.35% | -2.56% / -1.94% / -2.27% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.796 |  120.755 |    +1.66% | +2.09% / +1.59% / +0.38% |
| Large level          |    87.902 |   85.540 |    +2.69% | +1.11% / +2.69% / +3.01% |
| 10,000-row table     |    19.359 |   19.250 |    +0.56% | +1.14% / +0.83% / -0.16% |
| Five Blueprints      |     2.453 |    2.514 |    -2.46% | -2.81% / -2.46% / +1.04% |
| 138 smaller packages |    12.894 |   13.067 |    -1.34% | -1.34% / -0.99% / -1.48% |

### 102: Give borrowed decoding its own session

Expose a callback decoder with reusable property metadata while preserving the old owned-session layout; keep native fixups and raw metadata resets. Not retained: callback corpus +5.68% and level +8.80%, but callback small packages -1.62%; the old owned corpus is -1.09%. All 456 covered ordinary/callback package oracles and 247 parser tests passed. Baselines: 97d owned and its separate owned-result callback adapter.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.900 |   67.632 |    -1.09% | -1.00% / -1.32% / -1.09% |
| Large level          |    46.152 |   45.927 |    +0.49% | +1.06% / -6.03% / +0.49% |
| 10,000-row table     |     8.965 |    9.141 |    -1.96% | +0.01% / -3.74% / -1.96% |
| Five Blueprints      |     2.048 |    2.050 |    -0.07% | -2.84% / -0.08% / -0.07% |
| 138 smaller packages |     9.316 |    9.390 |    -0.79% | +0.32% / -0.35% / -0.79% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.223 |  122.106 |    +0.10% | -0.48% / +0.32% / +0.03% |
| Large level          |    87.060 |   86.880 |    +0.21% | -0.15% / +0.91% / +0.21% |
| 10,000-row table     |    19.368 |   19.430 |    -0.32% | -0.32% / -0.69% / -0.07% |
| Five Blueprints      |     2.449 |    2.457 |    -0.33% | +0.03% / -0.33% / -0.29% |
| 138 smaller packages |    12.904 |   12.905 |    -0.00% | -0.13% / -0.00% / -0.15% |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.231 |   63.411 |    +5.68% | +6.54% / +4.65% / +6.16% |
| Large level          |    46.548 |   42.454 |    +8.80% | +8.80% / +4.10% / +9.75% |
| 10,000-row table     |     9.165 |    8.989 |    +1.93% | +1.26% / +3.11% / +1.90% |
| Five Blueprints      |     2.084 |    2.068 |    +0.76% | +0.76% / +1.06% / +1.09% |
| 138 smaller packages |     9.367 |    9.519 |    -1.62% | -0.06% / -1.77% / -2.60% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.735 |  120.264 |    +2.81% | +3.00% / +2.24% / +3.30% |
| Large level          |    88.901 |   85.804 |    +3.48% | +3.48% / +3.88% / +3.15% |
| 10,000-row table     |    19.629 |   19.415 |    +1.09% | +1.02% / +1.73% / +1.66% |
| Five Blueprints      |     2.491 |    2.458 |    +1.33% | +1.62% / +1.07% / +1.90% |
| 138 smaller packages |    12.970 |   12.839 |    +1.01% | -1.56% / +1.03% / +0.77% |

### 103: Use the independent callback session for streaming JSON

Adopt the hardened borrowed decoder in the current streaming-JSON boundary. Not retained: JSON corpus +4.15% and level +3.58% in the owned-probe comparison, but smaller JSON workloads regress about 5% and ordinary owned decoding regresses about 3%. Separate visitor-probe results are recorded, not combined with owned results.

API/dataset: **owned**. Actual baseline: `control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.619 |   68.625 |    -3.01% | -5.92% / -2.59% / -3.06% |
| Large level          |    45.835 |   47.720 |    -4.11% | -3.54% / -3.97% / -4.82% |
| 10,000-row table     |     9.055 |    9.351 |    -3.27% | -3.27% / -1.88% / -6.61% |
| Five Blueprints      |     2.060 |    2.131 |    -3.47% | -3.90% / -3.20% / -3.84% |
| 138 smaller packages |     9.341 |    9.685 |    -3.69% | -8.10% / -3.13% / -3.28% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   123.923 |  118.785 |    +4.15% | +4.31% / +4.11% / +2.41% |
| Large level          |    87.188 |   84.069 |    +3.58% | +4.46% / +3.52% / +3.20% |
| 10,000-row table     |    19.349 |   19.599 |    -1.29% | -1.33% / +0.09% / -0.27% |
| Five Blueprints      |     2.455 |    2.581 |    -5.16% | -5.60% / -5.16% / -8.36% |
| 138 smaller packages |    12.887 |   13.513 |    -4.86% | -4.72% / -3.47% / -5.01% |

API/dataset: **visitor**. Actual baseline: `visitor-control/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.247 |   64.526 |    +4.05% | +2.81% / +4.26% / +4.05% |
| Large level          |    46.342 |   43.282 |    +6.60% | +6.04% / +6.60% / +6.37% |
| 10,000-row table     |     9.162 |    9.248 |    -0.93% | -5.01% / -2.19% / +0.01% |
| Five Blueprints      |     2.082 |    2.133 |    -2.46% | -2.43% / -2.46% / -2.70% |
| 138 smaller packages |     9.392 |    9.754 |    -3.86% | -4.14% / -3.78% / -0.49% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   124.297 |  118.492 |    +4.67% | +3.71% / +4.68% / +4.75% |
| Large level          |    88.891 |   82.982 |    +6.65% | +6.63% / +6.35% / +6.79% |
| 10,000-row table     |    19.527 |   19.710 |    -0.93% | -0.70% / -1.13% / -1.09% |
| Five Blueprints      |     2.510 |    2.554 |    -1.76% | -5.57% / -1.96% / -1.75% |
| 138 smaller packages |    12.956 |   13.332 |    -2.90% | -2.73% / -2.83% / -3.30% |

### 112: Prepare semantic plans only on reuse

Avoid preparing recipes for captured layouts that never match again; reference is trial97. Selected as formatted core1.714UAssetRust tests,8ignored;Clippy/Windows/Node24+26originalWASM/207084wire pass. Full portable check still ENOTDIR optionalWindows package;freshUE5.7/5.8 unavailable.

API/dataset: **owned**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.316 |   61.323 |    +1.59% | +1.37% / +0.80% / +1.59% |
| Large level          |    43.757 |   42.940 |    +1.87% | +2.09% / +1.17% / +2.33% |
| 10,000-row table     |     7.272 |    7.018 |    +3.50% | +1.01% / +4.16% / +5.77% |
| Five Blueprints      |     2.053 |    2.052 |    +0.05% | +0.25% / +0.05% / -0.12% |
| 138 smaller packages |     9.360 |    9.303 |    +0.61% | +0.61% / -0.66% / +0.93% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.933 |  118.550 |    +1.15% | +3.02% / +1.46% / -0.50% |
| Large level          |    86.728 |   85.592 |    +1.31% | +1.31% / +1.02% / +0.81% |
| 10,000-row table     |    17.890 |   17.630 |    +1.46% | +0.52% / +1.62% / +1.72% |
| Five Blueprints      |     2.474 |    2.479 |    -0.19% | -0.62% / +0.62% / -0.67% |
| 138 smaller packages |    12.886 |   12.858 |    +0.22% | +0.07% / +0.54% / +0.19% |

API/dataset: **width**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.617 |    7.532 |    +1.11% | +4.10% / +0.59% / +1.50% |
| stress-width-rotating    |     7.972 |    7.758 |    +2.68% | +1.13% / +4.03% / +1.75% |
| stress-width-shuffled    |     8.013 |    7.961 |    +0.65% | -0.90% / +1.32% / +3.03% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |    18.405 |   18.155 |    +1.36% | +1.14% / +1.53% / +1.35% |
| stress-width-rotating    |    18.721 |   18.475 |    +1.32% | +1.76% / +0.94% / +0.56% |
| stress-width-shuffled    |    18.601 |   18.678 |    -0.41% | -1.64% / +0.68% / -0.31% |

### 113: Keep cached tags compact

Use checked u16 offsets within the existing16KiB optional header budget; reference is trial97. Not retained: no consistent broad gain; cold Blueprint regression.

API/dataset: **owned**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.579 |   62.366 |    +0.34% | +0.57% / -0.19% / -0.11% |
| Large level          |    43.512 |   43.344 |    +0.39% | +1.14% / +1.29% / -1.32% |
| 10,000-row table     |     7.141 |    7.073 |    +0.95% | +0.95% / +3.05% / -1.03% |
| Five Blueprints      |     2.053 |    2.075 |    -1.07% | -0.53% / -1.07% / -3.31% |
| 138 smaller packages |     9.369 |    9.364 |    +0.05% | -0.22% / +0.19% / +0.04% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   120.162 |  119.295 |    +0.72% | +1.15% / +0.36% / +0.72% |
| Large level          |    86.094 |   85.979 |    +0.13% | -0.05% / -0.12% / +0.18% |
| 10,000-row table     |    17.936 |   17.982 |    -0.26% | -0.24% / +0.85% / -0.69% |
| Five Blueprints      |     2.473 |    2.480 |    -0.28% | +0.35% / -0.26% / -0.38% |
| 138 smaller packages |    12.909 |   12.916 |    -0.05% | -0.45% / -0.11% / +0.17% |

API/dataset: **width**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.768 |    7.562 |    +2.65% | +2.75% / -1.78% / +3.29% |
| stress-width-rotating    |     8.037 |    7.867 |    +2.11% | +1.04% / +2.35% / +0.12% |
| stress-width-shuffled    |     7.915 |    7.981 |    -0.84% | +0.77% / -1.15% / -0.84% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |    18.355 |   18.310 |    +0.25% | -0.08% / +0.67% / +0.08% |
| stress-width-rotating    |    18.667 |   18.741 |    -0.40% | -0.02% / +0.12% / -0.53% |
| stress-width-shuffled    |    18.683 |   18.739 |    -0.30% | -1.89% / +0.19% / +0.10% |

### 114: Combine lazy preparation and compact tags

Test both changes together against trial97. Not retained: direct118comparison with112 failed to improve corpus/table; keep simpler112.

API/dataset: **owned**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.301 |   61.887 |    +0.66% | +0.66% / +1.57% / +1.44% |
| Large level          |    43.545 |   42.861 |    +1.57% | +1.57% / -0.38% / +0.90% |
| 10,000-row table     |     7.265 |    7.070 |    +2.68% | +2.77% / +2.74% / +2.25% |
| Five Blueprints      |     2.058 |    2.037 |    +1.04% | +0.20% / +1.89% / +1.04% |
| 138 smaller packages |     9.339 |    9.286 |    +0.58% | +0.58% / +1.00% / +0.40% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.424 |  119.276 |    +0.12% | +0.31% / -0.07% / +0.90% |
| Large level          |    85.878 |   85.481 |    +0.46% | +0.49% / -0.35% / +1.21% |
| 10,000-row table     |    17.798 |   17.871 |    -0.41% | -0.06% / -2.27% / +0.28% |
| Five Blueprints      |     2.464 |    2.457 |    +0.26% | +0.85% / -2.68% / +0.26% |
| 138 smaller packages |    12.870 |   12.879 |    -0.07% | +0.09% / +0.28% / -1.32% |

API/dataset: **width**. Actual baseline: `97-combined-source-candidate/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.750 |    7.466 |    +3.66% | +4.34% / +2.72% / +3.01% |
| stress-width-rotating    |     8.046 |    7.751 |    +3.66% | +3.54% / +1.32% / +3.66% |
| stress-width-shuffled    |     8.036 |    7.827 |    +2.60% | -0.13% / +2.73% / +2.96% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |    18.352 |   18.229 |    +0.67% | +0.61% / +0.67% / +1.11% |
| stress-width-rotating    |    18.735 |   18.624 |    +0.59% | -0.11% / +0.32% / +0.87% |
| stress-width-shuffled    |    18.742 |   18.549 |    +1.03% | -4.06% / +1.35% / +1.17% |

### 117: Use a safe optimized Latin-1 decoder

Replace repeated ASCII validation/per-character conversion with encoding_rs::mem::decode_latin1 while preserving 8-bit code-point mapping. Latin-1 conversion was ultimately selected in combined 153. This comparison isolates conversion on the same six-package dependency graph: corpus +1.66%, level +0.57%, table +9.48%, Blueprint +1.02%, small +1.83%, all paired blocks positive. Net dependency adoption was measured separately in 146–148 and 153; these stage gains are not summed. 250 parser tests, exhaustive 65,536 byte-pair checks and all 456 original package oracles passed.

API/dataset: **owned**. Actual baseline: `117-control-with-codec-dependency/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    61.585 |   60.561 |    +1.66% | +0.60% / +1.66% / +2.21%  |
| Large level          |    42.815 |   42.572 |    +0.57% | +0.96% / +0.24% / +1.39%  |
| 10,000-row table     |     7.358 |    6.660 |    +9.48% | +5.46% / +11.13% / +9.48% |
| Five Blueprints      |     2.060 |    2.039 |    +1.02% | +0.78% / +1.36% / +1.02%  |
| 138 smaller packages |     9.353 |    9.183 |    +1.83% | +1.05% / +1.83% / +2.20%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.402 |  114.487 |    +2.48% | +2.22% / +2.05% / +3.27% |
| Large level          |    84.126 |   82.390 |    +2.06% | +1.34% / +2.71% / +2.06% |
| 10,000-row table     |    17.640 |   17.002 |    +3.62% | +3.62% / +3.32% / +4.53% |
| Five Blueprints      |     2.468 |    2.433 |    +1.40% | +1.65% / +1.97% / +1.16% |
| 138 smaller packages |    12.906 |   12.614 |    +2.26% | +0.94% / +2.47% / +2.03% |

API/dataset: **width**. Actual baseline: `117-control-with-codec-dependency/parser-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.597 |    7.010 |    +7.73% | +8.35% / +9.19% / +6.39% |
| stress-width-rotating    |     7.897 |    7.421 |    +6.02% | +5.35% / +5.17% / +8.54% |
| stress-width-shuffled    |     7.834 |    7.388 |    +5.70% | +6.82% / +5.70% / +7.09% |

Streaming JSON:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |    18.143 |   17.515 |    +3.46% | +3.46% / +4.87% / +3.47% |
| stress-width-rotating    |    18.462 |   17.766 |    +3.77% | +3.99% / +3.76% / +3.77% |
| stress-width-shuffled    |    18.570 |   17.784 |    +4.23% | +5.83% / +4.37% / +4.23% |

### 118: Direct compact-tag confirmation

Compare114directly with112 before selection; no new source variant. Reject compact addition;112 selected.

API/dataset: **owned**. Actual baseline: `112-general-row-plans-on-reuse/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.275 |   61.759 |    -0.79% | -1.45% / -1.27% / +0.24% |
| Large level          |    42.929 |   42.906 |    +0.05% | +0.18% / -1.17% / -0.82% |
| 10,000-row table     |     6.986 |    7.012 |    -0.37% | -1.01% / -0.36% / -0.03% |
| Five Blueprints      |     2.051 |    2.043 |    +0.40% | +1.17% / -1.52% / +0.84% |
| 138 smaller packages |     9.295 |    9.299 |    -0.04% | -0.02% / -0.04% / +0.12% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.355 |  119.118 |    +0.20% | +1.11% / +0.13% / -0.53% |
| Large level          |    85.399 |   85.294 |    +0.12% | +2.29% / -0.58% / +0.12% |
| 10,000-row table     |    17.592 |   17.715 |    -0.70% | -0.96% / -0.12% / -0.91% |
| Five Blueprints      |     2.471 |    2.454 |    +0.68% | +0.72% / +0.68% / -0.37% |
| 138 smaller packages |    12.838 |   12.826 |    +0.10% | -0.14% / +0.10% / +0.21% |

### 121: Index the embedded schema with a hash table

Avoid repeated linear scans in the immutable default model; retain custom-model lookup semantics. Not retained: +1.05% corpus but table, Blueprint and small-package regressions; cold lookup overhead outweighed the limited benefit.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.569 |   60.920 |    +1.05% | +1.58% / +0.73% / +0.80% |
| Large level          |    43.207 |   42.696 |    +1.18% | -0.79% / +2.45% / +1.18% |
| 10,000-row table     |     7.052 |    7.121 |    -0.97% | -0.62% / -0.37% / -2.37% |
| Five Blueprints      |     2.051 |    2.066 |    -0.73% | -0.08% / -1.11% / -0.68% |
| 138 smaller packages |     9.254 |    9.378 |    -1.34% | -1.40% / -0.49% / -1.06% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   121.139 |  116.755 |    +3.62% | +3.99% / +2.91% / +1.92% |
| Large level          |    86.141 |   83.562 |    +2.99% | +1.87% / +3.22% / +3.01% |
| 10,000-row table     |    17.663 |   17.663 |    -0.00% | +0.35% / -0.13% / -0.21% |
| Five Blueprints      |     2.465 |    2.475 |    -0.44% | -0.36% / -0.44% / -0.39% |
| 138 smaller packages |    12.834 |   12.951 |    -0.91% | -0.87% / -0.82% / -1.01% |

### 122: Index the embedded schema with sorted vectors

Use compact sorted indexes for the default model, retaining the generic custom-model path. Rejected: no broad improvement; corpus and cold workloads regressed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.480 |   61.805 |    -0.53% | +0.06% / -1.26% / -0.61% |
| Large level          |    43.155 |   43.507 |    -0.82% | -2.21% / -0.82% / -0.60% |
| 10,000-row table     |     7.074 |    7.056 |    +0.25% | -1.07% / +0.53% / +0.77% |
| Five Blueprints      |     2.056 |    2.080 |    -1.16% | -1.61% / -1.16% / -0.44% |
| 138 smaller packages |     9.264 |    9.427 |    -1.77% | -1.72% / -1.44% / -1.92% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.574 |  119.114 |    +0.38% | +0.38% / -0.87% / +1.40% |
| Large level          |    86.065 |   86.460 |    -0.46% | -1.17% / -0.31% / -0.13% |
| 10,000-row table     |    17.663 |   17.613 |    +0.29% | -0.28% / +0.71% / +0.29% |
| Five Blueprints      |     2.470 |    2.489 |    -0.76% | -0.76% / -0.99% / -0.67% |
| 138 smaller packages |    12.834 |   12.980 |    -1.14% | -1.16% / -1.37% / -0.55% |

### 123: Split native identity lookup by module

Replace tuple-key BTreeMap lookup with nested module/name trees. Not retained: mixed corpus result and repeatable table regression despite level/small gains. Later length buckets 140 were preferred. Baseline: core1.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.511 |   60.365 |    +1.86% | +2.34% / -2.85% / +1.58% |
| Large level          |    42.929 |   42.393 |    +1.25% | +2.54% / +0.56% / +1.63% |
| 10,000-row table     |     6.945 |    7.030 |    -1.22% | -0.76% / -0.81% / -1.22% |
| Five Blueprints      |     2.057 |    2.040 |    +0.82% | +1.27% / -2.81% / +0.83% |
| 138 smaller packages |     9.276 |    9.161 |    +1.23% | +3.64% / +1.14% / +1.23% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.678 |  117.424 |    +1.06% | +1.47% / +1.24% / +1.06% |
| Large level          |    85.759 |   84.076 |    +1.96% | +2.23% / +1.96% / +1.67% |
| 10,000-row table     |    17.648 |   17.725 |    -0.43% | -0.19% / -0.24% / -0.43% |
| Five Blueprints      |     2.466 |    2.448 |    +0.73% | -5.47% / +1.06% / +0.73% |
| 138 smaller packages |    12.831 |   12.732 |    +0.77% | +0.77% / +0.49% / +2.38% |

### 124: Hash native type identities

Replace the small tuple-key tree with a guarded hash lookup. Not preferred: mixed corpus result and slower Blueprint/small workloads. Baseline: core1.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.536 |   61.205 |    +0.54% | +1.28% / +1.08% / -0.45% |
| Large level          |    42.870 |   42.957 |    -0.20% | +0.26% / +0.55% / -1.88% |
| 10,000-row table     |     7.087 |    7.093 |    -0.08% | -0.46% / -1.46% / +3.88% |
| Five Blueprints      |     2.055 |    2.064 |    -0.46% | -0.55% / -0.25% / -0.07% |
| 138 smaller packages |     9.267 |    9.317 |    -0.54% | -0.73% / -0.55% / -0.40% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.732 |  117.087 |    +1.39% | +1.34% / +5.55% / +1.15% |
| Large level          |    86.115 |   83.997 |    +2.46% | +2.39% / +1.34% / +6.11% |
| 10,000-row table     |    17.596 |   17.666 |    -0.40% | -0.75% / -0.75% / +2.05% |
| Five Blueprints      |     2.471 |    2.479 |    -0.31% | -1.10% / -0.27% / -0.05% |
| 138 smaller packages |    12.861 |   12.934 |    -0.57% | +3.56% / -0.54% / -0.75% |

### 126: Read valid name pairs as one bounded block

Read the common 8-byte FName pair once; fall back to the old reader for negative, truncated or invalid cases. Not retained in the final combination. Initial +2.20% corpus/+2.04% level/+1.10% table prompted independent confirmation 133 and expanded 207,084 wire checks. Direct comparisons 142/144 then favored the simpler general type-prefix reader 135. No gain was assumed additive.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.901 |   60.542 |    +2.20% | +2.45% / +2.34% / +1.51% |
| Large level          |    43.121 |   42.239 |    +2.04% | +2.22% / +2.88% / +1.67% |
| 10,000-row table     |     7.067 |    6.989 |    +1.10% | +1.64% / +0.66% / +0.51% |
| Five Blueprints      |     2.059 |    2.030 |    +1.42% | +1.42% / +1.64% / +1.04% |
| 138 smaller packages |     9.267 |    9.190 |    +0.83% | +0.56% / +1.29% / +0.83% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.861 |  117.505 |    +1.14% | +1.54% / +1.08% / +0.52% |
| Large level          |    85.753 |   84.676 |    +1.26% | +0.92% / +1.45% / +1.12% |
| 10,000-row table     |    17.696 |   17.665 |    +0.18% | +0.41% / +0.08% / +0.18% |
| Five Blueprints      |     2.470 |    2.436 |    +1.38% | +1.51% / +1.19% / +4.18% |
| 138 smaller packages |    12.845 |   12.770 |    +0.58% | +0.73% / +3.19% / +0.24% |

### 127: Box each rarely present GUID

Shrink every property record by storing present GUIDs indirectly. Rejected: Rust field-type API break; table +7.84%, but corpus -0.34%, level -2.92% and smaller workloads slower. All 456 original package cases matched; not a universal acceptance proof under custom size budgets.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    61.648 |   61.857 |    -0.34% | -0.34% / -0.55% / -0.42%  |
| Large level          |    42.937 |   44.192 |    -2.92% | -0.19% / -4.22% / -2.92%  |
| 10,000-row table     |     7.040 |    6.487 |    +7.84% | +7.11% / +7.67% / +11.37% |
| Five Blueprints      |     2.054 |    2.081 |    -1.28% | -1.23% / -1.15% / -1.47%  |
| 138 smaller packages |     9.296 |    9.368 |    -0.78% | -0.27% / -0.62% / -1.17%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.684 |  117.836 |    +0.71% | +0.63% / +1.57% / +0.71% |
| Large level          |    85.760 |   85.970 |    -0.25% | -0.35% / -0.25% / -0.40% |
| 10,000-row table     |    17.673 |   17.049 |    +3.53% | +3.00% / +4.03% / +4.15% |
| Five Blueprints      |     2.469 |    2.507 |    -1.53% | -1.60% / -0.88% / -1.38% |
| 138 smaller packages |    12.866 |   12.970 |    -0.80% | -0.80% / -0.80% / -0.80% |

### 128: Store one sparse GUID pair

Move both optional GUIDs behind one optional allocation per record. Rejected: Rust field API break; table +3.65% but corpus flat and Blueprint/small regressions.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.630 |   61.697 |    -0.11% | +0.11% / -0.46% / -0.11% |
| Large level          |    43.303 |   43.496 |    -0.45% | -0.93% / -0.12% / +3.02% |
| 10,000-row table     |     7.015 |    6.759 |    +3.65% | +3.97% / +3.10% / +4.13% |
| Five Blueprints      |     2.055 |    2.127 |    -3.49% | -1.73% / -5.00% / -3.22% |
| 138 smaller packages |     9.269 |    9.380 |    -1.21% | -1.18% / -1.32% / -1.79% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.977 |  117.421 |    +1.31% | +1.78% / +0.72% / +1.48% |
| Large level          |    85.520 |   84.516 |    +1.17% | +2.17% / +1.10% / +0.30% |
| 10,000-row table     |    17.577 |   17.270 |    +1.74% | +1.89% / +1.43% / +2.34% |
| Five Blueprints      |     2.475 |    2.492 |    -0.68% | -0.92% / -0.46% / -0.61% |
| 138 smaller packages |    12.851 |   12.964 |    -0.87% | -0.78% / -0.99% / -0.58% |

### 129: Reuse semantic plans in nested property streams

Reuse both validated headers and leaf decoding recipes, releasing the cache borrow before recursive decoding. Rejected: corpus flat/slower, table 2.81% slower, Blueprints 7.76% slower and small packages 4.06% slower. All original outputs matched. Baseline: core1.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    61.543 |   61.649 |    -0.17% | +0.23% / -0.14% / -0.35%  |
| Large level          |    43.431 |   43.656 |    -0.52% | -1.32% / -0.52% / -0.27%  |
| 10,000-row table     |     6.971 |    7.167 |    -2.81% | -2.81% / -5.06% / -3.27%  |
| Five Blueprints      |     2.052 |    2.211 |    -7.76% | -2.92% / -11.11% / -7.76% |
| 138 smaller packages |     9.269 |    9.646 |    -4.06% | -3.44% / -5.95% / -3.91%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.044 |  118.806 |    +0.20% | +0.98% / +0.20% / -0.15% |
| Large level          |    86.186 |   85.832 |    +0.41% | +0.67% / -0.41% / +0.27% |
| 10,000-row table     |    17.657 |   17.784 |    -0.72% | -1.39% / +0.82% / -0.72% |
| Five Blueprints      |     2.475 |    2.551 |    -3.07% | -4.30% / -2.52% / +0.36% |
| 138 smaller packages |    12.850 |   13.282 |    -3.36% | -3.36% / -2.83% / -5.24% |

### 130: Extend fixed header word comparisons

Use safe fixed-width loads for additional 37/49/61/73-byte headers. Rejected: corpus -1.34% and table -2.87%; no broad benefit. Baseline: core1.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    61.482 |   62.305 |    -1.34% | -1.80% / -1.05% / -1.51%  |
| Large level          |    43.170 |   43.503 |    -0.77% | -1.88% / +1.29% / -0.30%  |
| 10,000-row table     |     7.000 |    7.201 |    -2.87% | -1.56% / -1.32% / -12.29% |
| Five Blueprints      |     2.057 |    2.077 |    -0.95% | +4.97% / -1.56% / -0.98%  |
| 138 smaller packages |     9.274 |    9.428 |    -1.66% | -1.66% / -1.89% / +0.06%  |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.754 |  118.909 |    -0.13% | -0.15% / +0.05% / +0.44% |
| Large level          |    85.992 |   86.415 |    -0.49% | -0.85% / -0.19% / -0.32% |
| 10,000-row table     |    17.603 |   17.875 |    -1.54% | -1.72% / -0.58% / -1.54% |
| Five Blueprints      |     2.466 |    2.496 |    -1.24% | -1.24% / -0.78% / -4.71% |
| 138 smaller packages |    12.868 |   12.995 |    -0.99% | -1.02% / -1.57% / -0.99% |

### 131: Extend variable header word comparisons

Use safe fixed-width loads for the stable variable-size header prefixes. Rejected: corpus -0.56%, level -0.73% and table -2.50%. Baseline: core1.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.272 |   61.615 |    -0.56% | -0.29% / -1.37% / -0.17% |
| Large level          |    43.256 |   43.573 |    -0.73% | -0.93% / -0.87% / -0.73% |
| 10,000-row table     |     7.006 |    7.181 |    -2.50% | +0.02% / -3.35% / -2.94% |
| Five Blueprints      |     2.055 |    2.048 |    +0.33% | +0.34% / +0.33% / +6.44% |
| 138 smaller packages |     9.274 |    9.314 |    -0.43% | +0.01% / -0.22% / -2.44% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.180 |  118.543 |    +0.53% | +0.14% / +0.39% / +0.72% |
| Large level          |    85.781 |   85.819 |    -0.04% | +0.03% / -0.04% / +0.26% |
| 10,000-row table     |    17.677 |   17.894 |    -1.23% | -1.05% / -1.23% / -1.33% |
| Five Blueprints      |     2.509 |    2.460 |    +1.95% | +4.70% / +1.46% / +0.46% |
| 138 smaller packages |    12.873 |   12.832 |    +0.31% | +0.90% / +0.31% / -1.37% |

### 132: Combine fixed and variable header words

Measure both comparison changes together rather than add isolated results. Not retained: level +1.22%, but corpus flat, table -1.95% and Blueprint/small regressions.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.665 |   61.658 |    +0.01% | -0.02% / +0.08% / +0.65% |
| Large level          |    43.478 |   42.949 |    +1.22% | +0.85% / +1.56% / +1.22% |
| 10,000-row table     |     7.069 |    7.207 |    -1.95% | -2.57% / +0.68% / -2.05% |
| Five Blueprints      |     2.052 |    2.069 |    -0.79% | -0.44% / -1.07% / -0.99% |
| 138 smaller packages |     9.283 |    9.326 |    -0.46% | -0.57% / -0.35% / -0.46% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.152 |  117.507 |    +1.38% | +1.38% / +2.17% / +0.39% |
| Large level          |    85.969 |   85.148 |    +0.95% | +1.51% / +0.83% / +1.19% |
| 10,000-row table     |    17.609 |   17.949 |    -1.93% | -1.45% / -2.52% / -1.93% |
| Five Blueprints      |     2.468 |    2.465 |    +0.11% | +0.07% / +2.21% / +0.37% |
| 138 smaller packages |    13.034 |   12.883 |    +1.16% | -0.25% / +0.67% / +2.97% |

### 133: Independently repeat the name-pair comparison

Repeat the same 126 binary against core1 in another three interleaved blocks; also compare 207,084 wire cases and trace fixed work. Corpus gain replicated: +1.46% with all blocks positive; level +0.76%. Table and smaller workloads mixed. Expanded original wire oracle passed and both traces lost zero samples. No new source variant.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.572 |   60.672 |    +1.46% | +1.75% / +0.75% / +1.41% |
| Large level          |    43.088 |   42.759 |    +0.76% | +0.24% / +1.49% / +0.31% |
| 10,000-row table     |     7.041 |    7.069 |    -0.39% | -0.38% / +0.47% / -0.39% |
| Five Blueprints      |     2.054 |    2.022 |    +1.55% | +1.59% / +1.55% / -0.45% |
| 138 smaller packages |     9.272 |    9.215 |    +0.61% | +0.88% / -2.00% / +1.33% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.536 |  117.182 |    +1.14% | +1.14% / +1.64% / +0.37% |
| Large level          |    85.946 |   84.150 |    +2.09% | +0.88% / +2.20% / +2.47% |
| 10,000-row table     |    17.638 |   17.749 |    -0.63% | +1.03% / -0.15% / -0.66% |
| Five Blueprints      |     2.465 |    2.434 |    +1.25% | +1.35% / +2.59% / +1.25% |
| 138 smaller packages |    12.834 |   12.767 |    +0.52% | +0.86% / +0.43% / +0.70% |

### 134: Read a complete leaf type prefix once

Validate a valid 12-byte name/zero-child prefix together; fall back for every unusual case. Not retained as a separate leaf-only case: general type-prefix reader 135 handled the same valid leaves plus nested prefixes and was selected after direct and independent comparisons. All parser reference tests and 456 original package oracles passed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.204 |   61.500 |    +1.13% | +0.45% / +1.65% / +0.51% |
| Large level          |    43.215 |   42.929 |    +0.66% | +0.66% / +0.10% / +0.21% |
| 10,000-row table     |     7.048 |    7.002 |    +0.66% | -0.54% / +0.97% / -0.04% |
| Five Blueprints      |     2.050 |    2.033 |    +0.84% | +1.21% / +0.84% / +0.64% |
| 138 smaller packages |     9.265 |    9.173 |    +0.99% | -0.84% / +0.99% / +1.49% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.050 |  118.695 |    +0.30% | +0.06% / +0.90% / +0.47% |
| Large level          |    85.655 |   85.345 |    +0.36% | +0.24% / +0.30% / +0.74% |
| 10,000-row table     |    17.666 |   17.774 |    -0.61% | -0.13% / -0.64% / -0.40% |
| Five Blueprints      |     2.472 |    2.437 |    +1.41% | +1.31% / +1.28% / +1.67% |
| 138 smaller packages |    12.872 |   12.767 |    +0.81% | +1.17% / +0.81% / +0.31% |

### 135: Read general type prefixes as one valid block

Validate the complete 12-byte name/child-count prefix together; retain original allocation budgets, recursion, failure order and fallback. Selected in core2 after independent confirmation 145 and direct comparisons 142/144. Initial corpus +2.07%, level +3.18%, Blueprint +1.93%, small +1.46%, all blocks positive on those lanes; confirmation corpus +1.24%, level +2.89%, small +1.53%, all positive. Expanded 207,084 original wire oracle and prototype Clippy passed. The final root combination is measured separately.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.530 |   60.256 |    +2.07% | +1.73% / +2.42% / +2.09% |
| Large level          |    43.503 |   42.118 |    +3.18% | +3.98% / +3.18% / +1.91% |
| 10,000-row table     |     7.088 |    7.028 |    +0.84% | +5.43% / -1.05% / +0.70% |
| Five Blueprints      |     2.055 |    2.016 |    +1.93% | +0.41% / +2.11% / +1.77% |
| 138 smaller packages |     9.265 |    9.130 |    +1.46% | +3.19% / +1.31% / +1.33% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.965 |  117.279 |    +1.42% | +1.15% / +1.64% / +2.05% |
| Large level          |    85.970 |   84.465 |    +1.75% | +2.43% / +1.75% / +1.15% |
| 10,000-row table     |    17.575 |   17.678 |    -0.59% | -2.70% / +1.09% / -0.71% |
| Five Blueprints      |     2.470 |    2.424 |    +1.84% | +1.56% / +1.20% / +1.89% |
| 138 smaller packages |    12.868 |   12.684 |    +1.43% | +0.94% / +2.25% / +1.41% |

### 136: Combine name-pair and type-prefix reads

Measure the reader changes together rather than add isolated percentages. Not selected yet: corpus +2.36%, but level mixed and table -1.77%. Needs direct comparison against 135 and 126; 252 parser tests and all original package oracles passed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.964 |   60.499 |    +2.36% | +5.18% / +2.68% / +0.78% |
| Large level          |    43.204 |   42.898 |    +0.71% | +2.54% / +1.38% / -1.22% |
| 10,000-row table     |     7.068 |    7.193 |    -1.77% | +1.84% / -1.77% / -2.10% |
| Five Blueprints      |     2.055 |    2.032 |    +1.12% | +1.08% / +0.96% / +1.52% |
| 138 smaller packages |     9.263 |    9.133 |    +1.40% | +1.56% / +1.60% / +1.28% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.531 |  117.514 |    +0.86% | +1.25% / +0.67% / +0.86% |
| Large level          |    85.908 |   84.437 |    +1.71% | +2.27% / +1.19% / +1.23% |
| 10,000-row table     |    17.706 |   17.686 |    +0.11% | +0.02% / +0.12% / +0.50% |
| Five Blueprints      |     2.474 |    2.438 |    +1.43% | +1.49% / +6.84% / +1.39% |
| 138 smaller packages |    12.868 |   12.675 |    +1.50% | +0.45% / +1.35% / +1.82% |

### 137: Answer several ancestry queries in one walk

Offer an optional batched schema-provider ancestry query; default providers preserve old query order, and SourceModel computes nine answers in one bounded walk. Rejected: corpus -0.80% and level -3.55%, all blocks negative on those lanes, despite the plausible reduction in hierarchy work. 252 parser tests and 456 original package oracles passed. Adds a trait method; not retained.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.726 |   62.219 |    -0.80% | -1.11% / -0.28% / -0.90% |
| Large level          |    42.646 |   44.160 |    -3.55% | -3.01% / -2.41% / -3.55% |
| 10,000-row table     |     7.020 |    7.048 |    -0.40% | +0.93% / -3.07% / +0.22% |
| Five Blueprints      |     2.054 |    2.037 |    +0.85% | +0.85% / +1.01% / +0.90% |
| 138 smaller packages |     9.279 |    9.311 |    -0.34% | +0.23% / -3.07% / -0.07% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.216 |  119.094 |    +0.10% | +1.59% / -1.16% / +0.10% |
| Large level          |    86.373 |   86.289 |    +0.10% | +0.90% / -0.55% / -0.04% |
| 10,000-row table     |    17.642 |   17.750 |    -0.61% | -0.88% / -0.78% / +0.12% |
| Five Blueprints      |     2.474 |    2.456 |    +0.73% | +0.51% / +1.03% / +1.62% |
| 138 smaller packages |    12.889 |   12.796 |    +0.72% | +0.29% / +0.92% / +0.44% |

### 138: Visit table rows with reusable metadata

Retain table metadata and consume one rich row per callback, recycling validated record storage instead of retaining every rich row. Experimental API only: callback table +35.06% and corpus +3.56%, width stress +20–27%, but cold packages slower and the old owned path is approximately flat. 251 parser tests and all 456 covered ordinary/reconstructed-row/inspection oracles passed. This mirrors the direct DataTable decoder; modeled-session trailing-byte diagnostics differ outside the covered corpus, so it is not a blanket entrypoint-equivalence result. Not retained in production.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.573 |   61.413 |    +0.26% | -0.04% / -0.54% / +1.53% |
| Large level          |    42.741 |   43.007 |    -0.62% | -0.83% / +0.05% / -2.07% |
| 10,000-row table     |     6.989 |    7.020 |    -0.45% | +0.14% / -1.38% / -0.45% |
| Five Blueprints      |     2.057 |    2.038 |    +0.94% | +1.01% / +0.93% / +4.75% |
| 138 smaller packages |     9.300 |    9.276 |    +0.26% | -0.20% / +0.40% / +0.26% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.523 |  118.566 |    +0.80% | +1.50% / +0.43% / +0.26% |
| Large level          |    86.142 |   85.067 |    +1.25% | +1.25% / +0.44% / +0.92% |
| 10,000-row table     |    17.616 |   17.735 |    -0.68% | -1.48% / +1.02% / -0.68% |
| Five Blueprints      |     2.470 |    2.460 |    +0.41% | +0.41% / +0.02% / +0.78% |
| 138 smaller packages |    12.833 |   12.808 |    +0.19% | +0.30% / +0.13% / +0.03% |

API/dataset: **visitor**. Actual baseline: `row-visitor-control/row-visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    61.470 |   59.282 |    +3.56% | +6.03% / +3.56% / +2.60%    |
| Large level          |    43.535 |   43.501 |    +0.08% | +0.02% / -0.31% / +1.54%    |
| 10,000-row table     |     7.095 |    4.607 |   +35.06% | +35.00% / +35.46% / +35.27% |
| Five Blueprints      |     2.055 |    2.072 |    -0.85% | -0.07% / -1.16% / -1.20%    |
| 138 smaller packages |     9.278 |    9.390 |    -1.21% | -1.17% / -1.19% / -6.41%    |

API/dataset: **width**. Actual baseline: `row-visitor-control/row-visitor-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |     7.661 |    5.596 |   +26.96% | +25.48% / +26.22% / +27.04% |
| stress-width-rotating    |     7.960 |    6.186 |   +22.29% | +25.89% / +22.53% / +20.63% |
| stress-width-shuffled    |     7.868 |    6.324 |   +19.62% | +21.78% / +19.32% / +19.50% |

### 139: Bucket embedded schema lookups by path length

Use an O(1) byte-length bucket and compare only a few exact strings in the immutable default model, preserving mutable/custom-model scans. Selected as one component of core2, after combination tests 149/151/153. Standalone corpus +2.98%, level +4.53%, Blueprint +1.08%, all positive; small mixed/flat and table -0.64%, all negative. The index applies only to the immutable embedded model; custom mutation and duplicate precedence retain scans. 252 parser tests and 456 oracles passed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.546 |   59.711 |    +2.98% | +3.72% / +2.47% / +2.56% |
| Large level          |    43.055 |   41.107 |    +4.53% | +4.53% / +3.01% / +5.76% |
| 10,000-row table     |     6.951 |    6.995 |    -0.64% | -0.35% / -1.89% / -0.15% |
| Five Blueprints      |     2.056 |    2.034 |    +1.08% | +1.08% / +0.96% / +1.04% |
| 138 smaller packages |     9.269 |    9.265 |    +0.04% | +0.61% / -2.29% / +0.20% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.556 |  116.087 |    +2.08% | +1.78% / +2.08% / +2.24% |
| Large level          |    85.986 |   85.165 |    +0.96% | +2.48% / +0.96% / +2.78% |
| 10,000-row table     |    17.583 |   17.947 |    -2.07% | -2.58% / -0.18% / -2.07% |
| Five Blueprints      |     2.469 |    2.444 |    +1.04% | +0.81% / +1.08% / +1.21% |
| 138 smaller packages |    12.874 |   12.749 |    +0.97% | +1.00% / +0.97% / +0.83% |

### 140: Bucket native identities by name length

Replace the tuple tree with small exact-match buckets selected by native name length; preserve module qualification and the two existing overrides. Selected as one component of core2 after 150/151/153 combinations. Standalone corpus +1.74%, level +2.42%, Blueprint +1.53%, all blocks positive there; table/small mixed. Full module/name equality and existing overrides remain. 251 parser tests and 456 oracles passed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.562 |   60.488 |    +1.74% | +1.05% / +1.32% / +2.84% |
| Large level          |    42.950 |   41.910 |    +2.42% | +2.38% / +3.43% / +1.90% |
| 10,000-row table     |     7.076 |    7.037 |    +0.56% | -0.63% / -1.35% / +0.56% |
| Five Blueprints      |     2.060 |    2.028 |    +1.53% | +0.90% / +1.53% / +5.24% |
| 138 smaller packages |     9.281 |    9.171 |    +1.19% | -2.49% / +0.96% / +1.19% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.023 |  116.168 |    +2.40% | +2.61% / +2.55% / +1.97% |
| Large level          |    86.363 |   83.822 |    +2.94% | +3.24% / +2.94% / +2.05% |
| 10,000-row table     |    17.661 |   17.717 |    -0.32% | -0.49% / +0.05% / -1.11% |
| Five Blueprints      |     2.471 |    2.445 |    +1.05% | +1.02% / +1.05% / +4.64% |
| 138 smaller packages |    12.859 |   12.739 |    +0.93% | +1.29% / +0.73% / +0.75% |

### 141: Recycle private object-path buffers in callbacks

Reuse owned String capacities between object visits while preserving the public ObjectPath methods and owned output. Rejected as measured: callback corpus -0.86%, table -3.20% and cold workloads slower. Old owned corpus approximately flat. All covered original oracles passed. Potential manual-Clone code-generation effects remain unresolved; no cause is asserted.

API/dataset: **owned**. Actual baseline: `102-independent-visitor-session/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.337 |   67.225 |    +0.17% | -0.60% / +0.44% / +0.74% |
| Large level          |    46.133 |   46.052 |    +0.17% | -1.01% / +0.17% / +1.95% |
| 10,000-row table     |     9.063 |    9.159 |    -1.06% | -0.12% / -3.56% / -1.26% |
| Five Blueprints      |     2.054 |    2.070 |    -0.77% | -0.51% / -0.77% / -0.77% |
| 138 smaller packages |     9.377 |    9.440 |    -0.67% | -0.43% / -0.85% / -0.72% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   122.759 |  121.918 |    +0.68% | +0.54% / -0.12% / +0.68% |
| Large level          |    86.553 |   87.261 |    -0.82% | -0.58% / -0.08% / -1.04% |
| 10,000-row table     |    19.524 |   19.474 |    +0.25% | +1.63% / -0.19% / +0.24% |
| Five Blueprints      |     2.459 |    2.469 |    -0.41% | +0.78% / -0.56% / -0.61% |
| 138 smaller packages |    12.806 |   12.937 |    -1.02% | -1.06% / -0.51% / -0.87% |

API/dataset: **visitor**. Actual baseline: `102-independent-visitor-session/visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.665 |   63.201 |    -0.86% | -0.54% / -1.61% / -1.02% |
| Large level          |    42.404 |   42.400 |    +0.01% | +0.33% / +0.01% / -1.60% |
| 10,000-row table     |     8.885 |    9.169 |    -3.20% | -0.34% / -4.34% / -3.20% |
| Five Blueprints      |     2.064 |    2.095 |    -1.51% | -2.64% / -1.29% / -1.33% |
| 138 smaller packages |     9.489 |    9.659 |    -1.79% | -4.21% / -1.62% / -2.03% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   120.259 |  120.340 |    -0.07% | +0.63% / -0.29% / +0.05% |
| Large level          |    85.204 |   85.595 |    -0.46% | -0.03% / -0.25% / -0.96% |
| 10,000-row table     |    19.437 |   19.536 |    -0.51% | -0.76% / -0.52% / -0.06% |
| Five Blueprints      |     2.463 |    2.481 |    -0.73% | -0.44% / +3.06% / -4.61% |
| 138 smaller packages |    12.787 |   12.932 |    -1.14% | -1.30% / -1.14% / -0.79% |

### 142: Compare the combined reader directly with type prefixes

Compare existing 136 against 135 to decide whether the separate name-pair fast path adds useful speed. Reject the added name-pair component: corpus -0.13% in all blocks, Blueprint -0.44% in all blocks and table mixed/slower; small +0.38%. No new source variant.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.417 |   60.496 |    -0.13% | -0.45% / -1.22% / -0.13% |
| Large level          |    42.326 |   42.226 |    +0.24% | -0.08% / -1.19% / +0.34% |
| 10,000-row table     |     6.962 |    7.032 |    -1.01% | -4.17% / +0.94% / -0.42% |
| Five Blueprints      |     2.020 |    2.029 |    -0.44% | -0.05% / -0.48% / -0.12% |
| 138 smaller packages |     9.139 |    9.104 |    +0.38% | +0.27% / +0.44% / +0.55% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.058 |  117.316 |    -0.22% | +0.24% / -0.33% / +2.66% |
| Large level          |    84.524 |   84.367 |    +0.19% | +0.19% / +0.73% / +0.32% |
| 10,000-row table     |    17.648 |   17.647 |    +0.01% | -0.76% / +0.08% / +0.17% |
| Five Blueprints      |     2.446 |    2.443 |    +0.12% | -0.21% / -0.03% / +0.45% |
| 138 smaller packages |    12.687 |   12.670 |    +0.13% | +0.13% / +0.77% / -0.14% |

### 143: Recycle strings between table-row callbacks

Keep reusable String buffers for complete ASCII payloads, restore raw records before one filter call, and fall back for every other string form. Experimental API only: table +8.83% beyond 138, but callback level -3.43% and variable-width stress regressions; owned corpus nearly flat. 253 parser tests include stateful filter order/count and string fallback checks; all 456 covered reconstruction/inspection oracles passed. The direct-versus-modeled trailing-byte diagnostic boundary remains; not retained.

API/dataset: **owned**. Actual baseline: `138-row-metadata-recycling/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.548 |   61.316 |    +0.38% | +0.65% / +0.07% / +0.98% |
| Large level          |    43.103 |   43.032 |    +0.16% | -1.33% / +1.31% / +0.75% |
| 10,000-row table     |     7.037 |    7.003 |    +0.48% | -0.18% / +3.09% / +0.48% |
| Five Blueprints      |     2.040 |    2.040 |    +0.00% | -0.15% / -0.13% / +0.24% |
| 138 smaller packages |     9.268 |    9.260 |    +0.09% | +0.09% / -0.16% / +0.01% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.320 |  118.973 |    -0.55% | -0.80% / +0.63% / -0.29% |
| Large level          |    84.758 |   84.866 |    -0.13% | -0.13% / -0.16% / -0.09% |
| 10,000-row table     |    17.761 |   17.660 |    +0.57% | +0.57% / -0.84% / +1.63% |
| Five Blueprints      |     2.461 |    2.461 |    -0.01% | +0.09% / +0.35% / -0.37% |
| 138 smaller packages |    12.847 |   12.863 |    -0.12% | +0.05% / -0.43% / -0.17% |

API/dataset: **visitor**. Actual baseline: `138-row-metadata-recycling/row-visitor-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    59.554 |   59.137 |    +0.70% | +0.08% / +0.40% / +1.85% |
| Large level          |    43.123 |   44.600 |    -3.43% | -0.07% / -3.95% / -3.71% |
| 10,000-row table     |     4.596 |    4.190 |    +8.83% | +8.36% / +8.03% / +8.83% |
| Five Blueprints      |     2.074 |    2.072 |    +0.10% | -0.03% / +0.25% / +0.17% |
| 138 smaller packages |     9.406 |    9.351 |    +0.58% | +0.06% / +0.58% / +0.34% |

API/dataset: **width**. Actual baseline: `138-row-metadata-recycling/row-visitor-speed`.

Parse plus decode:

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     5.606 |    5.613 |    -0.13% | +0.18% / -0.84% / -0.13% |
| stress-width-rotating    |     6.164 |    6.331 |    -2.72% | -2.90% / -2.92% / -1.02% |
| stress-width-shuffled    |     6.319 |    6.499 |    -2.85% | -2.85% / -3.77% / -3.29% |

### 144: Compare name pairs directly with type prefixes

Use 135 as the baseline and the preserved 126 name-pair binary as the candidate. Prefer 135: name-pair candidate corpus -0.43% and small -0.93%, all blocks negative on those lanes; level/table mixed. No new source.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.182 |   60.440 |    -0.43% | -0.58% / -0.20% / -0.76% |
| Large level          |    42.166 |   42.367 |    -0.48% | -1.96% / +0.45% / -0.48% |
| 10,000-row table     |     7.018 |    7.066 |    -0.69% | -1.23% / +0.96% / -0.95% |
| Five Blueprints      |     2.030 |    2.025 |    +0.24% | +6.45% / +0.00% / +0.27% |
| 138 smaller packages |     9.127 |    9.212 |    -0.93% | -1.14% / -0.93% / -0.89% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   116.478 |  117.008 |    -0.45% | +0.04% / -0.45% / -1.04% |
| Large level          |    84.361 |   84.373 |    -0.01% | -0.65% / -0.01% / -0.36% |
| 10,000-row table     |    17.732 |   17.652 |    +0.45% | -0.64% / +0.71% / +0.21% |
| Five Blueprints      |     2.439 |    2.449 |    -0.39% | +0.27% / -1.62% / -0.42% |
| 138 smaller packages |    12.667 |   12.773 |    -0.84% | -0.67% / -0.86% / -0.69% |

### 145: Independently confirm general type prefixes

Repeat 135 against core1 in a new measurement window, then verify expanded wire cases and Clippy. Corpus +1.24%, level +2.89% and small +1.53%, all blocks positive on those lanes; table and Blueprint mixed. Expanded 207,084 original wire cases and all-target Clippy passed. No new source variant.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.958 |   61.188 |    +1.24% | +1.32% / +1.18% / +4.46% |
| Large level          |    43.029 |   41.787 |    +2.89% | +2.89% / +1.47% / +2.37% |
| 10,000-row table     |     6.950 |    7.062 |    -1.61% | +0.58% / -0.24% / -2.01% |
| Five Blueprints      |     2.054 |    2.030 |    +1.20% | +1.35% / -6.45% / +1.20% |
| 138 smaller packages |     9.275 |    9.133 |    +1.53% | +1.49% / +1.63% / +1.30% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   118.256 |  117.534 |    +0.61% | +1.29% / +0.61% / +0.04% |
| Large level          |    86.122 |   84.198 |    +2.23% | +1.69% / +1.75% / +2.89% |
| 10,000-row table     |    17.838 |   17.805 |    +0.18% | -0.97% / -7.80% / +0.58% |
| Five Blueprints      |     2.474 |    2.441 |    +1.36% | +1.36% / +0.95% / +1.27% |
| 138 smaller packages |    12.859 |   12.797 |    +0.49% | +1.56% / +0.46% / +0.16% |

### 146: Measure the dependency graph before conversion changes

Compare 135 with an otherwise unchanged build that declares the six new locked packages. Control measurement: corpus -1.48% in all blocks and mixed/slower cold results. No string algorithm changed. This isolates an adoption cost; it is not a build-tuning improvement.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.643 |   61.539 |    -1.48% | -0.51% / -0.73% / -1.48% |
| Large level          |    42.168 |   42.521 |    -0.84% | -2.27% / -0.13% / +0.43% |
| 10,000-row table     |     6.956 |    7.001 |    -0.64% | -0.64% / -0.62% / +0.70% |
| Five Blueprints      |     2.023 |    2.026 |    -0.15% | -0.15% / -0.51% / +0.14% |
| 138 smaller packages |     9.166 |    9.423 |    -2.80% | -2.88% / +0.19% / -3.05% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.027 |  116.619 |    +0.35% | +0.87% / -1.19% / +0.54% |
| Large level          |    84.154 |   83.933 |    +0.26% | +0.26% / -0.03% / +0.56% |
| 10,000-row table     |    17.679 |   17.457 |    +1.26% | +1.32% / +1.26% / +1.14% |
| Five Blueprints      |     2.444 |    2.432 |    +0.49% | +6.68% / +0.49% / +0.47% |
| 138 smaller packages |    12.694 |   12.636 |    +0.46% | +0.23% / +0.22% / +0.49% |

### 147: Add Latin-1 conversion to the type-prefix reader

Compare conversion code with a control using the identical added dependency graph. Isolated algorithm corpus +1.26%, table +4.92%, small +1.14% and Blueprint +0.16%, all blocks positive on those lanes. Net adoption is measured separately in 148. 252 parser tests, all package oracles and 207,084 original wire cases passed.

API/dataset: **owned**. Actual baseline: `146-type-prefix-codec-control/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.519 |   60.743 |    +1.26% | +1.15% / +2.16% / +1.46% |
| Large level          |    42.882 |   42.727 |    +0.36% | +0.36% / -0.50% / +0.16% |
| 10,000-row table     |     6.968 |    6.625 |    +4.92% | +4.87% / +3.41% / +5.28% |
| Five Blueprints      |     2.026 |    2.023 |    +0.16% | +0.06% / +0.34% / +0.21% |
| 138 smaller packages |     9.151 |    9.047 |    +1.14% | +1.14% / +1.09% / +0.95% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.339 |  113.647 |    +3.15% | +3.59% / +3.18% / +2.44% |
| Large level          |    84.201 |   81.845 |    +2.80% | +3.93% / +1.93% / +3.06% |
| 10,000-row table     |    17.493 |   16.843 |    +3.71% | +3.79% / +3.42% / +3.68% |
| Five Blueprints      |     2.435 |    2.414 |    +0.87% | +0.99% / +3.39% / +0.06% |
| 138 smaller packages |    12.630 |   12.483 |    +1.17% | +0.43% / +1.25% / +1.17% |

### 148: Measure net Latin-1 adoption on type prefixes

Compare 135 without the dependency against 147 with both the dependency and conversion change. Net corpus +0.99% mixed and table +4.71% all positive, but level -1.44% all negative and Blueprint mixed/slower. Not a uniform net win; test the final lookup combination separately.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.796 |   60.194 |    +0.99% | +1.55% / -0.46% / +0.99% |
| Large level          |    41.879 |   42.481 |    -1.44% | -1.32% / -1.81% / -1.14% |
| 10,000-row table     |     6.980 |    6.651 |    +4.71% | +4.69% / +1.49% / +5.54% |
| Five Blueprints      |     2.028 |    2.050 |    -1.08% | -1.08% / +0.24% / -3.04% |
| 138 smaller packages |     9.148 |    9.044 |    +1.14% | +1.10% / +6.42% / +1.04% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   116.879 |  113.351 |    +3.02% | +3.11% / +4.27% / +2.82% |
| Large level          |    84.547 |   81.988 |    +3.03% | +2.58% / +2.39% / +3.32% |
| 10,000-row table     |    17.702 |   16.872 |    +4.69% | +4.33% / +5.05% / +4.53% |
| Five Blueprints      |     2.444 |    2.419 |    +1.00% | +1.22% / +0.77% / +0.63% |
| 138 smaller packages |    12.665 |   12.450 |    +1.70% | +1.68% / +3.20% / +1.70% |

### 149: Combine type prefixes with schema length buckets

Add the immutable embedded schema index to 135 and measure the source combination directly. Corpus +2.33% and level +5.05%, all blocks positive; table/small flat and Blueprint -0.27%. 253 parser tests and all 456 package oracles passed.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.248 |   58.844 |    +2.33% | +2.02% / +1.43% / +3.09% |
| Large level          |    42.242 |   40.108 |    +5.05% | +5.05% / +4.34% / +5.30% |
| 10,000-row table     |     6.979 |    6.983 |    -0.05% | +2.92% / -1.36% / -0.05% |
| Five Blueprints      |     2.024 |    2.030 |    -0.27% | -0.27% / -0.17% / -0.52% |
| 138 smaller packages |     9.130 |    9.138 |    -0.09% | -0.13% / -0.26% / +0.52% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.140 |  116.226 |    +0.78% | +1.04% / +0.54% / +0.84% |
| Large level          |    84.066 |   83.019 |    +1.25% | +1.56% / +1.75% / +1.01% |
| 10,000-row table     |    17.708 |   17.578 |    +0.74% | +0.74% / +1.03% / +2.48% |
| Five Blueprints      |     2.448 |    2.447 |    +0.05% | -0.69% / +0.81% / +0.24% |
| 138 smaller packages |    12.675 |   12.691 |    -0.13% | -0.13% / -1.66% / +0.02% |

### 150: Combine type prefixes with native length buckets

Add the qualified native-identity buckets to 135 and measure the source combination. Corpus +2.88%, level +3.48% and small +1.26%, all blocks positive on those lanes; table -1.99% all negative and Blueprint flat. 252 parser tests and all package oracles passed.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.518 |   58.775 |    +2.88% | +1.63% / +4.51% / +2.88% |
| Large level          |    42.293 |   40.821 |    +3.48% | +3.39% / +1.92% / +4.29% |
| 10,000-row table     |     6.954 |    7.093 |    -1.99% | -1.88% / -4.57% / -0.95% |
| Five Blueprints      |     2.024 |    2.024 |    +0.01% | +0.01% / +0.11% / +1.34% |
| 138 smaller packages |     9.135 |    9.020 |    +1.26% | +1.26% / +1.29% / +0.92% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   116.597 |  115.196 |    +1.20% | +1.75% / +1.68% / +0.17% |
| Large level          |    84.318 |   82.003 |    +2.75% | +2.57% / +2.77% / +2.96% |
| 10,000-row table     |    17.646 |   17.725 |    -0.45% | -0.90% / -0.45% / +1.02% |
| Five Blueprints      |     2.446 |    2.417 |    +1.19% | +1.11% / +0.82% / +1.26% |
| 138 smaller packages |    12.665 |   12.584 |    +0.64% | +1.52% / +0.68% / +0.19% |

### 151: Combine type prefixes with both lookup indexes

Measure the two indexes together with 135 instead of adding their isolated percentages. Corpus +3.10%, level +6.21% and table +0.81%, all blocks positive; Blueprint mixed and small -3.18% mixed. 254 parser tests and all package oracles passed. Test 153 for the net string-decoder addition.

API/dataset: **owned**. Actual baseline: `135-grouped-type-prefix/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    59.761 |   57.911 |    +3.10% | +4.40% / +3.73% / +3.03% |
| Large level          |    42.413 |   39.777 |    +6.21% | +5.79% / +6.61% / +6.01% |
| 10,000-row table     |     7.045 |    6.988 |    +0.81% | +0.52% / +0.54% / +1.82% |
| Five Blueprints      |     2.045 |    2.003 |    +2.05% | +4.51% / -0.89% / +2.05% |
| 138 smaller packages |     9.134 |    9.424 |    -3.18% | -3.15% / -3.33% / +0.48% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   116.613 |  114.898 |    +1.47% | +0.76% / +1.47% / +1.13% |
| Large level          |    84.079 |   81.645 |    +2.89% | +7.41% / -0.29% / +3.53% |
| 10,000-row table     |    17.657 |   17.720 |    -0.36% | +0.33% / -0.74% / -0.42% |
| Five Blueprints      |     2.448 |    2.422 |    +1.06% | +1.06% / +4.17% / -0.01% |
| 138 smaller packages |    12.662 |   12.706 |    -0.35% | -0.35% / -1.02% / +0.07% |

### 152: Combine both indexes, type prefixes, Latin-1 and array recipes

Measure the full proposed source together against 151, including dependency adoption and scalar-array semantic recipes. Corpus +3.45%, level +3.21%, table +5.47% and small +2.33%, all blocks positive on those lanes; Blueprint mixed. 257 parser tests and all package oracles passed. Direct comparison 154 rejected the array addition in favor of 153.

API/dataset: **owned**. Actual baseline: `151-type-prefix-buckets/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    57.891 |   55.893 |    +3.45% | +3.97% / +3.09% / +3.60% |
| Large level          |    39.553 |   38.281 |    +3.21% | +4.83% / +1.45% / +3.21% |
| 10,000-row table     |     7.079 |    6.692 |    +5.47% | +5.47% / +3.79% / +7.49% |
| Five Blueprints      |     2.007 |    1.984 |    +1.15% | +1.15% / -1.74% / +0.84% |
| 138 smaller packages |     9.084 |    8.873 |    +2.33% | +2.51% / +2.79% / +2.00% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   115.158 |  110.554 |    +4.00% | +4.38% / +3.95% / +3.59% |
| Large level          |    81.300 |   77.692 |    +4.44% | +4.68% / +3.76% / +4.45% |
| 10,000-row table     |    17.669 |   17.078 |    +3.35% | +3.35% / +4.04% / +2.69% |
| Five Blueprints      |     2.427 |    2.377 |    +2.06% | +2.06% / +1.28% / +2.09% |
| 138 smaller packages |    12.702 |   12.348 |    +2.78% | +2.41% / +3.17% / +1.91% |

### 153: Add Latin-1 decoding to both indexes and type prefixes

Measure net dependency and decoder adoption on the complete 151 source, with no new array recipes. Selected as frozen core2. Net encoder addition versus 151: corpus +2.24%, level +1.32%, table +6.61%, Blueprint +2.28%, small +3.50%, every block positive. Direct 154 favored it over adding arrays. Fresh root original comparison: corpus +47.13%, level +44.36%, table +70.25%, Blueprint +16.48%, small +21.08%; all parse-plus-decode blocks positive. Incremental large-level header parsing versus core1 regresses 1.21% at the ratio of medians (all blocks negative); this tradeoff is reported. Root 719 Rust tests/8 ignored, Clippy, Windows layout and Node24/26 fresh WASM versus original-native parity passed; full portable gate failed at optional Windows package ENOTDIR, and fresh UE5.7/5.8 are unavailable.

API/dataset: **owned**. Actual baseline: `151-type-prefix-buckets/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    57.859 |   56.565 |    +2.24% | +2.12% / +2.68% / +2.56% |
| Large level          |    39.600 |   39.078 |    +1.32% | +1.58% / +0.54% / +0.76% |
| 10,000-row table     |     6.974 |    6.513 |    +6.61% | +6.66% / +7.65% / +3.96% |
| Five Blueprints      |     2.010 |    1.964 |    +2.28% | +2.09% / +2.34% / +1.88% |
| 138 smaller packages |     9.098 |    8.780 |    +3.50% | +3.50% / +3.60% / +3.41% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   115.125 |  109.991 |    +4.46% | +4.55% / +4.79% / +3.59% |
| Large level          |    81.199 |   78.009 |    +3.93% | +2.64% / +4.23% / +4.06% |
| 10,000-row table     |    17.639 |   16.856 |    +4.44% | +4.74% / +4.26% / +5.00% |
| Five Blueprints      |     2.420 |    2.353 |    +2.77% | +2.88% / +2.57% / +2.71% |
| 138 smaller packages |    12.692 |   12.127 |    +4.45% | +4.60% / +3.26% / +4.40% |

### 154: Decide whether array recipes improve the final source

Compare complete 152 directly against complete 153 with the same dependency graph, isolating the array addition. Reject the array addition: corpus flat (-0.01% mixed), level +1.38% all positive, but table -1.46% and small -1.16%, all blocks negative on those lanes. Select the simpler 153 source. No new source variant.

API/dataset: **owned**. Actual baseline: `153-final-source-combination/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.378 |   56.383 |    -0.01% | +0.92% / -0.51% / -0.28% |
| Large level          |    39.158 |   38.619 |    +1.38% | +3.70% / +1.38% / +0.94% |
| 10,000-row table     |     6.584 |    6.680 |    -1.46% | -1.53% / -1.91% / -1.46% |
| Five Blueprints      |     1.967 |    1.987 |    -1.05% | -1.51% / +3.42% / -1.04% |
| 138 smaller packages |     8.758 |    8.859 |    -1.16% | -1.16% / -2.49% / -1.12% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   110.598 |  109.830 |    +0.69% | +0.32% / +0.06% / +1.15% |
| Large level          |    78.384 |   77.420 |    +1.23% | +0.28% / +1.26% / +1.53% |
| 10,000-row table     |    16.855 |   17.085 |    -1.37% | -1.12% / -1.37% / -1.32% |
| Five Blueprints      |     2.392 |    2.385 |    +0.30% | +4.88% / -0.84% / +0.24% |
| 138 smaller packages |    12.125 |   12.310 |    -1.53% | -1.65% / -1.70% / -1.52% |

### 157: Prepare primitive-array decoding recipes

Resolve the existing ScalarKind and stride per reused layout, skipping repeated inner-type work and successful breadcrumb formatting; retain all payload and fallback checks. Not retained after direct combination comparison 154: arrays improved the level but left corpus flat and slowed tables/small packages versus 153. Standalone corpus +1.93% and level +1.79%, all positive, but table -0.73%, Blueprint -0.47%, small -0.14%, all negative. 252 parser tests include 100,040 prepared-versus-ordinary cases and float-bit checks; all package oracles passed.

API/dataset: **owned**. Actual baseline: `core-1/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.916 |   60.720 |    +1.93% | +0.89% / +2.52% / +2.34% |
| Large level          |    43.020 |   42.249 |    +1.79% | +3.81% / +1.24% / +1.79% |
| 10,000-row table     |     7.001 |    7.052 |    -0.73% | -0.05% / -0.73% / -3.22% |
| Five Blueprints      |     2.051 |    2.061 |    -0.47% | -0.37% / -0.52% / -0.47% |
| 138 smaller packages |     9.270 |    9.282 |    -0.14% | -0.04% / -0.14% / -0.25% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   119.381 |  116.591 |    +2.34% | +1.50% / +2.32% / +2.74% |
| Large level          |    85.760 |   83.605 |    +2.51% | +2.42% / +2.79% / +2.61% |
| 10,000-row table     |    17.685 |   17.721 |    -0.20% | -3.20% / -0.20% / +0.34% |
| Five Blueprints      |     2.466 |    2.476 |    -0.37% | -0.12% / -0.31% / -7.44% |
| 138 smaller packages |    12.872 |   12.881 |    -0.07% | +1.38% / -0.26% / -0.39% |

### 158: Use a four-byte private array recipe descriptor

Compare an explicitly aligned four-byte recipe with the three-byte descriptor in 157, keeping the tag allocation footprint unchanged. Not retained: corpus flat/mixed, table -0.33% mixed, level mixed and only a tiny small-package gain. Both profiles lost zero samples; lower fixed-work instructions/cycles did not establish a broad elapsed-time win.

API/dataset: **owned**. Actual baseline: `157-prepared-scalar-arrays/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    60.836 |   60.886 |    -0.08% | -1.21% / +0.18% / +0.13% |
| Large level          |    42.510 |   42.276 |    +0.55% | +1.78% / -2.18% / +1.23% |
| 10,000-row table     |     7.115 |    7.138 |    -0.33% | -0.11% / +0.30% / -1.41% |
| Five Blueprints      |     2.058 |    2.050 |    +0.38% | -0.02% / +0.38% / +1.06% |
| 138 smaller packages |     9.285 |    9.271 |    +0.14% | +0.04% / +0.14% / +0.07% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   117.272 |  118.248 |    -0.83% | -0.83% / +0.91% / -0.92% |
| Large level          |    83.971 |   84.612 |    -0.76% | -0.45% / -1.13% / -0.93% |
| 10,000-row table     |    17.824 |   17.846 |    -0.12% | -1.81% / -0.10% / +0.87% |
| Five Blueprints      |     2.483 |    2.463 |    +0.81% | +0.40% / +0.81% / +1.29% |
| 138 smaller packages |    12.899 |   12.830 |    +0.53% | +0.50% / +0.55% / +0.48% |

### 159: Precompute bounded built-in class ancestry

The immutable embedded class graph can answer repeated ancestry queries from one precomputed list per class; custom models retain the original mutable 64-step walk. Rejected: corpus -0.75%, Blueprint -2.68% and small -1.76%, all blocks negative. Level/table effects were mixed. 257 parser tests, Clippy and all 456 original package oracles passed. The bounded precomputed graph reduced instructions only 0.25% while cycles rose 1.89% and branch misses rose 31%; exact regression cause remains unresolved. Both profiles reported zero lost samples. Baseline: core2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.655 |   57.079 |    -0.75% | -0.75% / -0.08% / -1.06% |
| Large level          |    39.454 |   39.367 |    +0.22% | +0.22% / -0.53% / -0.45% |
| 10,000-row table     |     6.521 |    6.528 |    -0.11% | -0.11% / -2.09% / +0.23% |
| Five Blueprints      |     1.964 |    2.017 |    -2.68% | -2.13% / -2.73% / -2.74% |
| 138 smaller packages |     8.761 |    8.916 |    -1.76% | -5.48% / -1.62% / -2.04% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.422 |  112.548 |    -2.86% | -3.24% / -2.86% / -1.97% |
| Large level          |    78.339 |   79.553 |    -1.55% | -1.90% / -2.28% / -1.51% |
| 10,000-row table     |    17.105 |   16.998 |    +0.62% | -1.02% / +1.79% / +1.01% |
| Five Blueprints      |     2.353 |    2.426 |    -3.10% | -2.92% / -3.52% / -2.69% |
| 138 smaller packages |    12.101 |   12.351 |    -2.06% | -2.06% / -2.02% / -2.20% |

### 160: Copy common owned type-tree shapes directly

The census has 84,320 nonempty parameter vectors but only 84,529 elements; direct empty/single-leaf clones might remove generic recursive-vector work while preserving fully owned Vec fields. Rejected after independent comparison161. Initial corpus +1.17%, level +0.61%, table +3.60%, all blocks positive, but Blueprint -0.87% all negative; smaller packages mixed and small JSON -0.47% all negative. 256 parser tests, Clippy and456original package cases passed after a test-only private-constructor fix (first failure preserved). The public owned API was unchanged. Instructions fell1.52%, cycles were flat/slightly higher; zero lost profile samples.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.665 |   56.000 |    +1.17% | +1.17% / +0.27% / +1.38% |
| Large level          |    38.839 |   38.603 |    +0.61% | +2.18% / +0.46% / +0.61% |
| 10,000-row table     |     6.559 |    6.323 |    +3.60% | +0.89% / +4.75% / +3.60% |
| Five Blueprints      |     1.961 |    1.978 |    -0.87% | -0.12% / -1.12% / -0.87% |
| 138 smaller packages |     8.979 |    8.839 |    +1.57% | +4.82% / +1.51% / -0.79% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   110.087 |  108.712 |    +1.25% | +0.61% / +1.07% / +1.68% |
| Large level          |    77.688 |   77.248 |    +0.57% | +1.42% / +0.26% / +1.23% |
| 10,000-row table     |    16.808 |   16.590 |    +1.30% | +1.03% / +1.99% / +1.33% |
| Five Blueprints      |     2.359 |    2.357 |    +0.06% | -0.50% / +0.04% / +0.12% |
| 138 smaller packages |    12.127 |   12.183 |    -0.47% | -0.23% / -0.59% / -0.78% |

### 161: Independently confirm the owned type-clone change

Repeat the complete five-operation comparison against core2 to check whether the small aggregate gain and cold-workload regressions persist. Confirms rejection of160: corpus +1.20%, level +1.31%, table +3.81%, all blocks positive, but Blueprint -0.90% and small -1.00%, every block negative. Small/Blueprint JSON also regress in all blocks. The narrow aggregate gain does not justify the repeated cold-workload cost. Exact saved160binary/source, baselinecore2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.433 |   55.755 |    +1.20% | +0.25% / +1.54% / +1.59% |
| Large level          |    38.799 |   38.292 |    +1.31% | +1.62% / +0.13% / +1.99% |
| 10,000-row table     |     6.597 |    6.345 |    +3.81% | +3.60% / +4.37% / +5.69% |
| Five Blueprints      |     1.959 |    1.977 |    -0.90% | -0.89% / -0.90% / -0.30% |
| 138 smaller packages |     8.761 |    8.849 |    -1.00% | -1.00% / -0.70% / -1.16% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.627 |  108.522 |    +1.01% | +0.56% / +1.07% / +1.23% |
| Large level          |    78.090 |   77.097 |    +1.27% | +1.58% / +1.29% / +1.03% |
| 10,000-row table     |    16.815 |   16.609 |    +1.23% | +1.30% / +0.62% / +1.26% |
| Five Blueprints      |     2.350 |    2.371 |    -0.89% | -0.54% / -1.02% / -0.98% |
| 138 smaller packages |    12.137 |   12.206 |    -0.57% | -0.35% / -0.57% / -3.92% |

### 162: Aggregate common header differences before replay

Avoid repeated mismatch branches for common 25-byte headers by reducing all changed words into one final result. Cache metadata is already bounded to16KiB; a mismatch still leaves the cursor and decoder untouched. Rejected: corpus -0.33%, level -0.79%, Blueprint -0.77%, small -0.34%, every paired block negative on those lanes. Table mixed. The final reduction did not improve elapsed time. Parser tests, Clippy and all456oracles passed. Baselinecore2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.446 |   56.633 |    -0.33% | -0.20% / -1.52% / -0.07% |
| Large level          |    38.916 |   39.222 |    -0.79% | -0.27% / -0.84% / -2.29% |
| 10,000-row table     |     6.666 |    6.653 |    +0.20% | -0.69% / +1.05% / +2.02% |
| Five Blueprints      |     1.962 |    1.977 |    -0.77% | -1.07% / -0.71% / -0.64% |
| 138 smaller packages |     8.777 |    8.807 |    -0.34% | -4.29% / -0.34% / -0.29% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.666 |  110.477 |    -0.74% | -1.67% / -0.18% / -0.74% |
| Large level          |    78.630 |   78.643 |    -0.02% | -0.02% / -0.25% / +0.68% |
| 10,000-row table     |    16.819 |   16.963 |    -0.86% | -0.32% / -0.86% / -0.95% |
| Five Blueprints      |     2.351 |    2.371 |    -0.88% | -1.16% / -0.65% / +2.87% |
| 138 smaller packages |    12.136 |   12.145 |    -0.07% | +2.91% / -0.19% / +0.16% |

### 163: Check complete header-array lengths once

Convert both common complete header slices to fixed 25-byte arrays before word loads, exposing their bounds and combining the current Bool flag difference with the words. Rejected: corpus -1.33% mixed, level -2.54%, table -2.55%, Blueprint -1.41%, small -1.61%; every block negative on the four named individual workloads. All255parser tests, Clippy and456oracles passed. Stronger type-level bounds did not improve elapsed time. Baselinecore2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.519 |   57.273 |    -1.33% | +0.57% / -1.33% / -0.80% |
| Large level          |    39.214 |   40.209 |    -2.54% | -6.80% / -1.54% / -1.45% |
| 10,000-row table     |     6.552 |    6.720 |    -2.55% | -2.21% / -3.79% / -7.10% |
| Five Blueprints      |     1.963 |    1.990 |    -1.41% | -1.68% / -1.28% / -4.28% |
| 138 smaller packages |     8.766 |    8.907 |    -1.61% | -1.04% / -3.96% / -1.41% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.359 |  110.876 |    -1.39% | -1.55% / -1.39% / +0.32% |
| Large level          |    78.183 |   79.409 |    -1.57% | -1.38% / -1.67% / -2.48% |
| 10,000-row table     |    16.810 |   17.109 |    -1.78% | -1.86% / -2.06% / -1.43% |
| Five Blueprints      |     2.354 |    2.377 |    -0.99% | -0.80% / -0.91% / -1.12% |
| 138 smaller packages |    12.116 |   12.258 |    -1.17% | -1.19% / -0.57% / -1.33% |

### 164: Use a bounded linear export replay cache

The existing per-package class cache has at most64 entries and integer keys. A small vector may avoid keyed hashing while keeping the same learning, disable and eviction behavior. Rejected: corpus -1.94%, level -2.47%, Blueprint -1.22%, small -0.09%, all paired blocks negative there. Table +0.78%, all positive, does not offset broader regressions.255parser tests, Clippy and456oracles passed. Cache learning/limits/publicAPI unchanged; baselinecore2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.249 |   57.340 |    -1.94% | -1.93% / -1.63% / -1.94% |
| Large level          |    39.005 |   39.966 |    -2.47% | -3.51% / -1.00% / -2.86% |
| 10,000-row table     |     6.546 |    6.495 |    +0.78% | +0.20% / +1.14% / +0.80% |
| Five Blueprints      |     1.959 |    1.983 |    -1.22% | -1.07% / -1.34% / -1.42% |
| 138 smaller packages |     8.763 |    8.771 |    -0.09% | -0.08% / -0.03% / -0.70% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.605 |  112.607 |    -2.74% | -2.29% / -0.63% / -5.39% |
| Large level          |    77.792 |   79.559 |    -2.27% | -2.57% / -1.55% / -2.77% |
| 10,000-row table     |    16.815 |   16.799 |    +0.10% | +0.75% / +0.18% / -0.37% |
| Five Blueprints      |     2.351 |    2.381 |    -1.24% | -1.06% / -1.25% / -0.98% |
| 138 smaller packages |    12.087 |   12.184 |    -0.80% | +3.48% / -0.85% / -0.92% |

### 165: Keep replay-cache keys in a separate compact column

Scan only contiguous integer keys before accessing the larger replay states, while preserving the existing64class bound and exact key equality. Rejected: corpus -0.51% mixed, table -0.67% mixed, Blueprint -1.04% in all blocks; level/small effects tiny and mixed.255parser tests, Clippy and456oracles passed. Separating compact keys from states did not produce a broad win. Existing HashMap retained; baselinecore2.

API/dataset: **owned**. Actual baseline: `core-2/parser-speed`.

Parse plus decode:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    56.166 |   56.451 |    -0.51% | -0.23% / -1.57% / +0.18% |
| Large level          |    39.458 |   39.374 |    +0.21% | -0.87% / +1.15% / +0.64% |
| 10,000-row table     |     6.542 |    6.586 |    -0.67% | -0.28% / +0.24% / -2.15% |
| Five Blueprints      |     1.960 |    1.981 |    -1.04% | -1.18% / -1.02% / -1.25% |
| 138 smaller packages |     8.766 |    8.755 |    +0.13% | +0.25% / -1.62% / +0.13% |

Streaming JSON:

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |   109.948 |  112.488 |    -2.31% | -2.28% / -2.95% / -2.99% |
| Large level          |    78.718 |   80.142 |    -1.81% | -2.77% / -1.47% / -2.48% |
| 10,000-row table     |    16.775 |   17.260 |    -2.89% | -1.44% / -3.05% / -3.05% |
| Five Blueprints      |     2.351 |    2.384 |    -1.41% | -1.12% / -1.48% / -1.71% |
| 138 smaller packages |    12.103 |   12.222 |    -0.99% | -0.99% / -1.01% / -0.93% |

A newer standard-library `Vec::push_mut` shortcut was considered but not benchmarked: it requires Rust 1.95, above the parser’s Rust 1.88 floor. No toolchain-floor change was made. See the [official Vec source](https://github.com/rust-lang/rust/blob/main/library/alloc/src/vec/mod.rs).

## Verification and limits

- PASS: 140 fixtures + 267 malformed inputs match initial parser
  PASS: all currently available synthetic stress oracles
- PASS: synthetic codec cases exactly match the pre-session original parser
- UAsset Rust checks: **719 passed, 8 ignored**. Parser Clippy status: 0; Windows layout status: 0. Native/WASM/browser/packed/saved-review results are recorded in the full gate log.
- Node 24.21.0 and Node 26.13.0 WASM versus preserved original-native parity statuses: 0 / 0.
- Full portable `pnpm check` status: **1**. The log records the failure. In this session it has stopped at the optional Windows engine package consumer install with ENOTDIR; this is not a green full gate and does not verify phases after that failure.
- Fresh UE 5.7: **unavailable**.
- Fresh UE 5.8: **unavailable**.
- The engine matrix status is 1; discovery alone is not an Unreal conformance pass.
- A stale-mtime control-rebuild attempt was stopped, preserved and excluded. The harness touches restored source before compilation; earlier build logs were audited for real parser compilation, and a forced rebuilt control matched its original binary.
- During integration, a test-only Clippy initializer warning and stale standalone WASM lockfile were corrected. Their first failing logs remain preserved. Parity against the previous WASM build was excluded; the final checks build the selected source afresh.
- Source hashes match before and after verification and timing. Original binaries and earlier evidence remain preserved.

Readable data: [source-design.json](evidence/uasset-speed-2026-10-31/source-design.json), [source-core-2.json](evidence/uasset-speed-2026-10-31/source-core-2.json). Lossless trial patches, scripts, samples, temperatures and counters: [source-design-raw.json.gz](evidence/uasset-speed-2026-10-31/source-design-raw.json.gz). Checkpoint measurements: [source-core-2-raw.json.gz](evidence/uasset-speed-2026-10-31/source-core-2-raw.json.gz). Decompress with `gzip -dc FILE`; each index records its compressed SHA-256. Local binaries, profiles and logs remain under `out/uasset-speed-2026-10-31/architecture/`.

## WASM follow-up: bounded inspection output

The native source checkpoint above remains unchanged. A further WASM-only adapter change specializes `Write::write_all` for its private buffer, which always writes an entire slice or returns an error. It removes the generic partial-write retry loop while keeping the existing byte-limit check, all-or-error writes, sticky limit flag, error text and UTF-8 validation. No runtime API, wire schema, allocator or build setting changes.

V8 profiles of the previous checkpoint attributed about 29.8% of sampled time to `CappedWriter::write_all`, after combining identical functions across call sites. The original-source profile was about 23.6%. These profiles include startup, compilation and warmups; their instrumented timings are not throughput results, and V8 supplies no native perf lost-sample count.

The prototype compared an unchanged Core2 build and the writer change in the same isolated source path. Final totals below compare a fresh production module directly with a newly built, audited pre-session original source (`3d7e0ba2`). Stage gains are not added. All 140 valid and 267 malformed inspection JSON outputs match exactly.

Preloaded JavaScript bytes. A new ParsedPackage copies input into WASM and parses it. Inspection additionally decodes and retains exports, serializes JSON and returns a JavaScript string. Explicit free is timed. Process startup, module compilation/loading, fixture reads and output hashing are excluded from timings. Normal V8 GC is included. Three interleaved/reversed blocks,15 samples after3 warmups,30ms calibration; CPU6 worker/CPU7 controller. WASM uses its standard allocator, not the held native mimalloc.

### Node 26.13.0: full WASM inspection

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |     439.358 |     239.251 |   +45.55% | +45.41% / +45.39% / +45.81% |
| Large level          |     304.794 |     168.399 |   +44.75% | +44.30% / +45.76% / +44.59% |
| 10,000-row table     |      88.462 |      34.138 |   +61.41% | +61.37% / +62.88% / +61.59% |
| Five Blueprints      |      18.219 |      14.791 |   +18.81% | +17.80% / +11.18% / +25.80% |
| 138 smaller packages |      55.571 |      47.207 |   +15.05% | +16.68% / +14.52% / +15.10% |

Header construction and cleanup only:

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |      33.123 |      26.537 |   +19.89% | +20.21% / +19.96% / +18.48% |
| Large level          |      19.320 |      14.868 |   +23.04% | +25.61% / +23.04% / +22.80% |
| 10,000-row table     |       4.219 |       3.121 |   +26.03% | +26.46% / +26.30% / +24.45% |
| Five Blueprints      |       3.193 |       0.938 |   +70.61% | +59.56% / +71.99% / +69.69% |
| 138 smaller packages |      10.308 |       9.182 |   +10.92% | +14.01% / +7.20% / +12.42%  |

### Node 24.21.0: full WASM inspection

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |     468.595 |     258.219 |   +44.90% | +43.78% / +45.15% / +46.27% |
| Large level          |     315.684 |     182.563 |   +42.17% | +42.17% / +42.24% / +40.52% |
| 10,000-row table     |      92.890 |      37.199 |   +59.95% | +60.06% / +59.95% / +58.07% |
| Five Blueprints      |      19.866 |      15.360 |   +22.68% | +22.70% / +10.39% / +23.67% |
| 138 smaller packages |      57.881 |      48.350 |   +16.47% | +15.99% / +16.88% / +16.47% |

Header construction and cleanup only:

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |      35.681 |      28.266 |   +20.78% | +21.87% / +20.60% / +20.77% |
| Large level          |      21.128 |      15.576 |   +26.28% | +25.39% / +26.68% / +28.16% |
| 10,000-row table     |       4.649 |       3.273 |   +29.60% | +29.38% / +29.60% / +29.28% |
| Five Blueprints      |       2.965 |       1.209 |   +59.21% | +60.22% / +61.02% / +59.21% |
| 138 smaller packages |      10.966 |       9.465 |   +13.69% | +10.44% / +16.76% / +13.69% |

### Trial167: specialize whole-slice writes

The controlled prototype results below are incremental versus Core2, not pre-session totals. Its baseline/selected columns refer to that prototype pair.

Node 26.13.0:

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |     344.466 |     239.830 |   +30.38% | +30.36% / +27.49% / +30.38% |
| Large level          |     236.291 |     167.704 |   +29.03% | +30.04% / +27.68% / +29.46% |
| 10,000-row table     |      62.638 |      33.945 |   +45.81% | +45.73% / +45.84% / +45.46% |
| Five Blueprints      |      14.848 |      14.790 |    +0.39% | -8.43% / +0.39% / +10.72%   |
| 138 smaller packages |      53.339 |      47.886 |   +10.22% | +10.99% / +10.57% / +9.07%  |

Node 24.21.0:

| Workload             | Original ms | Selected ms | Less time | Paired blocks               |
| -------------------- | ----------: | ----------: | --------: | --------------------------- |
| All 140 packages     |     358.921 |     261.363 |   +27.18% | +27.19% / +27.50% / +23.99% |
| Large level          |     247.145 |     182.206 |   +26.28% | +30.41% / +26.53% / +25.46% |
| 10,000-row table     |      64.743 |      37.347 |   +42.31% | +42.34% / +42.15% / +42.34% |
| Five Blueprints      |      16.399 |      15.863 |    +3.27% | +14.77% / +9.04% / +0.86%   |
| 138 smaller packages |      50.756 |      49.670 |    +2.14% | +2.14% / +4.12% / +3.51%    |

The uncompressed WASM file is 1,942,619 → 1,976,537 bytes (1.75% larger). Generated JavaScript wrappers are byte-identical. This is file size, not executable code size or a startup/download benchmark. Both builds use the existing `wasm-pack --release --no-opt --locked` settings.

Additional verification: test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 26.36s; strict WASM Clippy status 0. The writer reference exercises 3,380 operation sequences and 13,520 paired writes, including empty buffers, exact limits, rejected writes and subsequent operations. A pre-existing host test expected supported version1016 to be unsupported; the unchanged checkpoint reproduced that failure. The test now uses `i32::MAX` as an unsupported revision, without changing supported-version behavior. The first isolated Clippy attempt lacked the repository test policy; copying the unchanged `clippy.toml` restored the actual project settings. First failing logs are preserved.

Fresh production verification: 719 UAsset Rust tests passed, 8 ignored; Node24/26 versus preserved original-native parity statuses 0/0. Full portable gate status **1**, with its actual failure recorded in the evidence. Fresh UE5.7 and UE5.8 remain individually unavailable; the engine matrix is not a conformance pass. Source hashes match after verification and measurement.

[WASM evidence](evidence/uasset-speed-2026-10-31/source-wasm.json) and [lossless samples, profiles, source, logs and reproduction helpers](evidence/uasset-speed-2026-10-31/source-wasm-raw.json.gz).

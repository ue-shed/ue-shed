# UAsset parser speed: source and layout experiments (2026-11-01)

This is the first verified source checkpoint from the user-authorized ten-hour extension. The investigation continues until **2026-11-01 10:52 UTC (17:52 GMT+7)**. It changes source algorithms and ownership only; allocator and compiler settings remain fixed. No new PGO, BOLT, target-CPU, panic-mode or allocator tuning is included.

“Original” means **before the entire session**, commit `3d7e0ba2e686ba96e9e53973ab75cc34ce138fe5`. The incremental round control is the previously pushed `97d555be8008f60bbc1a373467f9ea5241d22030`, which already includes the overnight and scalar follow-up changes. See the [overnight report](uasset-parser-speed-arm64-2026-10-31.md) and [first follow-up](uasset-parser-speed-followup-2026-10-31.md) for trials 1–31. This report records the later source/design trials and their rejected alternatives.

## Verified source checkpoint

Core 1 retains trial 112: prepare semantic recipes only after an exactly matching header layout is reused, write decoded values into final record slots, handle varying DataTable row widths and a bounded set of omitted/reordered layouts, resolve struct facts once, and borrow temporary container names and initial native ancestry paths. It preserves the public owned model and API. Four parser source files change; most added lines are independent reference tests. Callback APIs and shared-metadata field-type experiments are not retained.

Direct comparison with the pre-session original, ordinary release and mimalloc 0.1.52:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |   106.421 |   61.780 |   +41.95% | +41.95% / +42.94% / +41.96% |
| Large level          |    70.833 |   42.820 |   +39.55% | +39.01% / +40.33% / +40.23% |
| 10,000-row table     |    22.390 |    7.011 |   +68.68% | +68.81% / +67.63% / +68.68% |
| Five Blueprints      |     2.347 |    2.053 |   +12.55% | +12.50% / +12.43% / +12.93% |
| 138 smaller packages |    11.079 |    9.264 |   +16.38% | +16.38% / +16.05% / +16.84% |

Direct comparison with the previously pushed round checkpoint:

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.929 |   61.780 |    +7.69% | +8.60% / +7.41% / +7.92%    |
| Large level          |    45.581 |   43.291 |    +5.02% | +6.48% / +6.04% / +4.58%    |
| 10,000-row table     |     8.943 |    7.007 |   +21.65% | +21.74% / +21.46% / +21.65% |
| Five Blueprints      |     2.046 |    2.053 |    -0.34% | -0.34% / -1.41% / +0.06%    |
| 138 smaller packages |     9.348 |    9.277 |    +0.75% | +1.15% / +0.75% / +0.78%    |

The Blueprint lane is flat to slightly slower against the round control; the result is not a uniform win. The smaller-package improvement is modest. Source gains are measured directly and are never added or multiplied across trials. Workloads overlap and must not be summed. The same candidate has slightly different absolute medians in different comparison windows.

Fresh native CLI processes, warm filesystem, complete file read/decode/JSON/stdout transfer, compared with the preserved original shipping reader:

| Workload         | Before ms | After ms | Less time | Paired blocks               |
| ---------------- | --------: | -------: | --------: | --------------------------- |
| Large level      |   178.711 |  157.111 |   +12.09% | +13.35% / +9.63% / +14.89%  |
| 10,000-row table |    71.371 |   53.893 |   +24.49% | +24.49% / +22.53% / +26.63% |
| One Blueprint    |    14.190 |   13.975 |    +1.52% | +1.52% / -0.67% / +1.68%    |

The single-Blueprint process lane is noisy and does not establish a useful startup improvement. Its input differs from the five-Blueprint library workload. This native comparison covers the complete session’s source change, not an isolated incremental CLI gain over the round checkpoint.

## Why these changes

Traces and a metadata census showed repeated tag/type work and many short nested containers, alongside allocation/drop and schema lookup costs. Core 1 removes repeated semantic dispatch after full header validation. Common 25-byte leaf headers use safe fixed-width word comparisons, including all stable bytes and the current Bool flag. Every other header shape uses the ordinary comparison. No unchecked reads or parser-acceptance limits are added.

DataTable rows need more than a single fixed-width template: strings, arrays and default omissions vary. The retained row matcher allows only the current payload length and Bool value to differ, verifies every other header byte and the terminator, and decodes current values only after the entire stream matches. A miss leaves the caller cursor unchanged and uses the ordinary parser, which owns all diagnostics. Optional learning is bounded to four layouts and stops after repeated misses; it never rejects an input. This wider matcher is not enabled indiscriminately for generic UObjects, where its unsuccessful probes regressed the normal corpus.

Recipes do not bypass current payload guards. Unexpected lengths, bounds, versions, qualified identities, GUIDs, flags or unsupported values return to the established decoder. Filters see raw current records in the same order, including reserved decoder-owned properties. Values and native postprocessing remain fresh for each export. Deferring recipe construction avoids work for templates that never match again. A direct comparison rejected compact tag offsets as an additional change.

## Memory and trace evidence

The counting allocator reports logical requests, not RSS or allocator page usage. The measured operation parses a package, retains all decoded exports, projects text/Blueprint data and drops the results. Request totals cover the corpus; peak is the largest additional live requested size for a package. Initialization/digest pass 1 is excluded; passes 2 and 3 agree. Instrumented timings are excluded from speed claims.

| Metric                  |   Original |     Core 1 | Reduction |
| ----------------------- | ---------: | ---------: | --------: |
| alloc_count             |    864,957 |    628,286 |   +27.36% |
| alloc_bytes             | 99,276,777 | 59,284,532 |   +40.28% |
| peak_live_bytes         | 34,713,040 | 28,943,237 |   +16.62% |
| inspect_peak_live_bytes | 27,347,894 | 26,209,954 |    +4.16% |

Fixed work against the round control executed about 8.3% fewer instructions and 7.6% fewer cycles. Overlapping A55/A78 PMU aliases report identical events on this kernel and are counted once; those aliases are not the machine’s CPU identification. Four 249 Hz DWARF profiles plus the formatted core profile have zero lost samples. Profiled time is not throughput. `memcmp`, ordinary record decoding, metadata allocation/drop, schema lookup and nested tag parsing remain visible targets. The exact cause of the thin shared-node table regression remains unresolved; lower instruction/cache-miss counts did not imply lower elapsed cycles.

## Every measured source trial and comparison

The evidence contains 58 numbered measured trials/comparisons across 73 matrices. Trial 118 is a direct confirmation, not a new source variant. Each row below names its actual baseline binary; later candidate-to-candidate comparisons are not comparisons with commit `97d555be`. Positive percentages mean less time. All measured operations, block medians, samples, source patches, flags, hashes and temperature/frequency observations are preserved in the linked evidence.

### 32: Stable generic-object routing

Cache repeated class dispatch only for providers that promise stable class information. Rejected: small/Blueprint/table regressions outweighed modest level gains.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.803 |   66.297 |    +0.76% | +1.09% / +0.04% / +0.94% |
| Large level          |    45.856 |   45.183 |    +1.47% | +1.17% / +1.47% / +1.82% |
| 10,000-row table     |     9.037 |    9.655 |    -6.84% | -0.26% / -8.14% / -6.84% |
| Five Blueprints      |     2.053 |    2.084 |    -1.50% | -1.35% / -1.70% / -1.50% |
| 138 smaller packages |     9.347 |    9.563 |    -2.32% | -2.10% / -2.90% / -2.32% |

### 33: Fuse replay construction and value decoding

Validate all headers, then construct and decode each record in one walk. Rejected: decoding a temporary record increased copies and slowed tables.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    67.446 |   68.937 |    -2.21% | -0.65% / -2.68% / -2.77%  |
| Large level          |    46.172 |   46.837 |    -1.44% | -2.55% / -0.03% / -0.86%  |
| 10,000-row table     |     9.035 |    9.859 |    -9.12% | -12.75% / -8.80% / -6.48% |
| Five Blueprints      |     2.051 |    2.048 |    +0.16% | -0.08% / +0.14% / +0.40%  |
| 138 smaller packages |     9.332 |    9.289 |    +0.46% | +2.50% / +0.62% / +0.18%  |

### 34: Prepare common scalar decisions

Attach scalar decoding plans to each validated layout, alongside temporary-record fusion. Rejected: planning did not offset the temporary-record cost.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    66.814 |   67.223 |    -0.61% | -0.27% / -0.61% / -2.54%  |
| Large level          |    45.944 |   45.549 |    +0.86% | +0.86% / +0.29% / +0.91%  |
| 10,000-row table     |     8.997 |   10.066 |   -11.88% | -9.79% / -12.41% / -7.32% |
| Five Blueprints      |     2.048 |    2.050 |    -0.08% | +0.32% / -0.27% / -0.09%  |
| 138 smaller packages |     9.338 |    9.340 |    -0.02% | +3.00% / -0.23% / +0.10%  |

### 35: Validate common leaf headers with fixed words

Compare all 24 stable leaf-header bytes and the current bool flag using safe integer loads. Retained as the common leaf-header validator in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    67.148 |   66.629 |    +0.77% | +1.25% / +1.45% / -0.19%   |
| Large level          |    46.562 |   45.792 |    +1.65% | +3.02% / +0.81% / -0.42%   |
| 10,000-row table     |     8.967 |    8.069 |   +10.01% | +10.58% / +9.35% / +11.73% |
| Five Blueprints      |     2.051 |    2.048 |    +0.16% | +0.84% / -0.18% / -0.04%   |
| 138 smaller packages |     9.388 |    9.342 |    +0.49% | +3.50% / +0.56% / -0.48%   |

### 37: Decode in the final vector slot

Push the record before decoding so its value is written in its final location. Retained final-slot decoding as part of core1; not a useful independent winner.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.492 |   66.146 |    +0.52% | +1.87% / +0.13% / +0.52% |
| Large level          |    45.699 |   45.424 |    +0.60% | +1.00% / -0.07% / +0.48% |
| 10,000-row table     |     8.939 |    8.676 |    +2.95% | +2.85% / +4.05% / +2.46% |
| Five Blueprints      |     2.049 |    2.055 |    -0.27% | -0.69% / -0.27% / -0.44% |
| 138 smaller packages |     9.384 |    9.370 |    +0.15% | +3.36% / -0.39% / -1.01% |

### 38: Compact privately owned object paths

Use Box<str> inside the private ObjectPath representation while preserving its public methods. Not retained in core1: compatible private representation, but broader combinations regressed cold/level lanes.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.506 |   65.948 |    +0.84% | +1.52% / +0.78% / +0.56% |
| Large level          |    45.713 |   44.981 |    +1.60% | +1.87% / +0.97% / +2.70% |
| 10,000-row table     |     9.019 |    9.037 |    -0.20% | +0.28% / +0.40% / -1.00% |
| Five Blueprints      |     2.048 |    2.054 |    -0.26% | +0.06% / -0.75% / -0.23% |
| 138 smaller packages |     9.327 |    9.381 |    -0.58% | -0.11% / -0.48% / -1.11% |

### 39: Prepare scalars with separate construction and decoding walks

Keep ordinary two-pass ownership while reusing scalar plans. Not retained alone: weak aggregate benefit.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.399 |   66.916 |    +0.72% | +0.78% / +0.38% / +1.09% |
| Large level          |    45.895 |   45.710 |    +0.40% | +0.25% / +1.66% / -0.74% |
| 10,000-row table     |     8.977 |    9.060 |    -0.93% | -0.18% / -2.33% / +0.28% |
| Five Blueprints      |     2.045 |    2.045 |    -0.01% | -2.42% / +0.01% / +0.84% |
| 138 smaller packages |     9.331 |    9.315 |    +0.17% | +4.90% / -0.54% / +0.37% |

### 41: Cache complete struct-resolution facts

Memoize pure qualified-struct facts within one decode session. Rejected: small-package overhead and hashing/cloning costs.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.591 |   66.093 |    +0.75% | +0.82% / +0.23% / +0.43% |
| Large level          |    45.761 |   45.055 |    +1.54% | +2.43% / +0.67% / +1.54% |
| 10,000-row table     |     9.024 |    9.048 |    -0.26% | -0.27% / +1.34% / -0.94% |
| Five Blueprints      |     2.051 |    2.074 |    -1.12% | -0.99% / -1.26% / -1.12% |
| 138 smaller packages |     9.328 |    9.485 |    -1.69% | -1.69% / -1.55% / -1.71% |

### 42: Store fewer redundant header ranges

Recover expected header bytes from the parent source slice. Rejected: extra lookup/bounds work slowed tables.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.394 |   66.516 |    -0.18% | +0.20% / -0.52% / +0.40% |
| Large level          |    45.863 |   46.112 |    -0.54% | -0.59% / +0.91% / -0.64% |
| 10,000-row table     |     9.038 |    9.346 |    -3.41% | -2.61% / -3.15% / -4.00% |
| Five Blueprints      |     2.048 |    2.040 |    +0.37% | +3.92% / +0.37% / +0.43% |
| 138 smaller packages |     9.349 |    9.327 |    +0.24% | -0.03% / +0.74% / -2.15% |

### 44: Decode UTF-16 directly from bytes

Avoid the intermediate u16 vector; retain old malformed-input diagnostics. Rejected: no broad throughput gain.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.798 |   66.847 |    -0.07% | -0.70% / -0.18% / +0.46% |
| Large level          |    46.344 |   45.735 |    +1.31% | +0.72% / +2.07% / +0.90% |
| 10,000-row table     |     8.964 |    9.016 |    -0.58% | +0.24% / -0.74% / +0.43% |
| Five Blueprints      |     2.045 |    2.058 |    -0.64% | -0.66% / -0.77% / -0.44% |
| 138 smaller packages |     9.322 |    9.339 |    -0.19% | +0.21% / -0.19% / -0.60% |

### 45: Build binary math breadcrumbs lazily

Delay formatting math error paths until an error needs them. Rejected: broader regressions despite a plausible allocation saving.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.833 |   67.876 |    -1.56% | -2.20% / -1.21% / -0.20% |
| Large level          |    46.265 |   45.991 |    +0.59% | +0.59% / -0.36% / +1.24% |
| 10,000-row table     |     9.022 |    9.044 |    -0.24% | -2.19% / -0.22% / +0.14% |
| Five Blueprints      |     2.047 |    2.088 |    -2.03% | -2.34% / -1.32% / -1.89% |
| 138 smaller packages |     9.327 |    9.459 |    -1.41% | -2.60% / -1.41% / -1.12% |

### 46: Read vector/rotator components as one block

Validate a complete math value once, preserving ordinary truncation diagnostics. Rejected: no broad gain in the generic helper.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.907 |   66.829 |    +0.12% | +0.78% / +0.12% / -1.23% |
| Large level          |    45.668 |   46.318 |    -1.43% | -2.59% / -1.43% / -0.44% |
| 10,000-row table     |     9.080 |    9.002 |    +0.85% | -1.69% / +2.26% / +1.61% |
| Five Blueprints      |     2.050 |    2.045 |    +0.28% | +0.13% / +0.08% / +0.28% |
| 138 smaller packages |     9.314 |    9.325 |    -0.12% | -0.15% / +0.31% / -0.16% |

### 49: Use compact struct-fact cache keys

Key pure facts by identity and module names instead of cloning/hashing a complete type tree. Rejected: cold workloads still regressed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.693 |   65.980 |    +1.07% | +1.07% / +0.60% / +1.46% |
| Large level          |    45.935 |   45.689 |    +0.53% | +0.53% / +0.86% / +0.43% |
| 10,000-row table     |     9.039 |    9.181 |    -1.58% | -3.11% / -2.43% / +1.48% |
| Five Blueprints      |     2.044 |    2.112 |    -3.33% | -3.10% / -3.34% / -6.94% |
| 138 smaller packages |     9.351 |    9.599 |    -2.65% | -2.36% / -2.36% / -2.93% |

### 50: Use a small linear struct-fact cache

Replace hashing with a bounded contiguous scan. Not retained: warm level gain with consistent cold-package regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.813 |   65.747 |    +1.59% | +1.13% / +2.35% / +1.32% |
| Large level          |    46.176 |   44.594 |    +3.43% | +2.80% / +4.31% / +3.83% |
| 10,000-row table     |     8.971 |    9.139 |    -1.87% | -1.96% / -0.55% / -2.33% |
| Five Blueprints      |     2.047 |    2.102 |    -2.68% | -2.57% / -2.68% / -2.58% |
| 138 smaller packages |     9.327 |    9.497 |    -1.82% | -1.62% / -2.06% / -1.82% |

### 51: Share immutable type-parameter slices

Reduce repeated metadata cloning using Arc-backed slices. Rejected: cold regressions and a public Rust field-type change.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.891 |   67.197 |    -0.46% | +0.28% / -1.23% / -0.46% |
| Large level          |    45.901 |   46.344 |    -0.97% | -0.67% / -1.15% / -1.61% |
| 10,000-row table     |     9.030 |    8.648 |    +4.23% | +5.87% / +4.05% / +3.16% |
| Five Blueprints      |     2.046 |    2.118 |    -3.55% | -3.91% / -3.33% / -3.55% |
| 138 smaller packages |     9.348 |    9.732 |    -4.11% | -3.36% / -4.04% / -7.10% |

### 52: Use thin shared pointers to parameter vectors

Shrink type nodes further using Arc<Vec<...>>. Rejected: severe table slowdown and a public API change.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.854 |   68.408 |    -2.32% | -2.32% / -1.51% / -4.02%    |
| Large level          |    45.651 |   45.185 |    +1.02% | +3.09% / +1.02% / +0.92%    |
| 10,000-row table     |     9.040 |   10.845 |   -19.97% | -19.87% / -20.04% / -20.12% |
| Five Blueprints      |     2.051 |    2.090 |    -1.92% | -1.84% / -3.44% / -1.77%    |
| 138 smaller packages |     9.359 |    9.619 |    -2.78% | -2.64% / -2.57% / -3.00%    |

### 53: Combine compact paths and header words

Test the combined result rather than adding independent percentages. Not retained: table/corpus gains with level and Blueprint regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    66.986 |   65.638 |    +2.01% | +2.96% / +1.65% / +2.40%   |
| Large level          |    45.748 |   46.206 |    -1.00% | -1.00% / -1.15% / -0.26%   |
| 10,000-row table     |     9.021 |    8.068 |   +10.56% | +9.80% / +10.27% / +10.81% |
| Five Blueprints      |     2.045 |    2.063 |    -0.90% | -0.64% / -0.99% / -0.84%   |
| 138 smaller packages |     9.330 |    9.467 |    -1.46% | +2.62% / -1.52% / -1.69%   |

### 54: Prepare vector/rotator recipes per layout

Resolve math identity once and decode exact-width values from validated layouts. Retained math recipes in the combined core1 implementation;24192 guard/bit cases passed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.586 |   64.954 |    +2.45% | +2.75% / +2.45% / +1.74% |
| Large level          |    46.021 |   44.493 |    +3.32% | +2.93% / +2.28% / +6.54% |
| 10,000-row table     |     8.989 |    8.633 |    +3.97% | +3.97% / +3.76% / +5.45% |
| Five Blueprints      |     2.046 |    2.056 |    -0.52% | -1.85% / -0.67% / -0.36% |
| 138 smaller packages |     9.332 |    9.404 |    -0.77% | -0.77% / -0.81% / -0.86% |

### 55: Allocate single-child shared metadata directly

Avoid an intermediate vector for the overwhelmingly common one-child case. Rejected for production: public API change and cold-workload regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.523 |   65.724 |    +1.20% | +1.86% / +1.20% / -0.36% |
| Large level          |    45.958 |   45.186 |    +1.68% | +2.11% / +2.25% / +0.34% |
| 10,000-row table     |     9.024 |    8.705 |    +3.54% | +2.58% / +3.93% / +8.45% |
| Five Blueprints      |     2.046 |    2.109 |    -3.09% | -1.62% / -2.79% / -4.46% |
| 138 smaller packages |     9.342 |    9.605 |    -2.82% | -2.91% / -2.82% / -2.91% |

### 56: Use a thin shared single-child node

Store one child directly behind an Arc; use a vector for longer lists. Rejected: severe table slowdown, public API change.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.576 |   68.489 |    -2.87% | +1.26% / -3.11% / -5.29%    |
| Large level          |    46.013 |   45.715 |    +0.65% | +0.05% / +2.23% / -0.94%    |
| 10,000-row table     |     9.032 |   10.956 |   -21.30% | -21.52% / -22.50% / -19.73% |
| Five Blueprints      |     2.049 |    2.120 |    -3.47% | -3.47% / -3.57% / -2.14%    |
| 138 smaller packages |     9.331 |    9.614 |    -3.04% | -2.76% / -3.39% / -3.04%    |

### 57: Borrow invariant decode context

Pass a small depth-plus-root-reference value through recursion. Rejected alone: smaller arguments did not reliably improve elapsed time.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.659 |   67.073 |    -0.62% | -0.88% / -0.62% / +0.19% |
| Large level          |    45.751 |   45.959 |    -0.46% | -0.98% / +0.71% / -1.49% |
| 10,000-row table     |     9.034 |    8.979 |    +0.60% | +0.18% / +3.73% / +1.11% |
| Five Blueprints      |     2.048 |    2.064 |    -0.76% | -1.00% / -0.49% / -0.61% |
| 138 smaller packages |     9.339 |    9.377 |    -0.40% | -0.53% / -0.51% / -0.24% |

### 58: Combine compact context and struct facts

Reduce argument size while retaining the bounded fact cache. Not retained: level gains with Blueprint/small regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.575 |   65.230 |    +2.02% | +1.65% / +1.64% / +2.48% |
| Large level          |    45.997 |   44.624 |    +2.99% | +2.92% / +3.28% / +2.80% |
| 10,000-row table     |     9.026 |    9.035 |    -0.10% | +0.75% / -1.53% / -0.10% |
| Five Blueprints      |     2.044 |    2.096 |    -2.54% | -2.60% / -2.27% / -2.63% |
| 138 smaller packages |     9.337 |    9.451 |    -1.22% | -1.22% / -1.28% / -2.69% |

### 59: Carry a GUID predicate in private type specs

Store the only needed nonzero-GUID fact rather than copying Option<Guid>. Not retained alone: no reliable broad gain. Expanded codec oracle passed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.896 |   66.402 |    +0.74% | +0.08% / +1.47% / -1.13% |
| Large level          |    45.589 |   46.215 |    -1.37% | +0.53% / +0.96% / -2.43% |
| 10,000-row table     |     9.019 |    9.055 |    -0.40% | -1.43% / -0.92% / +0.75% |
| Five Blueprints      |     2.049 |    2.058 |    -0.43% | -0.39% / -0.43% / -0.26% |
| 138 smaller packages |     9.331 |    9.349 |    -0.19% | -0.11% / -0.45% / +0.11% |

### 60: Borrow temporary container type names

Avoid owning a String used only during array/set/map decoding. Retained borrowed temporary container names in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.453 |   65.807 |    +0.97% | +0.56% / +0.60% / +1.56% |
| Large level          |    45.588 |   45.303 |    +0.62% | +0.05% / +1.69% / +2.98% |
| 10,000-row table     |     8.962 |    9.010 |    -0.54% | -0.94% / -0.54% / +3.04% |
| Five Blueprints      |     2.045 |    2.034 |    +0.56% | +0.59% / +0.39% / +0.51% |
| 138 smaller packages |     9.333 |    9.392 |    -0.63% | +0.53% / -0.50% / -3.60% |

### 61: Resolve struct identity and module once

Build all pure facts from one name/module resolution instead of repeated helper lookups. Retained single-pass struct facts in core1; frozen helper equivalence cases passed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.730 |   66.432 |    +0.45% | +1.45% / +0.49% / +0.35% |
| Large level          |    46.361 |   44.838 |    +3.28% | +4.62% / +2.40% / +3.57% |
| 10,000-row table     |     9.032 |    9.154 |    -1.35% | -1.08% / -1.35% / -1.80% |
| Five Blueprints      |     2.080 |    2.055 |    +1.19% | +3.35% / -0.57% / +1.53% |
| 138 smaller packages |     9.333 |    9.342 |    -0.10% | -0.10% / +0.06% / -0.06% |

### 62: Combine small scope and small type spec

Test argument-size reductions together. Rejected: consistent corpus and level regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.706 |   67.099 |    -0.59% | -1.12% / -0.59% / -0.49% |
| Large level          |    45.615 |   46.627 |    -2.22% | -2.48% / -2.22% / -1.30% |
| 10,000-row table     |     9.012 |    8.896 |    +1.28% | -0.42% / +1.08% / +1.37% |
| Five Blueprints      |     2.043 |    2.059 |    -0.79% | -0.74% / -0.71% / -1.00% |
| 138 smaller packages |     9.342 |    9.393 |    -0.55% | -0.74% / -1.23% / -0.25% |

### 63: Combine borrowed names and one-pass struct facts

Remove repeated ownership and identity-resolution work together. Retained its two ownership/resolution components in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.693 |   65.499 |    +1.79% | +1.68% / +1.71% / +2.22% |
| Large level          |    45.581 |   44.808 |    +1.69% | +1.64% / +1.35% / +3.56% |
| 10,000-row table     |     9.048 |    8.989 |    +0.66% | +0.76% / -0.90% / +0.52% |
| Five Blueprints      |     2.042 |    2.031 |    +0.54% | +0.62% / +0.71% / +0.54% |
| 138 smaller packages |     9.365 |    9.223 |    +1.51% | +1.53% / +1.39% / +2.11% |

### 64: Use prepared math with separate value walk

Isolate planning from fused final-slot construction. Provisional: consistent level gain, table/cold effects mixed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.587 |   65.185 |    +2.11% | +2.15% / +1.34% / +2.11% |
| Large level          |    45.744 |   44.033 |    +3.74% | +3.78% / +4.61% / +3.64% |
| 10,000-row table     |     9.045 |    9.120 |    -0.83% | +0.42% / -0.83% / -1.75% |
| Five Blueprints      |     2.047 |    2.046 |    +0.01% | -1.36% / -0.06% / +0.43% |
| 138 smaller packages |     9.323 |    9.330 |    -0.08% | +0.01% / -0.11% / -0.37% |

### 65: Add a direct guarded math-record path

Skip reader/path setup for fully available qualified 24-byte vectors and rotators. Not preferred alone: modest benefit compared with prepared-layout decoding.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.840 |   65.813 |    +1.54% | +2.93% / +1.16% / +0.75% |
| Large level          |    45.298 |   45.184 |    +0.25% | +2.33% / +0.25% / +0.72% |
| 10,000-row table     |     9.042 |    9.079 |    -0.40% | -0.56% / +0.24% / +0.83% |
| Five Blueprints      |     2.043 |    2.047 |    -0.19% | +1.82% / +0.05% / -1.47% |
| 138 smaller packages |     9.322 |    9.331 |    -0.09% | -0.85% / -0.02% / +0.01% |

### 66: Remove atomic reference counting from shared slices

Diagnostic Rc variant to explore sharing costs. Rejected for production: changes public types and Send/Sync, cold regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.516 |   65.313 |    +1.81% | +1.81% / +3.41% / +0.99% |
| Large level          |    46.347 |   44.359 |    +4.29% | +3.89% / +3.37% / +5.68% |
| 10,000-row table     |     8.955 |    8.663 |    +3.26% | +3.09% / +3.54% / +1.74% |
| Five Blueprints      |     2.044 |    2.082 |    -1.87% | -2.02% / -1.74% / -1.68% |
| 138 smaller packages |     9.329 |    9.478 |    -1.60% | -2.18% / -1.55% / -1.41% |

### 67: Remove atomics from thin single-child nodes

Diagnostic Rc version of the thin-node representation. Rejected: severe table slowdown persists; breaks public types and Send/Sync.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.643 |   67.952 |    -1.96% | +2.69% / -2.32% / -2.05%    |
| Large level          |    45.537 |   44.626 |    +2.00% | +1.77% / +2.60% / +2.65%    |
| 10,000-row table     |     8.946 |   11.052 |   -23.54% | -22.06% / -30.92% / -23.54% |
| Five Blueprints      |     2.060 |    2.116 |    -2.74% | -2.68% / -3.56% / -0.04%    |
| 138 smaller packages |     9.336 |    9.557 |    -2.36% | -5.49% / -2.36% / -2.24%    |

### 68: Borrow the initial native ancestry path

An ancestry check needs to read the class path, not clone its owned storage. Retained borrowing of the initial native ancestry path in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.678 |   66.245 |    +0.65% | +0.48% / +0.34% / +2.08% |
| Large level          |    46.260 |   45.047 |    +2.62% | +2.62% / +3.30% / +0.92% |
| 10,000-row table     |     8.988 |    8.952 |    +0.41% | -0.31% / +1.64% / +0.08% |
| Five Blueprints      |     2.050 |    2.042 |    +0.43% | +0.60% / +0.76% / +0.28% |
| 138 smaller packages |     9.345 |    9.303 |    +0.45% | -0.02% / +0.45% / +0.49% |

### 69: Borrow generated-class parent paths too

Read parent object paths from package tables during ancestry traversal. Not retained alone: table regression despite corpus/level gains.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.961 |   66.234 |    +1.08% | +1.08% / +1.13% / +1.08% |
| Large level          |    46.173 |   45.406 |    +1.66% | +0.44% / +0.83% / +2.15% |
| 10,000-row table     |     9.071 |    9.347 |    -3.03% | -3.90% / -3.03% / -3.86% |
| Five Blueprints      |     2.042 |    2.041 |    +0.07% | +0.27% / +0.07% / +0.26% |
| 138 smaller packages |     9.357 |    9.361 |    -0.04% | -4.45% / +0.27% / -0.04% |

### 70: Borrow reference-validation inputs

Avoid allocating display strings solely to check reference validity. Awaiting final selection based on measured effects.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.621 |   66.793 |    -0.26% | +0.06% / -1.84% / +0.67% |
| Large level          |    45.950 |   45.637 |    +0.68% | +0.30% / +0.14% / +2.06% |
| 10,000-row table     |     8.908 |    9.034 |    -1.41% | -2.25% / -1.50% / +1.05% |
| Five Blueprints      |     2.049 |    2.043 |    +0.28% | +0.18% / +0.69% / +0.13% |
| 138 smaller packages |     9.328 |    9.335 |    -0.08% | -0.09% / +0.23% / -0.08% |

### 71: Borrow read-only name comparisons broadly

Use Cow resolution in private comparisons and validation sites. Not retained alone: weak aggregate gain and small-package regression.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.810 |   66.348 |    +0.69% | +0.69% / +0.77% / +0.33% |
| Large level          |    46.073 |   45.870 |    +0.44% | -0.27% / -0.38% / +0.82% |
| 10,000-row table     |     8.990 |    9.012 |    -0.24% | -0.92% / -0.47% / +0.62% |
| Five Blueprints      |     2.050 |    2.050 |    +0.01% | -0.42% / +3.83% / -0.19% |
| 138 smaller packages |     9.311 |    9.440 |    -1.39% | -1.39% / -0.35% / -1.54% |

### 72: Prepare name, enum, string and math leaves

Reuse validated type interpretation; ordinary decoding owns every unsuccessful probe diagnostic. Retained prepared Name/Enum/String/math leaves and final-slot writes in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks             |
| -------------------- | --------: | -------: | --------: | ------------------------- |
| All 140 packages     |    66.638 |   63.834 |    +4.21% | +4.41% / +3.64% / +4.22%  |
| Large level          |    46.364 |   44.593 |    +3.82% | +3.82% / +4.12% / +2.89%  |
| 10,000-row table     |     8.970 |    8.084 |    +9.87% | +10.94% / +9.55% / +9.33% |
| Five Blueprints      |     2.049 |    2.068 |    -0.94% | -0.48% / -0.80% / -1.15%  |
| 138 smaller packages |     9.327 |    9.403 |    -0.81% | -0.83% / -0.96% / +2.14%  |

### 73: Use all leaf plans with a separate value walk

Check whether separate construction and decoding is preferable with more leaf kinds. Not preferred: less gain than final-slot fusion.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.699 |   65.458 |    +1.86% | -2.12% / +3.31% / +1.86% |
| Large level          |    45.885 |   44.279 |    +3.50% | +4.17% / +3.18% / +3.14% |
| 10,000-row table     |     8.946 |    8.511 |    +4.85% | +4.88% / +6.76% / +4.82% |
| Five Blueprints      |     2.049 |    2.048 |    +0.04% | -0.36% / -7.48% / +0.04% |
| 138 smaller packages |     9.343 |    9.381 |    -0.41% | -0.54% / -0.71% / -0.35% |

### 74: Normalize private type dispatch to an enum

Replace repeated private string comparisons with compact type kinds. Rejected: normalization work did not pay off on this configuration.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.629 |   66.714 |    -0.13% | -0.24% / -0.06% / -0.09% |
| Large level          |    45.690 |   46.403 |    -1.56% | -3.33% / -0.76% / -1.56% |
| 10,000-row table     |     9.040 |    9.064 |    -0.26% | +1.71% / -0.60% / -0.30% |
| Five Blueprints      |     2.052 |    2.087 |    -1.69% | -2.08% / -4.72% / -1.02% |
| 138 smaller packages |     9.340 |    9.376 |    -0.38% | -0.44% / -0.14% / -0.59% |

### 75: Combine enum dispatch and borrowed context

Test both compact representations together. Rejected: no reliable broad gain.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.432 |   66.797 |    -0.55% | -0.55% / +0.44% / -0.92% |
| Large level          |    45.642 |   45.798 |    -0.34% | -0.34% / -1.71% / +3.59% |
| 10,000-row table     |     9.055 |    8.981 |    +0.81% | +0.85% / +0.05% / +0.24% |
| Five Blueprints      |     2.050 |    2.050 |    -0.02% | -0.10% / -0.29% / -0.02% |
| 138 smaller packages |     9.318 |    9.266 |    +0.56% | +0.74% / +0.58% / -1.17% |

### 84: Recycle metadata after a streaming callback

Add a visitor that retains reusable metadata while values remain freshly decoded. Provisional/rejected first design: old owned callers and cold packages regressed.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.760 |   68.021 |    -1.89% | -1.83% / -3.00% / -1.46% |
| Large level          |    45.512 |   46.884 |    -3.01% | -1.51% / -4.40% / -2.08% |
| 10,000-row table     |     9.031 |    9.174 |    -1.59% | -2.19% / -1.62% / -0.39% |
| Five Blueprints      |     2.050 |    2.086 |    -1.75% | +4.87% / -1.69% / -2.07% |
| 138 smaller packages |     9.308 |    9.486 |    -1.91% | -6.16% / -0.33% / -1.53% |

**visitor**, baseline `visitor-control/visitor-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.173 |   66.240 |    +1.39% | +1.85% / -3.45% / +1.35% |
| Large level          |    46.319 |   45.004 |    +2.84% | +1.87% / +3.47% / +2.84% |
| 10,000-row table     |     9.084 |    9.084 |    -0.01% | -0.22% / +0.18% / -0.12% |
| Five Blueprints      |     2.083 |    2.130 |    -2.27% | -2.05% / -1.87% / -2.64% |
| 138 smaller packages |     9.373 |    9.795 |    -4.50% | -4.62% / -4.19% / -4.42% |

### 85: Use recycled callbacks in streaming JSON

Connect the first visitor design to the existing streaming inspection API. Provisional: JSON gains with ownership-path tradeoffs.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.894 |   68.452 |    -2.33% | -1.97% / -2.16% / -2.69% |
| Large level          |    45.589 |   47.634 |    -4.49% | -4.70% / -4.87% / -4.06% |
| 10,000-row table     |     9.075 |    9.230 |    -1.70% | -3.29% / -1.40% / -1.55% |
| Five Blueprints      |     2.070 |    2.106 |    -1.75% | -7.60% / -1.42% / -2.71% |
| 138 smaller packages |     9.313 |    9.616 |    -3.25% | -2.84% / -3.17% / -3.27% |

**visitor**, baseline `visitor-control/visitor-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.177 |   64.332 |    +4.24% | +3.83% / +4.66% / +4.13% |
| Large level          |    45.803 |   43.521 |    +4.98% | +5.14% / +4.80% / +4.90% |
| 10,000-row table     |     9.192 |    8.973 |    +2.38% | -0.40% / +2.94% / +3.65% |
| Five Blueprints      |     2.081 |    2.082 |    -0.08% | -0.21% / -0.01% / -0.08% |
| 138 smaller packages |     9.376 |    9.483 |    -1.13% | -1.10% / -1.73% / -1.40% |

### 86: Replay rows with changing payload widths

Check all stable header fields while reading each current payload size. Retained the DataTable variable-width technique in the combined core1 implementation.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.495 |   66.159 |    +0.50% | +0.50% / +1.46% / -0.07% |
| Large level          |    45.845 |   45.292 |    +1.21% | +1.90% / +2.48% / +0.73% |
| 10,000-row table     |     8.960 |    8.973 |    -0.14% | -0.14% / -0.40% / -0.15% |
| Five Blueprints      |     2.048 |    2.045 |    +0.13% | +0.13% / -0.30% / +0.37% |
| 138 smaller packages |     9.337 |    9.341 |    -0.05% | +0.14% / -0.01% / -0.05% |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.186 |    9.098 |   +49.97% | +49.74% / +50.60% / +49.97% |
| stress-width-rotating    |    18.141 |    8.924 |   +50.81% | +51.05% / +52.81% / +50.63% |
| stress-width-shuffled    |    16.641 |    8.921 |   +46.39% | +46.37% / +47.88% / +46.27% |

### 87: Use variable-width replay for object streams too

Generalize variable payload validation beyond table rows. Rejected alone: normal corpus and level regressions.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.807 |   68.511 |    -2.55% | -2.90% / -2.17% / -2.89% |
| Large level          |    45.901 |   47.113 |    -2.64% | -3.46% / -3.25% / -2.64% |
| 10,000-row table     |     8.990 |    8.980 |    +0.11% | -0.27% / +1.54% / -0.37% |
| Five Blueprints      |     2.045 |    2.074 |    -1.43% | -1.00% / -1.76% / -0.77% |
| 138 smaller packages |     9.330 |    9.441 |    -1.20% | -0.93% / -1.23% / -1.08% |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.129 |    8.994 |   +50.39% | +50.57% / +50.57% / +49.82% |
| stress-width-rotating    |    18.154 |    8.962 |   +50.64% | +50.79% / +50.22% / +51.00% |
| stress-width-shuffled    |    16.578 |    8.917 |   +46.21% | +46.18% / +46.07% / +47.17% |

### 88: Keep several recent table layouts

Use four MRU layouts and disable unsuccessful learning after repeated misses. Retained bounded adaptive row-layout learning in core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.524 |   66.771 |    -0.37% | +0.16% / -0.37% / -0.35% |
| Large level          |    46.031 |   46.058 |    -0.06% | +1.17% / -1.78% / -0.06% |
| 10,000-row table     |     8.959 |    8.714 |    +2.73% | -0.89% / +3.64% / +3.87% |
| Five Blueprints      |     2.043 |    2.056 |    -0.64% | -0.50% / +2.97% / -0.64% |
| 138 smaller packages |     9.322 |    9.373 |    -0.54% | -3.05% / -0.16% / -0.69% |

**stress**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    18.269 |    9.186 |   +49.72% | +50.75% / +49.68% / +48.97% |
| stress-rotating-eight    |    18.015 |   14.254 |   +20.88% | +20.47% / +23.53% / +20.88% |
| stress-randomized        |    18.309 |   14.710 |   +19.66% | +19.66% / +20.51% / +19.34% |
| stress-mostly-uniform    |    10.468 |    8.703 |   +16.86% | +16.31% / +16.27% / +17.26% |
| stress-width-alternating |    18.239 |    9.020 |   +50.55% | +49.30% / +50.84% / +50.23% |
| stress-width-rotating    |    18.150 |    9.387 |   +48.28% | +48.37% / +48.57% / +47.68% |
| stress-width-shuffled    |    16.542 |   11.494 |   +30.52% | +30.73% / +28.81% / +30.28% |

### 89: Combine adaptive layouts and variable widths

Cover both changing property order/default omission and changing payload sizes. Provisional: strong synthetic gains, validate final combined source.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.583 |   66.517 |    +0.10% | -0.83% / +0.26% / +0.10% |
| Large level          |    45.880 |   46.271 |    -0.85% | -1.82% / +2.69% / -0.85% |
| 10,000-row table     |     8.953 |    8.667 |    +3.20% | +3.20% / +3.16% / +3.36% |
| Five Blueprints      |     2.048 |    2.056 |    -0.42% | -0.44% / -0.43% / -0.42% |
| 138 smaller packages |     9.326 |    9.364 |    -0.41% | -0.41% / -0.36% / -0.42% |

**stress**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-alternating       |    18.243 |   10.987 |   +39.77% | +39.92% / +40.24% / +36.30% |
| stress-rotating-eight    |    18.323 |   14.034 |   +23.41% | +23.69% / +21.05% / +24.21% |
| stress-randomized        |    18.299 |   14.513 |   +20.69% | +20.63% / +19.97% / +21.34% |
| stress-mostly-uniform    |    10.352 |    9.154 |   +11.56% | +11.31% / +10.96% / +11.95% |
| stress-width-alternating |    18.172 |    8.887 |   +51.09% | +50.89% / +51.09% / +51.19% |
| stress-width-rotating    |    18.177 |    8.912 |   +50.97% | +50.97% / +50.87% / +50.83% |
| stress-width-shuffled    |    16.520 |    8.934 |   +45.92% | +46.04% / +46.01% / +44.95% |

### 90: Separate visitor storage and stable generic routing

Keep the original owned cache layout and decode body while adding an opt-in streaming cache. Experimental only, not retained: old owned API cost, plus missing ordinary native postprocessing hooks identified after measurement. Current456case parity does not establish general equivalence.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.760 |   68.073 |    -1.97% | -1.63% / -1.97% / -2.55% |
| Large level          |    45.556 |   46.639 |    -2.38% | -3.13% / -0.61% / -2.26% |
| 10,000-row table     |     9.026 |    9.109 |    -0.92% | -1.36% / -2.11% / -0.92% |
| Five Blueprints      |     2.048 |    2.099 |    -2.47% | -2.77% / -2.32% / -2.47% |
| 138 smaller packages |     9.332 |    9.502 |    -1.83% | -2.00% / -7.04% / -1.54% |

**visitor**, baseline `visitor-control/visitor-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.300 |   62.579 |    +7.01% | +6.46% / +7.60% / +7.01% |
| Large level          |    46.151 |   41.961 |    +9.08% | +9.09% / +9.54% / +8.50% |
| 10,000-row table     |     9.110 |    9.006 |    +1.14% | +1.47% / -0.03% / +1.17% |
| Five Blueprints      |     2.083 |    2.087 |    -0.20% | -0.05% / -0.53% / +0.90% |
| 138 smaller packages |     9.394 |    9.575 |    -1.92% | -2.32% / -2.21% / -0.77% |

### 91: Use the separate visitor in streaming JSON

Measure the consumer-facing result of the second visitor design. Experimental only, not retained: same incomplete generic-object prototype plus JSON integration; later102/103 restore the missing hooks.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.782 |   69.140 |    -3.53% | -6.10% / -3.21% / -3.53%    |
| Large level          |    45.821 |   47.738 |    -4.18% | -4.35% / -4.30% / -2.34%    |
| 10,000-row table     |     8.953 |    9.079 |    -1.41% | -1.51% / -1.76% / -0.75%    |
| Five Blueprints      |     2.046 |    2.292 |   -12.05% | -12.01% / -10.18% / -15.28% |
| 138 smaller packages |     9.344 |   10.029 |    -7.32% | -7.17% / -7.56% / -7.28%    |

**visitor**, baseline `visitor-control/visitor-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks              |
| -------------------- | --------: | -------: | --------: | -------------------------- |
| All 140 packages     |    67.219 |   61.935 |    +7.86% | +7.51% / +11.92% / +7.58%  |
| Large level          |    46.440 |   41.129 |   +11.44% | +6.97% / +11.92% / +11.44% |
| 10,000-row table     |     9.170 |    9.130 |    +0.44% | +0.48% / +0.54% / -0.16%   |
| Five Blueprints      |     2.078 |    2.111 |    -1.58% | -8.23% / -1.20% / -1.70%   |
| 138 smaller packages |     9.367 |    9.586 |    -2.34% | -2.58% / -2.22% / -2.22%   |

### 92: Validate variable object/row layouts before allocation

Perform a complete metadata-free validation pass before constructing records. Rejected: two-pass validation still regressed ordinary corpus, level and table.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.043 |   68.230 |    -1.77% | -1.39% / -1.77% / -2.20% |
| Large level          |    46.183 |   46.987 |    -1.74% | -2.00% / -1.63% / -1.53% |
| 10,000-row table     |     8.980 |    9.257 |    -3.08% | -1.70% / -3.08% / -3.82% |
| Five Blueprints      |     2.045 |    2.056 |    -0.51% | -0.87% / -0.51% / -0.48% |
| 138 smaller packages |     9.328 |    9.395 |    -0.72% | -2.54% / -0.88% / -0.68% |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.247 |    9.305 |   +49.01% | +49.58% / +49.01% / +48.08% |
| stress-width-rotating    |    18.178 |    9.344 |   +48.60% | +48.47% / +48.55% / +49.00% |
| stress-width-shuffled    |    16.540 |    9.372 |   +43.34% | +43.34% / +42.72% / +43.55% |

### 93: Use two-pass variable validation only for rows

Keep the generic object path unchanged. Not preferred: width stress wins but slower ordinary table than the one-pass version.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    67.021 |   66.699 |    +0.48% | +0.62% / +0.61% / +0.12% |
| Large level          |    46.230 |   45.898 |    +0.72% | -0.16% / +1.01% / +1.42% |
| 10,000-row table     |     9.021 |    9.211 |    -2.10% | -0.06% / -2.10% / -4.52% |
| Five Blueprints      |     2.046 |    2.035 |    +0.57% | +0.57% / +0.56% / +0.81% |
| 138 smaller packages |     9.335 |    9.264 |    +0.76% | +0.00% / +0.47% / +0.91% |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.236 |    9.406 |   +48.42% | +48.84% / +48.04% / +48.42% |
| stress-width-rotating    |    18.195 |    9.433 |   +48.16% | +49.27% / +47.92% / +46.01% |
| stress-width-shuffled    |    16.548 |    9.267 |   +44.00% | +43.14% / +43.92% / +44.07% |

### 94: Bulk decode vector/rotator arrays

Prove the complete fixed-width array bytes exist, then decode without per-element paths and dispatch. Rejected: no ordinary corpus/level gain; no production adoption.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.622 |   67.019 |    -0.60% | -0.90% / -0.99% / +0.36% |
| Large level          |    46.137 |   46.233 |    -0.21% | -0.21% / +0.01% / -0.08% |
| 10,000-row table     |     8.950 |    8.920 |    +0.34% | +1.09% / -0.01% / +0.44% |
| Five Blueprints      |     2.048 |    2.051 |    -0.14% | -0.28% / -0.03% / -0.14% |
| 138 smaller packages |     9.340 |    9.352 |    -0.13% | -1.94% / +0.06% / -0.27% |

### 95: Bulk decode additional core struct arrays

Extend the safe complete-block kernel to IntPoint, Color and LinearColor. Rejected: ordinary corpus/level regressions; no production adoption.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    66.648 |   67.145 |    -0.75% | -0.18% / -0.61% / -1.33% |
| Large level          |    45.362 |   45.825 |    -1.02% | -3.10% / -1.02% / -0.18% |
| 10,000-row table     |     9.009 |    9.071 |    -0.68% | -0.68% / +1.97% / -1.45% |
| Five Blueprints      |     2.046 |    2.063 |    -0.83% | +0.00% / -6.57% / -1.01% |
| 138 smaller packages |     9.347 |    9.336 |    +0.12% | +2.51% / +0.23% / +0.12% |

### 96: Combine source candidates

Borrowed names, one-pass facts, prepared leaves, header words and borrowed ancestry paths. Not preferred: strong table gains with cold-package regressions; generalized97 selected.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.614 |   62.126 |    +6.74% | +6.59% / +8.01% / +6.68%    |
| Large level          |    46.326 |   43.435 |    +6.24% | +6.24% / +4.36% / +6.06%    |
| 10,000-row table     |     9.030 |    7.004 |   +22.44% | +22.10% / +22.17% / +23.15% |
| Five Blueprints      |     2.041 |    2.084 |    -2.09% | -1.83% / -2.11% / -2.09%    |
| 138 smaller packages |     9.328 |    9.388 |    -0.64% | -0.39% / -0.78% / -0.74%    |

### 97: Combine source candidates with adaptive variable rows

Integrate variable payloads and several row layouts with prepared leaf callbacks. Retained generalized row replay and other components through lazy-plan version112/core1.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    66.759 |   62.520 |    +6.35% | +6.36% / +6.62% / +5.85%    |
| Large level          |    45.956 |   43.289 |    +5.80% | +5.80% / +5.80% / +4.78%    |
| 10,000-row table     |     8.939 |    7.366 |   +17.59% | +18.89% / +11.72% / +18.49% |
| Five Blueprints      |     2.054 |    2.055 |    -0.03% | -0.04% / +0.16% / +0.28%    |
| 138 smaller packages |     9.329 |    9.335 |    -0.07% | -0.38% / +0.08% / -0.07%    |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.127 |    7.938 |   +56.21% | +58.12% / +54.96% / +56.21% |
| stress-width-rotating    |    18.204 |    7.901 |   +56.60% | +56.80% / +57.25% / +55.61% |
| stress-width-shuffled    |    16.570 |    7.891 |   +52.38% | +53.14% / +52.31% / +52.15% |

### 98: Combine source candidates with two-pass variable rows

Use one row layout and allocation-free validation on misses. Not retained: cold regressions and narrower/worse variable-width behavior than97.

**owned**, baseline `control/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks               |
| -------------------- | --------: | -------: | --------: | --------------------------- |
| All 140 packages     |    67.016 |   62.525 |    +6.70% | +7.07% / +6.52% / +7.09%    |
| Large level          |    46.260 |   43.500 |    +5.97% | +6.82% / +5.97% / +4.94%    |
| 10,000-row table     |     8.955 |    7.180 |   +19.82% | +20.41% / +20.61% / +19.41% |
| Five Blueprints      |     2.049 |    2.074 |    -1.22% | -1.25% / -4.14% / -0.82%    |
| 138 smaller packages |     9.337 |    9.473 |    -1.46% | -1.40% / -1.54% / -1.44%    |

**width**, baseline `control/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks               |
| ------------------------ | --------: | -------: | --------: | --------------------------- |
| stress-width-alternating |    18.188 |    7.956 |   +56.26% | +55.98% / +56.16% / +56.54% |
| stress-width-rotating    |    18.148 |    8.548 |   +52.90% | +52.28% / +53.26% / +52.90% |
| stress-width-shuffled    |    16.560 |    8.575 |   +48.22% | +47.80% / +48.22% / +48.76% |

### 112: Prepare semantic plans only on reuse

Avoid preparing recipes for captured layouts that never match again; reference is trial97. Selected as formatted core1.714UAssetRust tests,8ignored;Clippy/Windows/Node24+26originalWASM/207084wire pass. Full portable check still ENOTDIR optionalWindows package;freshUE5.7/5.8 unavailable.

**owned**, baseline `97-combined-source-candidate/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.316 |   61.323 |    +1.59% | +1.37% / +0.80% / +1.59% |
| Large level          |    43.757 |   42.940 |    +1.87% | +2.09% / +1.17% / +2.33% |
| 10,000-row table     |     7.272 |    7.018 |    +3.50% | +1.01% / +4.16% / +5.77% |
| Five Blueprints      |     2.053 |    2.052 |    +0.05% | +0.25% / +0.05% / -0.12% |
| 138 smaller packages |     9.360 |    9.303 |    +0.61% | +0.61% / -0.66% / +0.93% |

**width**, baseline `97-combined-source-candidate/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.617 |    7.532 |    +1.11% | +4.10% / +0.59% / +1.50% |
| stress-width-rotating    |     7.972 |    7.758 |    +2.68% | +1.13% / +4.03% / +1.75% |
| stress-width-shuffled    |     8.013 |    7.961 |    +0.65% | -0.90% / +1.32% / +3.03% |

### 113: Keep cached tags compact

Use checked u16 offsets within the existing16KiB optional header budget; reference is trial97. Not retained: no consistent broad gain; cold Blueprint regression.

**owned**, baseline `97-combined-source-candidate/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.579 |   62.366 |    +0.34% | +0.57% / -0.19% / -0.11% |
| Large level          |    43.512 |   43.344 |    +0.39% | +1.14% / +1.29% / -1.32% |
| 10,000-row table     |     7.141 |    7.073 |    +0.95% | +0.95% / +3.05% / -1.03% |
| Five Blueprints      |     2.053 |    2.075 |    -1.07% | -0.53% / -1.07% / -3.31% |
| 138 smaller packages |     9.369 |    9.364 |    +0.05% | -0.22% / +0.19% / +0.04% |

**width**, baseline `97-combined-source-candidate/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.768 |    7.562 |    +2.65% | +2.75% / -1.78% / +3.29% |
| stress-width-rotating    |     8.037 |    7.867 |    +2.11% | +1.04% / +2.35% / +0.12% |
| stress-width-shuffled    |     7.915 |    7.981 |    -0.84% | +0.77% / -1.15% / -0.84% |

### 114: Combine lazy preparation and compact tags

Test both changes together against trial97. Not retained: direct118comparison with112 failed to improve corpus/table; keep simpler112.

**owned**, baseline `97-combined-source-candidate/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    62.301 |   61.887 |    +0.66% | +0.66% / +1.57% / +1.44% |
| Large level          |    43.545 |   42.861 |    +1.57% | +1.57% / -0.38% / +0.90% |
| 10,000-row table     |     7.265 |    7.070 |    +2.68% | +2.77% / +2.74% / +2.25% |
| Five Blueprints      |     2.058 |    2.037 |    +1.04% | +0.20% / +1.89% / +1.04% |
| 138 smaller packages |     9.339 |    9.286 |    +0.58% | +0.58% / +1.00% / +0.40% |

**width**, baseline `97-combined-source-candidate/parser-speed`.

| Workload                 | Before ms | After ms | Less time | Paired blocks            |
| ------------------------ | --------: | -------: | --------: | ------------------------ |
| stress-width-alternating |     7.750 |    7.466 |    +3.66% | +4.34% / +2.72% / +3.01% |
| stress-width-rotating    |     8.046 |    7.751 |    +3.66% | +3.54% / +1.32% / +3.66% |
| stress-width-shuffled    |     8.036 |    7.827 |    +2.60% | -0.13% / +2.73% / +2.96% |

### 118: Direct compact-tag confirmation

Compare114directly with112 before selection; no new source variant. Reject compact addition;112 selected.

**owned**, baseline `112-general-row-plans-on-reuse/parser-speed`.

| Workload             | Before ms | After ms | Less time | Paired blocks            |
| -------------------- | --------: | -------: | --------: | ------------------------ |
| All 140 packages     |    61.275 |   61.759 |    -0.79% | -1.45% / -1.27% / +0.24% |
| Large level          |    42.929 |   42.906 |    +0.05% | +0.18% / -1.17% / -0.82% |
| 10,000-row table     |     6.986 |    7.012 |    -0.37% | -1.01% / -0.36% / -0.03% |
| Five Blueprints      |     2.051 |    2.043 |    +0.40% | +1.17% / -1.52% / +0.84% |
| 138 smaller packages |     9.295 |    9.299 |    -0.04% | -0.02% / -0.04% / +0.12% |

Visitor results use a callback-scoped borrowed result and a distinct compatibility-adapter control. They must not be merged with owned-result percentages. Early visitor prototypes also omitted ordinary native postprocessing hooks outside the covered repeated cases; their recorded parity does not prove general equivalence. They are experimental and unretained. Later hardened prototypes remain unmeasured at this checkpoint.

Stress rows are derived parser inputs, not fresh Unreal saves: four property-order variants and three balanced string-width variants, plus 42 late malformed variants. Input recipes and initial-parser outputs are preserved. Wider row matching improves those synthetic workloads substantially, but their percentages are not normal-fixture gains.

## Correctness, reproducibility and limits

- Core 1 matches the initial parser on all 140 fixtures, 267 original malformed inputs and 49 derived stress cases, including rich model and both inspection outputs. Candidate/reference oracle-file hashes are audited, not just success messages.
- Expanded wire probe: 207,084 deterministic synthetic codec/envelope cases exactly match the original. These are codec cases, not UAsset files.
- Direct reference tests include 295,680 prepared-leaf cases, 24,192 math guard/bit cases, struct identity/module resolution, stateful filters and variable-width mutations/truncations.
- UAsset Rust checks: 714 passed, 8 ignored; parser Clippy, Windows layout, browser/packed WASM, native/WASM and saved-review checks pass. Node 24.21 and 26.13 WASM comparisons against the preserved original native reader pass.
- **The full portable gate is not green**: public-package consumer installation fails with pnpm `ENOTDIR` for optional `@ue-shed/engine-win32-x64/package.json`, as it did at the round checkpoint. This attempt stops before broad UI tests; it does not repair or verify them.
- Fresh **UE 5.7 unavailable** and **UE 5.8 unavailable**, independently discovered. The engine matrix exits 1 on missing 5.7; no fresh Unreal conformance is claimed.
- A control-rebuild attempt reused the previous binary because `git archive` restored old mtimes. It was stopped and excluded, with all partial evidence retained. The harness now touches restored source before compilation. All earlier measured trial logs show real parser recompilation; a forced rebuilt control is byte-identical to the original round control, and its archived sources match the checkpoint.
- Production source hashes match before and after verification and timing. Existing original executables and prior evidence remain preserved. Compiler/allocator settings, machine, timing boundaries and overlapping workload definitions follow the overnight report.

Readable data: [source-design.json](evidence/uasset-speed-2026-10-31/source-design.json), [source-core-1.json](evidence/uasset-speed-2026-10-31/source-core-1.json). Lossless samples, thermal observations, rejected patches and preparation scripts: [source-design-raw.json.gz](evidence/uasset-speed-2026-10-31/source-design-raw.json.gz). Core measurements: [source-core-1-raw.json.gz](evidence/uasset-speed-2026-10-31/source-core-1-raw.json.gz). Decompress with `gzip -dc FILE`; each JSON index records its compressed SHA-256. Local binaries, raw profiles, logs and pending experiments remain under `out/uasset-speed-2026-10-31/architecture/`.

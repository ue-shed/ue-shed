# Map Capture performance experiment — 2026-08-13

## Purpose

Measure and improve the real editor Map Capture pipeline one bounded change at a time. This record
uses a representative local editor map without making its project identity or content part of the
product contract.

## Method

- Unreal Engine 5.7 editor remains open on the same map between measured runs.
- One warm-up capture precedes each measured revision.
- Each revision captures the same 6×6 grid: 36 PNG tiles, 1024 pixels per tile, one level,
  4 world units per pixel, two gutter pixels, full-fidelity rendering, natural LOD, fog disabled.
- Three runs are sampled at 100 ms intervals. The comparison uses the median manifest duration.
- `manifest` time covers capture, host validation, hashing, and atomic publication. `wall` time also
  includes CLI process startup and output serialization.
- CPU percentages are normalized to total logical machine capacity. GPU percentage is the busiest
  process-local Windows GPU engine at each sample. Memory is process-local Unreal usage.
- Raw reports and command output live under ignored `out/benchmarks/map-capture/`.

## Results

| Iteration | Change                                       | Manifest median | Wall median | CPU avg / peak |  GPU avg / peak | Peak working set | Peak private | Peak GPU local |
| --------- | -------------------------------------------- | --------------: | ----------: | -------------: | --------------: | ---------------: | -----------: | -------------: |
| 0         | Existing serial implementation               |         2.138 s |     3.458 s | 2.14% / 10.80% |  7.79% / 27.12% |         8.57 GiB |    13.07 GiB |       4.69 GiB |
| 1         | Reuse capture actor and render target        |         2.091 s |     3.457 s | 2.32% / 13.95% |  6.25% / 20.95% |         8.88 GiB |    12.73 GiB |       3.83 GiB |
| 2         | Lossless PNG zlib level 1                    |         1.549 s |     2.949 s | 2.02% / 14.79% |  7.71% / 21.57% |         8.93 GiB |    12.76 GiB |       3.83 GiB |
| 3         | Four-item bounded encode/write pipeline      |         0.736 s |     2.131 s | 2.65% / 15.68% | 10.36% / 48.13% |         8.95 GiB |    12.79 GiB |       3.80 GiB |
| 4         | Eight-item encode queue — rejected           |         0.801 s |     2.223 s | 2.17% / 15.56% | 10.03% / 48.17% |         8.91 GiB |    12.76 GiB |       3.83 GiB |
| 5         | Four-target render/readback pool             |         0.705 s |     2.041 s | 2.16% / 14.70% |  9.66% / 48.59% |         8.70 GiB |    12.44 GiB |       3.88 GiB |
| 6         | Two-target render/readback pool — rejected   |         0.809 s |     2.092 s | 2.64% / 22.00% | 10.03% / 49.92% |         8.82 GiB |    12.99 GiB |       4.33 GiB |
| 7         | Eight-target render/readback pool — rejected |         0.729 s |     2.100 s | 2.38% / 14.79% |  8.86% / 48.63% |         8.81 GiB |    13.04 GiB |       4.39 GiB |

## Iteration notes

### 0 — Existing serial implementation

The editor creates and destroys one transient capture actor and render target per tile. Each tile
then performs a synchronous render-target readback, PNG encode, and file write before the next tile
begins. The low average CPU and GPU utilization suggests serialized latency rather than sustained
compute saturation. The 36 PNGs average 15.76 MiB of published output per run.

### 1 — Reuse capture actor and render target

The request now creates the transient actor and 1028×1028 render target lazily once, moves it for
each tile, and destroys it after the batch. Median manifest duration improved by 47 ms (2.2%). Wall
time was effectively unchanged because CLI startup dominates the additional host-only interval.
The change is retained because it removes unnecessary actor, UObject, and render-resource churn,
but the result demonstrates that synchronous readback and encoding remain the larger target.

### 2 — Lossless PNG zlib level 1

The PNG encoder now uses zlib level 1 instead of Unreal's default level 3. Pixels remain lossless.
Median manifest duration improved by 542 ms relative to iteration 1 (25.9%) and by 27.6% relative
to baseline. Average published output grew by 13.1%. This is retained as an appropriate trade for
interactive editor tooling whose immutable files remain ordinarily sized.

### 3 — Four-item bounded encode/write pipeline

Render-target readback stays on the editor thread, but each completed raw tile is handed to the
global worker pool for PNG compression and its distinct file write. At most four raw images and
encode futures remain in flight; completion is folded back into deterministic request order before
the response is returned. Median manifest duration improved by 813 ms relative to iteration 2
(52.5%) and by 65.6% relative to baseline. End-to-end CLI wall time improved by 38.4%. The measured
working set increased by only 20 MiB over iteration 2, consistent with the bounded raw-image queue.

### 4 — Eight-item encode queue — rejected

Doubling the maximum in-flight raw images made the median 65 ms slower than iteration 3 (8.8%)
without a useful resource reduction. The implementation was reverted to four; additional queued
compression work introduces contention rather than hiding more latency on this workload.

### 5 — Four-target render/readback pool

Four reusable capture actors and render targets now submit a bounded group of scene captures before
the editor thread reads the results back. PNG work remains capped at four jobs. This reduces the
median by another 31 ms relative to iteration 3 (4.2%) and by 67.0% relative to baseline. Measured
end-to-end CLI wall time is 41.0% lower than baseline. The pool is retained.

### 6 — Two-target render/readback pool — rejected

Reducing the render/readback group to two increased the median to 809 ms, 14.8% slower than the
four-target pool, without a measured resource benefit. The smaller group does not give the render
queue enough useful work before synchronous readback resumes.

### 7 — Eight-target render/readback pool — rejected

Increasing the group to eight produced a 729 ms median, 3.4% slower than four, and higher measured
working-set, private-memory, and GPU-local peaks in this editor session. Four remains the best
measured latency/resource balance for this workload.

## Retained result

The retained implementation combines capture-resource reuse, lossless level-1 PNG compression,
four bounded encoder jobs, and four bounded render/readback targets. It reduces median manifest
time from 2.138 seconds to 0.705 seconds (67.0%) while keeping concurrency and raw-image memory
bounded independently of tile count.

# 0006: Bounded Observatory transform stream

## Status

Accepted for the Live World Scout high-rate path after measured host and Canvas evidence on the
development reference machine.

## Context

Map Review's Live World Scout originally polled a complete JSON actor snapshot at a user-selected
cadence. Every poll rediscovered actors, recalculated component bounds, serialized metadata and
transforms, crossed Remote Control and Electron IPC, and rebuilt presentation state. Raising the
slider toward 30–60 Hz therefore repeated discovery work rather than only moving points.

Cameras already proved a demand-driven named-pipe data plane with fixed headers, bounded
latest-state-wins queues, and scoped Effect ownership. Observatory needed the same safety properties
without coupling to `@ue-shed/cameras` or making Workbench a privileged architecture layer.

## Decision

- Discovery and transform animation are separate. `GetActorSnapshot` / catalog negotiation remain the
  authority for identity, class, label, bounds, and recovery. Ordinary samples carry only indexed
  changed transforms.
- The language-neutral USOT v1 packet is a fixed 96-byte little-endian header plus zero or more
  48-byte records, documented under `packages/protocol/contracts/observatory/v1`. Receivers
  resynchronize on magic and cap allocations before reading payloads.
- Catalog capacity is capped at **16,384** actors (raised from the earlier 4,096 foothold so the
  fixture `L_CameraLoad` lattice and larger editor worlds fit one catalog). Record count, payload
  bytes, and decoder buffers share that ceiling.
- `UEShedObservatory` owns a module-lifetime `FTickableEditorObject` producer. UE 5.7 ticks that
  object on the editor game thread; `ObservedWorld()` prefers `GEditor->PlayWorld` during PIE. Actor
  and world membership changes invalidate the catalog and emit reset; transform sampling never reads
  UObjects off-thread.
- Electron / `@ue-shed/observatory` hosts the process-specific Windows named pipe. Unreal connects as
  the producer. No listener means no packet queue growth. Non-Windows and unsupported plugins enter
  explicit `polling_fallback` at ≤10 Hz instead of a silent empty live stream.
- `@ue-shed/observatory` owns decoding, scoped feed lifecycle, catalog reacquisition, typed recovery
  failures, and metrics. Workbench adapts one coalesced IPC channel; Map Review paints one Canvas at
  display cadence with retained dense storage and accessibility via a single focusable application
  control plus `aria-live` selection summaries.
- Producer sample rate and Canvas paint rate are independent. Default requested cadence is 30 Hz;
  stream path permits 1–60 Hz. Bursts schedule at most one `requestAnimationFrame` paint.
- Sequence gaps, producer/receiver/IPC replacements, and reset counts are expected under
  latest-state-wins delivery and must remain observable.

## Measured budgets (development reference machine)

`pnpm benchmark:observatory` acceptance targets (not portable CI assertions):

| Scenario                         | decode+apply p95 | paint p95 |
| -------------------------------- | ---------------- | --------- |
| 1,000 actors, 50% change, 60 Hz  | ≤ 4 ms           | ≤ 8 ms    |
| 4,096 actors, 100% change, 60 Hz | ≤ 8 ms           | ≤ 16.7 ms |

Recorded on 2026-07-23 against this branch:

| Scenario                         | decode+apply p95 | paint p95 |
| -------------------------------- | ---------------- | --------- |
| 1,000 actors, 50% change, 60 Hz  | 0.317 ms         | 0.300 ms  |
| 4,096 actors, 100% change, 60 Hz | 2.408 ms         | 1.000 ms  |

Pending host/IPC/renderer work stayed at capacity 1; paint used exactly one Canvas. Correctness CI
asserts bounded pending work, one Canvas, coalesced paints, and no catalog/bounds work on
transform-only synthetic batches. Revise this ADR if a later machine class changes the accepted
numbers explicitly.

## Consequences

High-rate World Scout no longer depends on repeated bounds calculation or full JSON actor arrays.
Remote Control stays the control plane; the named pipe stays a local disposable data plane and never
becomes durable Review Set evidence. Stream-local indices are session aliases only.

Deferred work remains out of scope: time-indexed Observatory history, arbitrary property streams,
cross-platform transport beyond explicit polling fallback, shared memory, and multi-editor
arbitration beyond process-specific pipe names.

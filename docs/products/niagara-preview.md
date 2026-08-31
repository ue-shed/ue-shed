# Niagara Preview product

## Product promise

UE Shed Niagara Preview turns one saved `UNiagaraSystem` into a portable, immutable PNG frame
sequence without modifying project content. The public `@ue-shed/niagara` module and CLI own the
workflow; Workbench is optional.

Workbench composes the same public service at `#/niagara-preview`. The route lists every saved
Niagara System in the selected project from the shared package inventory, and capture starts from a
catalogue selection; a typed object path remains available for engine-shipped systems outside the
project. Capture takes bounded render settings, displays the typed producer recovery when capture
is refused, and reads back only manifest-owned frames whose byte length and SHA-256 still match the
immutable run. It adds presentation and project selection, not a second capture implementation.

Completed sequences autoplay on a loop at the manifest playback rate. Play, pause, restart, and
timeline selection are renderer-only review controls: they never mutate the source Niagara System
or the immutable capture evidence. Normal sequences are preloaded into a bounded 64 MB frame cache;
larger runs retain the same controls and load verified frames on demand.

The first slice uses the system's saved Baker camera and timing, with bounded explicit overrides.
It advances desired age deterministically inside an isolated preview scene, captures straight-alpha
sRGB frames, and records the effective camera and timing. Deterministic timing does not imply
pixel-identical output across GPUs, drivers, render settings, or engine builds.

## Capture and publication

`UEShedNiagara` is a separately enabled Editor-only plugin with an explicit dependency on Unreal's
Niagara plugin. Its commandlet accepts one versioned JSON request and stages frames plus a producer
receipt only beneath `Saved/UEShed/NiagaraPreviewStaging/<run-id>`.

The headless host validates receipt identity, paths, frame order, dimensions, byte bounds, and PNG
artifacts; hashes every frame; writes the portable manifest; and atomically publishes a completed
run. Unreal never receives the caller's destination path. Failed or interrupted operations never
appear in completed-run discovery.

The v1 render budget bounds dimensions, frame count, total pixels, start time, duration, and
simulation rate. Invalid requests, unavailable rendering, missing systems or Baker cameras,
compilation failures, capture failures, and invalid producer receipts remain distinguishable with
recovery guidance. Commandlet exit codes 10 and 20–24 carry the producer failure identity to the
host; unknown exits remain generic process failures. Empty or nearly empty output is a diagnostic
because an intentionally empty frame can be valid at the start or end of an effect.

| Exit | Typed host failure      | Meaning                                      |
| ---: | ----------------------- | -------------------------------------------- |
|   10 | `invalid_request`       | Invocation, request, or override was invalid |
|   20 | `rendering_unavailable` | Commandlet rendering was unavailable         |
|   21 | `system_unavailable`    | The requested Niagara System did not load    |
|   22 | `baker_camera_missing`  | No valid saved Baker camera was available    |
|   23 | `compilation_failed`    | The Niagara System was not runnable          |
|   24 | `capture_failed`        | Staging, capture, or receipt writing failed  |

## Authority and limitations

- Component-only capture is the default; full preview-scene capture is explicit.
- Scene opacity is converted to straight alpha. Emissive/additive coverage uses a versioned
  brightness-derived alpha policy.
- The isolated preview scene does not claim parity for map depth, collision, distance fields,
  Blueprint/gameplay drivers, or externally supplied user parameters.
- Nearly black or nearly empty output is recorded as a diagnostic, not silently treated as proof of
  a correct effect.
- Map-backed capture, camera overrides, batching, trimming, sprite sheets, HTML, and video remain
  later slices.

## Contracts and gates

- Producer request: `ue-shed-niagara-preview-request` 1.0.
- Producer receipt: `ue-shed-niagara-preview-receipt` 1.0.
- Published manifest: `ue-shed-niagara-preview-run` 1.0.
- Language-neutral authority: `packages/protocol/contracts/niagara/preview/v1`.
- Portable parity: `pnpm --filter @ue-shed/niagara contract:check`.
- Trusted rendering evidence: `pnpm test:unreal-niagara` with Unreal 5.7 available.

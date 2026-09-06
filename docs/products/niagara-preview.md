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

Without a profile, capture uses the system's saved Baker camera and timing, with bounded explicit
overrides. Reusable profiles select an opaque, lit preview scene and fit one stable camera across
the requested animation. Capture advances desired age inside an isolated preview scene and records
the effective camera and timing. Deterministic timing does not imply
pixel-identical output across GPUs, drivers, render settings, or engine builds.

## Review profiles and video

Backgrounds are independent of effect profiles. `background: "default"` retains the lit preview
scene; `"dark"` and `"light"` render against uniform black and light backdrops with the floor mesh
removed. They require scene rendering and keep the lighting cubemap, lights, and exposure unchanged.
The CLI exposes `--background default|dark|light` alongside `--profile`.

`niagaraBackgroundVariant(referenceManifest, "dark" | "light")` reuses the reference capture's
settings and perspective camera. The optional `cameraOverride` supplies location, rotation, and
field of view; it takes precedence over saved/auto-fit camera settings. This permits the alternate
backgrounds to preserve the default's framing without reorienting or panning the camera.

`selectNiagaraVariantPresentation(manifest, reference)` uses the reference's active window and poster
time, rejecting a different system or capture timeline. The encoder accepts `--reference` with
that reference manifest and records its hash. All three videos can therefore share the same short
playback window while retaining their original PNG sequences. Authored random particle variation
can still differ between independent captures.

`niagaraPreviewProfile(name, overrides)` supplies validated defaults for library callers. The CLI
exposes the same defaults with `niagara preview --profile <name>`, plus `--render-mode`,
`--camera-mode`, `--exposure`, and `--camera-padding`. Explicit settings override profile defaults.

| Profile         |  Duration | Scene                                              |
| --------------- | --------: | -------------------------------------------------- |
| `ground_impact` | 3 seconds | Neutral lighting and ground plane                  |
| `projectile`    | 2 seconds | Neutral lighting, no ground plane                  |
| `aura`          | 4 seconds | Neutral lighting, preserves full playback interval |
| `environment`   | 6 seconds | Neutral lighting, preserves full playback interval |

Profiles use 512×512 pixels, 30 playback FPS, 60 simulation FPS, one stop of exposure compensation,
and 1.2 camera padding. Frame count and duration are independent overrides; set both to preserve
playback FPS. Auto fitting samples animated bounds and rendered coverage before the final capture;
it costs two additional passes. It accommodates oversized fixed bounds and faint effects, but
outlying particles can still make the central effect small. Saved-camera capture remains available.

Scene rendering uses Unreal's tone curve, fixed exposure, a neutral cubemap, and controlled lights.
It exports opaque sRGB frames, avoiding brightness-derived alpha for the finished review image.
Temporal AA, motion blur, Lumen GI, and reflections are disabled for bounded commandlet memory use.
This is a reproducible inspection scene, not a reproduction of the project's gameplay lighting.

`selectNiagaraPresentation(manifest)` selects an activity window and a sustained-activity poster.
Activity is measured against an empty capture of the same scene. Unbound renderer material slots
on enabled emitters and renderers at initialization produce a `missing_material` diagnostic and require review, even when fallback
cards generate visible activity. This can indicate missing assignments or a need for gameplay
parameter bindings. Short effects receive 150 ms
padding at either end; aura and environment profiles keep the complete interval. Blank output or
significant activity at the image edge sets `needsReview`; this heuristic is not visual approval.
The original frames and manifest remain unchanged.

An optional local encoder consumes a completed manifest and an explicitly supplied FFmpeg:

```sh
node --import tsx scripts/encode-niagara-preview.ts --manifest /captures/run/manifest.json --ffmpeg /tools/ffmpeg --output /previews/new-preview
```

It requires even capture dimensions and a complete ordered sequence, verifies every input frame
hash, encodes H.264/yuv420p, checks the encoded stream with ffprobe,
copies the selected poster, and publishes a new directory atomically. `presentation.json` records
the selection, source manifest hash, encoder identity and arguments, and output hashes. The output
directory must not already exist. FFmpeg is an external prerequisite, not downloaded by capture.

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
- Transparent mode converts scene opacity to straight alpha; emissive/additive coverage uses a
  versioned brightness-derived alpha policy. Scene mode uses `opaque_scene_v1` instead.
- The isolated preview scene does not claim parity for map depth, collision, distance fields,
  Blueprint/gameplay drivers, or externally supplied user parameters.
- Nearly black or nearly empty output is recorded as a diagnostic, not silently treated as proof of
  a correct effect.
- Map-backed capture, orthographic camera overrides, a batch scheduler, sprite sheets, and a reusable
  HTML gallery remain later slices. Profiles and derived video are available to external job runners.

## Contracts and gates

- Producer request: `ue-shed-niagara-preview-request` 1.2.
- Producer receipt: `ue-shed-niagara-preview-receipt` 1.2.
- Published manifest: `ue-shed-niagara-preview-run` 1.2.
- Readers retain 1.0/1.1 support. New hosts require the matching 1.2 producer plugin; old plugins reject
  the newer request. Scene settings and activity metadata are optional for older evidence.
- Language-neutral authority: `packages/protocol/contracts/niagara/preview/v1`.
- Portable parity: `pnpm --filter @ue-shed/niagara contract:check`.
- Trusted rendering evidence: `pnpm test:unreal-niagara` with Unreal 5.7 available.

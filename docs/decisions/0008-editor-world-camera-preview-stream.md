# 0008: Stream Map Review from the editor world

## Status

Accepted.

## Context

Map Review originally used the local BGRA camera stream only in PIE/SIE and performed a synchronous
one-shot render, PNG compression, disk write, disk read, and staging cleanup for every preview while
the editor was stopped. That split was an implementation boundary, not an Unreal rendering
requirement.

UE 5.7 creates world subsystems for editor worlds, ticks editor-associated `FTickableGameObject`
instances when `IsTickableInEditor()` is true, and lets `USceneCaptureComponent2D` render any valid
world scene. UE Shed's existing editor PNG boundary already proved that the open editor world's scene
can be captured without PIE. Repeating that PNG path would preserve the unnecessary synchronous and
filesystem costs instead of reusing the bounded asynchronous readback pipeline.

Editor and PIE worlds can coexist in one Unreal process. The camera protocol has one fixed local pipe,
so independently owned pipe writers would race for the same transport and could interleave camera
indices without an authority rule.

## Decision

- `UUEShedCameraSubsystem` supports Editor, PIE, and Game worlds and explicitly ticks in the editor
  and while a play world is paused.
- Provisioned cameras use the existing batched `ISceneRenderBuilder` and reusable asynchronous GPU
  readback path in every supported world. Editor preview does not loop the PNG capture API.
- The camera pipe writer is process-shared. A play world is the preferred Remote Control target while
  one exists; otherwise the editor world is selected. The editor producer performs no render or pipe
  work while a play world exists.
- Provisioning into one world clears provisioned sessions in other worlds. Returned bindings include
  `editor_live` or `play_live` provenance, and the host waits for the provisioned camera's identity as
  well as its numeric index so a stale frame cannot satisfy a new request.
- Editor-world preview actors use transient, hidden, package-less spawn flags and are destroyed without
  modifying the level. They are preview infrastructure, never authored cameras or Review Views.
- Map Review attempts the live stream first for sets within the 32-camera transport limit. When the
  editor is stopped, a typed producer or feed failure may fall back to the one-shot PNG preview. During
  PLAY/SIM, a live failure remains visible rather than silently switching world authority.
- Keep and Capture Set continue through the durable editor PNG boundary. Capture Set remains blocked
  during PLAY/SIM, and no live frame is promoted into durable evidence.
- Map Capture may reuse the same process-shared producer for a single top-down orthographic framing
  camera. That observation preview remains distinct from its full-fidelity PNG tile capture.

## Consequences

Authors can drag framing adjustments and see the open level update without starting PIE. The preview
includes current editor transforms, materials, lighting, visibility, and loaded world-partition state,
including unsaved changes represented in the editor scene.

Editor-live does not execute gameplay lifecycle or simulation. BeginPlay, gameplay-only ticks,
physics, AI, and runtime-spawned actors require PLAY/SIM and are labeled as play-live provenance.
PNG remains a slower compatibility path and the durable capture format, not the normal stopped-mode
interaction loop.

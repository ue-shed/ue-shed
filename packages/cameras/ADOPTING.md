# Adopt camera authoring into an existing host

Install an exact published `@ue-shed/cameras` version and its declared dependency closure.
Keep the host's project selection, filesystem authority, transport, and UI outside the package.
Never import Workbench, extension internals, or native private headers.

Create durable state with `makeCameraAuthoringStore`; supply another implementation of
`CameraAuthoringStore` when the host owns a different persistence system. Use
`makeCameraAuthoringBridge` with a host-owned Remote Control client and explicit endpoint.
Attach through `attachArrangementCamera`, then poll `makeCameraAuthoringPanelSession().tick`
under the host's scoped lifetime. Keep polling independent of whether the menu is visible.
Release the native attachment on shutdown. Draft edits and explicit View approval are separate.

For conflicts, call `inspectCameraRecovery`, show its saved and pending native values, and pass
the reviewed proposal to `resolveCameraRecovery` with an explicit `saved` or `native` choice.
Changed revisions/gestures require fresh inspection. Neither choice approves Views.
For a preserved snapshot, `prepareCameraRecovery` produces a read-only review and
`restoreCameraRecovery` commits the explicit choice while detached. Reattach after recovery.
Local file-store writers recover confirmed dead local owners on retry. Do not share authoring
storage between hosts on a network filesystem or mix old and new writer implementations.

Enable Core+Cameras for capture, CameraAuthoringBridge for native editing, and optionally
CameraAuthoring for the reference menu. A replacement menu calls the bridge's public `Execute`
port; it must not implement framing, persistence, or approval itself.

The generic packed-consumer journey is `examples/camera-authoring/verify.mjs` in the repository.
`pnpm test:release:packages` copies it into a clean consumer and runs against the exact tarballs.
It proves creation, tuning, retry, reopening and approval without Workbench or Unreal.
`scripts/test-camera-authoring.ts <new-directory>` adds real RC editing, conflict recovery,
1/6/37-camera acknowledgement measurements, restart, and capture with authoring disabled.
Set `UE_SHED_UNREAL_ENGINE_ROOT` explicitly for that native runner.
It builds `examples/camera-authoring/Plugins/CameraMenuExample` independently against public headers
and submits editing, culling and approval actions through that adapter with the reference menu
disabled. The example deliberately delegates all domain behavior to the bridge and host.

Record the exact package version, plugin digest, engine version, and your host's own transport
journey before claiming downstream compatibility. Review previews are not final-capture evidence.

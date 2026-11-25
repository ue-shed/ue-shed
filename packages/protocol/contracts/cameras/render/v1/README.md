# Camera render wire 1.0

These JSON schemas are the wire authorities. `@ue-shed/cameras` exposes matching Effect Schema
decoders; `check-render-contract.ts` detects shape drift and checks fixtures without rewriting the
authorities. `UEShed.Cameras.Rendering.WireConformance` checks the same request fixtures in C++.

The separately enabled UEShedCore capability is `cameras.render-session.v1`. The public Remote
Control library is `/Script/UEShedCamerasEditor.Default__UEShedCameraRenderingLibrary`.

| Method                        | Parameters                   | Result schema   |
| ----------------------------- | ---------------------------- | --------------- |
| GetCameraRenderCapabilities   | None                         | capabilities    |
| GetCameraRenderCapabilitiesV2 | None                         | capabilities-v2 |
| GetCameraRenderCapabilitiesV3 | None                         | capabilities-v3 |
| PreflightCameraRender         | RequestJson: session-request | preflight       |
| BeginCameraRender             | RequestJson: session-request | begin-result    |
| StartCameraFrame              | RequestJson: frame-request   | frame-status    |
| PollCameraFrame               | SessionId, OperationId       | frame-status    |
| EndCameraRender               | SessionId                    | end-result      |

Review's separately versioned `ue-shed-review-render-stages/1.0` uses
`ResolveReviewViewpoint(RequestJson)` and
`InspectRenderedReview(SessionId, RequestJson)` on `UEShedCameraReviewLibrary`.

Both renderer policies accept an optional `editorPreviews` boolean (absent means `false`). It
shows child actors that ChildActorComponents spawn for editor-only owners. Plugins that support it
advertise the `editorPreviews` capability, and frame evidence then carries
`editorPreviews.revealedChildActors`. Earlier plugins reject the field as `invalid_policy`. Review
capture responses and map-tile evidence embed the same renderer policy and frame evidence.

The viewport renderer additionally accepts optional `screenshotWarmupFrames` (an integer from 1 to
256). Supporting Core manifests advertise `cameras.render-session.capabilities.v2`; the SDK then
calls `GetCameraRenderCapabilitiesV2` to discover `highResolutionScreenshot.maximumWarmupFrames`.
The original getter and its `capabilities` schema remain unchanged for previously shipped strict
clients. `capabilities-v2` extends discovery while render requests retain contract 1.0. Omission retains
the engine/project setting; earlier plugins reject the field. Native screenshot run-up is separate
from ordinary viewport settling, and its scoped value/priority override is restored per frame and
on interruption. SceneCapture policies reject the field. Frame policy evidence carries the explicit
choice. Clients must negotiate the extended discovery method before requesting the new control.

Both renderer policies also accept an optional `clouds` boolean. It sets the Cloud show flag for
the render, so `false` keeps volumetric clouds out of top-down captures. Absence keeps the editor
viewport's or SceneCapture's own setting. Plugins that support it advertise
`clouds: { version: 1, viewport, sceneCapture }` through `GetCameraRenderCapabilitiesV2` (the v1
getter omits it), and the SDK refuses the field before acquiring an editor whose plugin lacks it.
Earlier plugins reject it as `invalid_policy`. Frame policy evidence carries the explicit choice.

The viewport renderer has a second strategy, `offscreen_viewport`. It draws the locked viewport
camera into an offscreen target of the requested size, keeps temporal anti-aliasing on while the
editor is in the background, and renders at 100% screen percentage. It takes the same `profile`,
`vignette`, `fog`, `volumetricFog`, `clouds` and `editorPreviews` fields, plus required
`resolution: "native"` and `lod: "highest" | "natural"` (`highest` draws every mesh at LOD 0). It has
no `screenshotWarmupFrames`; `settling.minimumFrames` counts frames drawn at output size. Supporting
Core manifests advertise `cameras.render-session.capabilities.v3`; `GetCameraRenderCapabilitiesV3`
then lists `offscreen_viewport` in the viewport renderer's `strategies` and adds
`offscreenViewport: { version: 1, resolutions, lods }`. The v1 and v2 getters return exactly what
they returned before, without the strategy or the options. The SDK prefers v3, falls back to v2 and
then v1, and refuses `offscreen_viewport` as `unsupported_capability` before preflight or open when
the plugin does not advertise it. Render requests keep contract 1.0.

Request JSON rejects unknown fields. Native semantic validation additionally rejects duplicate Data
Layer identities, unsupported renderer/exposure combinations, effective layer hierarchy conflicts,
world/project mismatch, contention, region overrides with preserved loading, exceeded resource
budgets and sizes beyond the connected RHI limit. These are preflight/frame failures, not silent
coercions. IDs correlate active operations; repeating an active Begin renews its lease. Repeated
frame input is idempotent while retained; changed input conflicts and expired input cannot recapture.

Frame evidence describes the source render. Artifact publication and optional Review assessment
are separate operations. There is no pixel-equivalence claim between backend policies.

See [public lifecycle, retention, policies and adoption](../../../../../../docs/products/camera-rendering.md).

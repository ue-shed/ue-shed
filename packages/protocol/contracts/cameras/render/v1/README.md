# Camera render wire 1.0

These JSON schemas are the wire authorities. `@ue-shed/cameras` exposes matching Effect Schema
decoders; `check-render-contract.ts` detects shape drift and checks fixtures without rewriting the
authorities. `UEShed.Cameras.Rendering.WireConformance` checks the same request fixtures in C++.

The separately enabled UEShedCore capability is `cameras.render-session.v1`. The public Remote
Control library is `/Script/UEShedCamerasEditor.Default__UEShedCameraRenderingLibrary`.

| Method                      | Parameters                   | Result schema |
| --------------------------- | ---------------------------- | ------------- |
| GetCameraRenderCapabilities | None                         | capabilities  |
| PreflightCameraRender       | RequestJson: session-request | preflight     |
| BeginCameraRender           | RequestJson: session-request | begin-result  |
| StartCameraFrame            | RequestJson: frame-request   | frame-status  |
| PollCameraFrame             | SessionId, OperationId       | frame-status  |
| EndCameraRender             | SessionId                    | end-result    |

Review's separately versioned `ue-shed-review-render-stages/1.0` uses
`ResolveReviewViewpoint(RequestJson)` and
`InspectRenderedReview(SessionId, RequestJson)` on `UEShedCameraReviewLibrary`.

Request JSON rejects unknown fields. Native semantic validation additionally rejects duplicate Data
Layer identities, unsupported renderer/exposure combinations, effective layer hierarchy conflicts,
world/project mismatch, contention, region overrides with preserved loading, exceeded resource
budgets and sizes beyond the connected RHI limit. These are preflight/frame failures, not silent
coercions. IDs correlate active operations; repeating an active Begin renews its lease. Repeated
frame input is idempotent while retained; changed input conflicts and expired input cannot recapture.

Frame evidence describes the source render. Artifact publication and optional Review assessment
are separate operations. There is no pixel-equivalence claim between backend policies.

See [public lifecycle, retention, policies and adoption](../../../../../../docs/products/camera-rendering.md).

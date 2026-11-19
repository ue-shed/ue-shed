---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-connection": minor
---

A long high-resolution capture no longer fails when one frame status check gets no answer within
30 seconds. Unreal answers nothing while it renders the screenshot warm-up and the shot in one call,
so a check could time out moments before the shot finished and fail the whole capture as
`render_connection_failed`. A check that times out is now sent again until the frame's deadline,
and a frame that really passes its deadline fails as `settling_timeout`. Hosts can set the per-call
limit (`requestTimeout`) and the deadline margin (`frameDeadlineMargin`) through new
`CameraRendererOptions` on `makeCameraRenderer` and `cameraRendererLayer`; both default to 30 seconds.

A slow renderer call no longer ends lease renewal for the rest of the session. A renewal that times
out is sent again until the lease would have run out; only then does the next frame fail, as
`lease_expired`. Map tile status polls get the same retry, and `runMapCapture` takes a
`batchDeadline` (default 15 minutes).

Hosts can raise any library's per-call Remote Control timeout. `makeRemoteControlClient` takes a
`minimumTimeout` floor and exact `operationTimeouts`, and `RemoteControlClientLive` reads the floor
from `UE_SHED_REMOTE_CONTROL_MINIMUM_TIMEOUT`. `captureReviewSet` and `runMapCapture` now honour
`UE_SHED_REMOTE_CONTROL_TIMEOUT` and the floor instead of fixed 10 second and 5 minute clients.

Captures can switch volumetric clouds off. Both camera renderer policies accept an optional `clouds`
boolean, advertised by `clouds` in `GetCameraRenderCapabilitiesV2`, and map capture 1.3 adds
`render.effects.clouds`. Absence keeps the editor's own setting, as before.

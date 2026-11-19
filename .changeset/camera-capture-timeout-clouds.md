---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

A long high-resolution capture no longer fails when one frame status check gets no answer within
30 seconds. Unreal answers nothing while it renders the screenshot warm-up and the shot in one call,
so a check could time out moments before the shot finished and fail the whole capture as
`render_connection_failed`. A check that times out is now sent again until the frame's deadline,
and a frame that really passes its deadline fails as `settling_timeout`. Hosts can set the per-call
limit (`requestTimeout`) and the deadline margin (`frameDeadlineMargin`) through new
`CameraRendererOptions` on `makeCameraRenderer` and `cameraRendererLayer`; both default to 30 seconds.

Captures can switch volumetric clouds off. Both camera renderer policies accept an optional `clouds`
boolean, advertised by `clouds` in `GetCameraRenderCapabilitiesV2`, and map capture 1.3 adds
`render.effects.clouds`. Absence keeps the editor's own setting, as before.

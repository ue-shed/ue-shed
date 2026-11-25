---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Viewport captures from an editor in the background keep temporal anti-aliasing. An unfocused or
throttled editor drew each frame as non-realtime, which dropped TSR/TAA to FXAA and left foliage
speckled and edges jagged; the render session now marks only its own frames realtime and lifts Slate
throttling while it draws, without redrawing the live viewport between frames (those redraws reset
TSR history and restarted settling). The editor no longer throttles its CPU while a render session
is open, and a finished PNG's size is checked from its header instead of decoding the whole image.

New `offscreen_viewport` strategy for the viewport renderer. It draws the locked camera into an
offscreen target of the requested size every settling frame, at 100% screen percentage, and writes
the PNG off the game thread, so 4K captures are sharp and smaller ones finish sooner. It takes
`resolution: "native"` and `lod: "highest" | "natural"`. Plugins advertise it through the new
`GetCameraRenderCapabilitiesV3` (`cameras.render-session.capabilities.v3`); the v1 and v2 responses
are unchanged. The SDK prefers v3 discovery and refuses the strategy as `unsupported_capability`
before acquiring an editor whose plugin lacks it. `CameraRenderCapabilities` is now the v3 shape;
the v2 shape is exported as `CameraRenderCapabilitiesV2`.

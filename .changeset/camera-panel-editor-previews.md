---
"@ue-shed/cameras": patch
---

Keep a saved `renderer.editorPreviews` when a Review capture run picks another renderer, such as
the high-resolution screenshot. `reviewCaptureRenderPolicy` previously replaced the whole renderer,
so spawn-volume previews that the saved policy showed disappeared from that run's images. A
per-run renderer that sets `editorPreviews` itself still wins.

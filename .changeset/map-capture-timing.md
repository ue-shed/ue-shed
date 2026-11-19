---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Map captures on slow editors or big maps no longer have to fit the plugin's fixed timing. Map capture
1.3 adds an optional `render.timing` to plans and requests: `frameTimeoutMs` (the 120 second deadline
for each tile or level render), `settleFrames` (128 per Lit tile, 3 per scene-capture tile),
`overviewFrames` (512 before the first Lit tile) and `screenshotWarmupFrames` (until now only the
global `r.HighResScreenshotDelay`). Lit, scene-capture and viewport high-resolution captures all use
them; each absent field keeps the old value.

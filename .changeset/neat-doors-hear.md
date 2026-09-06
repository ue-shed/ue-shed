---
"@ue-shed/cameras": minor
"@ue-shed/protocol": minor
---

Make Lit editor-camera tiles the default Map Capture backend, with shared exposure, disabled
vignette, plugin-owned scene freezing, and asynchronous capture with cancellation cleanup. Add
optional manual exposure and retain explicit legacy backends. New plans use 16-pixel gutters and
disable fog. The default requires an unlocked rendering editor viewport and the updated camera plugin.

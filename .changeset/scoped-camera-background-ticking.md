---
"@ue-shed/cameras": patch
"@ue-shed/protocol": patch
"@ue-shed/plugin-distribution": patch
---

Add opt-in editor background ticking for connected live camera streams without changing editor preferences. Release the override on pause, clear, loss of world authority, disconnect, or stalled delivery. Correct round-robin iteration and prioritize the focused camera. Hosts must publish/install matching protocol, cameras, and native plugin versions.

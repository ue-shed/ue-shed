---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/game-text": patch
---

Reduce Game Text shared-string publication and query preparation work with faster transient lookup,
bounded parallel dictionary frame compression, less copying during sorted-run merging, and independent
raw and sliced query projections. Shared IDs, persisted snapshot bytes and query behavior stay stable.

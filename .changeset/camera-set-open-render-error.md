---
"@ue-shed/cameras": patch
"@ue-shed/protocol": patch
---

Tell an open camera set apart from another render session. When a camera set is open in the
editor, the renderer now refuses a session with the new `authoring_open` code, the message "A
camera set is open in the editor." and the recovery "Close the camera set, then retry."
`editor_busy` now means only another render session or an unrelated screenshot, and its recovery
says to wait for that session. Failures carry the blocking issue's recovery instead of a generic
one, including Review and map-tile captures. `isEditorOwnershipRejection` identifies both codes, and
Review capture reports them as retry-safe view failures with the native message instead of a
connection failure. The camera render wire adds `authoring_open` to its failure codes. Older plugins
keep sending `editor_busy`. Packages before this release don't recognise `authoring_open` and
report it as `render_connection_failed`, so upgrade the package with the plugin.

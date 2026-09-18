---
"@ue-shed/cameras": minor
"@ue-shed/engine": patch
---

Edit whole camera sets as transient Unreal camera actors with multi-selection, pilot switching,
automatic draft synchronization, native duplication/deletion and Undo/Redo. Keep whole-set review
in a separate on-demand See Previews panel. Enable the exact UE Shed Remote Control APIs required
by UE 5.8 without changing project configuration or allowing arbitrary remote calls.

Allow first-camera creation without a preselected Review Set, using the public createMapReviewSet
workflow to persist a fresh destination. Distinguish editable camera sets from published Review Sets,
surface create/open failures, and avoid unnecessary Unreal calls when opening saved collections.

Redesign native camera authoring around actor selection and visible preset cards before creation,
compact Select/Pilot rows, collapsed advanced settings, automatic-save status and a separate review
footer. Add the public Effect setup host and bounded native setup queue so connected hosts can persist
and attach a complete preset directly from Unreal without opening a Workbench page. Keep creation
failures visible, avoid replay after lost acknowledgements, and skip hidden Workbench live rendering
for native-created sets.

Use a resizable camera-list/inspector split, two-column framing fields, compact action rows and native
dock-style tabs. Enable numeric scrubbing with bounded live updates and retention of the final value
through host acknowledgement; cancel unsent adjustments if their editing scope or session changes.

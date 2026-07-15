# Camera Review

The local reference reviewer for durable Map Review evidence. Its first slice loads filesystem-backed
Capture Run history, starts a capture through the same headless service used by the CLI, displays the
selected Pure image at review scale, and exposes run and view diagnostics.

The spatial-authoring desk inspects one live editor selection, presents real transient candidate
previews as a contact sheet, supports discard and manual pose/FOV refinement, and persists the kept
Approved Pose with preset lineage and adjustment provenance outside the map.

Workbench supplies the thin Electron IPC adapter. The route and client contract remain in this
extension so the product UI does not become an architecture layer.

# Camera Review

The local reference reviewer for durable Map Review evidence. Its first slice loads filesystem-backed
Capture Run history, starts a capture through the same headless service used by the CLI, displays the
selected Pure image at review scale, and exposes run and view diagnostics.

The spatial-authoring desk inspects one live editor selection, presents real transient candidate
previews as a contact sheet, supports discard and manual pose/FOV refinement, and persists the kept
Approved Pose with preset lineage and adjustment provenance outside the map.

Live World Scout is the primary entry surface: it consumes the Observatory demand-driven transform
stream (USOT v1 named pipe) with bounded snapshot polling as an explicit ≤10 Hz fallback, paints one
aspect-preserving Canvas actor map, filters by label and class, and turns point or keyboard selection
into Unreal focus plus transient framing. Authors request 1–60 Hz producer cadence (30 Hz default;
fallback caps visibly at 10 Hz). Resets and reconnects retain the last valid spatial sample with an
explicit stale/reconnecting state. The larger geographic atlas and spatial-comment product remain out
of scope.

Workbench supplies the thin Electron IPC adapter. The route and client contract remain in this
extension so the product UI does not become an architecture layer.

# `@ue-shed/authoring`

The headless engine for a complete DataTable workflow: discovery, schema and snapshots, staged command
sessions, undo/redo, validation, drift detection, conflict resolution, Apply, and Save. It remains
independent from any desktop shell or studio-specific schema.

It consumes authority-tagged snapshots through narrow interfaces. Saved project packages provide a
first-class read-only authority through `@ue-shed/unreal-assets`; `UEShedAuthoring` provides live
editor state and mutation. The domain package does not invoke parser or transport details directly.

The implemented headless kernel includes semantic table fingerprints, persistent versioned sessions,
the five canonical command shapes, strict command folding, grouped append/undo/redo, pure inversion,
schema-aware value validation, semantic multi-table diffs, Session Review projections, and atomic
session-file replacement. It builds bounded multi-table Apply plans through a narrow live port,
rebases committed drafts from returned snapshots, preserves indeterminate outcomes without automatic
replay, and records Apply and Save as separate durable receipts.

`makeAuthoringSessionService` is the maintained persistence boundary. It scopes storage to a project,
addresses sessions by validated id, serializes transitions, fsyncs atomic replacements, quarantines
malformed documents, migrates supported older drafts, and exposes lifecycle, typed cell/row intents,
review, validation, diff, Apply, and Save as named Effects. Hosts and renderers should consume this
service instead of owning a command log or passing arbitrary session file paths.

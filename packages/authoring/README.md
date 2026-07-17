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

Native `FDataTableRowHandle` values also project into a versioned relationship report. The pure
resolver retains source-cell provenance, resolves one target row only when table authority and row
identity are unambiguous, and emits recovery-oriented diagnostics for unassigned, missing, or
ambiguous targets. `ue-shed authoring relationships <project-root>` exposes the same report without
Workbench.

`ue-shed authoring join <project-root> <source-table> <reference-field>` builds a versioned,
read-only joined projection over those relationships. Every projected row retains its canonical
source row and provenance, resolved rows retain the complete target row and provenance, and broken
relationships remain visible instead of being dropped. The projection intentionally grants no draft
authority; edits still target a canonical table session.

The maintained Data Authoring extension presents that projection as a cross-table evidence matrix.
Its source selector exposes the project catalog, while a table switchboard can show, hide, or isolate
participating source and target columns without changing the projection or loading draft authority.

`makeAuthoringSessionService` is the maintained persistence boundary. It scopes storage to a project,
addresses sessions by validated id, serializes transitions, fsyncs atomic replacements, quarantines
malformed documents, migrates supported older drafts, and exposes lifecycle, typed cell/row intents,
review, validation, diff, Apply, and Save as named Effects. Hosts and renderers should consume this
service instead of owning a command log or passing arbitrary session file paths.

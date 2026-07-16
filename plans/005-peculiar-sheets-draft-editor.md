# Plan 005: Ship the Peculiar Sheets draft editor and Session Review

> **Executor instructions**: Use only the dependency/version approved by Plan 002. The grid emits
> semantic intents to the public session client; it never owns draft truth. Update the plan index.
>
> **Drift check**: `git diff --stat 52df5c0..HEAD -- extensions/data-authoring packages/authoring packages/authoring-sdk apps/workbench package.json pnpm-lock.yaml`

## Status

- **State**: DONE
- **Priority**: P1
- **Effort**: L (multi-day)
- **Risk**: MED — interaction churn is contained by the adapter, but codecs protect persisted data
- **Depends on**: Plan 004
- **Planned at**: commit `52df5c0`, 2026-07-15

## Completion — 2026-07-16

- Replaced the rendered CSS ledger with the pinned `peculiar-sheets@0.9.1` `Sheet` adapter. The
  production Workbench bundle includes its public component and stylesheet.
- Added the browser-safe `@ue-shed/authoring-sdk` with runtime schemas for scoped session views and
  atomic `set_cells` intents. Workbench main/preload are transport adapters over the headless service.
- Direct edits, paste, fill, and delete operations pass through one adapter decoder. Exact integers
  remain strings; unsupported or schema-unproven fields remain read-only; batch failures persist
  none of the gesture.
- The route resumes or creates a project session, refreshes from persisted working state after every
  gesture, and exposes service-backed Undo/Redo. Plan 006 is now complete, so its separately guarded
  Apply, reconcile, and Save actions remain available without moving authority into the renderer.
- Added explicit Add, Duplicate, Rename, Delete, and Move row actions. Destructive changes require
  confirmation, filtered/sorted views never emit canonical reorder, and grid structural shortcuts
  remain subject to the same semantic intent boundary.
- Added recent/open draft navigation, discard, dirty row/cell decoration, command and validation
  counts, replacement confirmation, and a Session Review inspector with semantic before/after values
  and diagnostics.
- Removed the dormant CSS-ledger markup. Peculiar Sheets is now the only grid boundary and remains
  pinned to the rights-holder-approved `0.9.1` release.
- Added adapter, SDK, service, IPC, Solid component, production-build, large-table, and Electron E2E
  coverage. Visual verification covers the supported Workbench dark theme; Workbench has no light
  theme contract, so this plan does not introduce an authoring-only theme mode.

## Outcome

The authoring route becomes an Electroswag-inspired working product: project/table discovery, open
drafts, a virtualized keyboard-friendly sheet, persistent staged edits, row operations, undo/redo,
dirty indicators, validation, and Session Review. Apply remains disabled until Plan 006.

## Architecture and scope

Create one extension-local `AuthoringTableGrid` adapter. Its inputs are UE Shed table/column/view
models; outputs are selection and semantic edit/row intents. Keep every Peculiar import, branded
index conversion, and vendor stylesheet at this boundary. Use documented APIs only. Vendor CSS may
be contained by StyleX layout, but do not override private `.se-*` selectors or rely on stylesheet
order. Do not construct HyperFormula.

Build pure typed codecs because Peculiar cells are only scalar while `AuthoringValue` is recursive.
Preserve the original field beside the display matrix. Decode direct edits, paste, autofill, delete,
and batch operations at the adapter boundary—`ColumnDef.parseValue` alone is insufficient.

Initial editable kinds: bool, name/string, enum, GUID/path, exact int/uint text, finite float/double,
and nullable object references where the schema proves compatibility. Localized text, vectors,
structs, containers, and opaque values render honest summaries and remain read-only until Plan 007.

## Work

1. Add adapter contract tests before replacing the route: stable row identity, empty/sparse tables,
   selection, direct edit, batch paste grouping, delete, insert, sort-vs-reorder, invalid input, and
   read-only rich values.
2. Replace the CSS ledger with Peculiar read-only parity, preserving authority, provenance,
   diagnostics, search/filter, selection inspector, empty/error/loading states, and accessible focus.
3. Connect scalar edits to one persisted canonical command group per user gesture. Surface typed
   failures inline without mutating the session.
4. Add row add/duplicate/rename/delete/reorder through service intents. View sorting/filtering must
   never emit a canonical reorder. Require explicit confirmation where data is removed.
5. Add draft/table navigation, recent/open drafts, dirty decorations, undo/redo/discard, command and
   validation counts, and a Session Review panel showing semantic before/after values.
6. Preserve the current draft/table during cancelled or failed replacement. Prompt on intentional
   replacement when the active session is dirty.
7. Add host-neutral Solid component tests, production-build smoke coverage, and visual checks for
   light/dark, focus, disabled, validation, empty, partial, and large-table states.

## Verification

- `pnpm exec vitest run extensions/data-authoring/src packages/authoring/src`
- `pnpm --filter @ue-shed/data-authoring typecheck`
- `pnpm --filter @ue-shed/workbench build`
- Manual fixture flow: discover `DT_Scalars`, edit and paste cells, add/rename/delete/reorder rows,
  undo/redo, restart Workbench, and observe the identical draft and review
- `pnpm check`

## STOP conditions

- Plan 002 did not approve the dependency/version.
- Any grid operation bypasses typed decoding or atomic session persistence.
- Sorting or filtering mutates canonical row order.
- The implementation imports Electroswag stores/components or uses private Peculiar DOM hooks.
- Apply or Save becomes enabled before Plan 006's safety gates.

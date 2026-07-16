# Plan 004: Build the persistent, headless authoring session service

> **Executor instructions**: The service, not a renderer or Electron IPC handler, owns state. Adapt
> CLI first and keep pure transformations ordinary functions. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 52df5c0..HEAD -- packages/authoring packages/authoring-sdk apps/cli apps/workbench extensions/data-authoring`

## Status

- **State**: DONE
- **Priority**: P0
- **Effort**: L (multi-day)
- **Risk**: HIGH — persistence and serialization determine whether drafts survive crashes correctly
- **Depends on**: Plan 003
- **Planned at**: commit `52df5c0`, 2026-07-15

## Completion — 2026-07-16

- Added a project-scoped `AuthoringSessionService`; callers address sessions by validated id rather
  than coordinating raw session file paths.
- Create, open, resume, list, append, undo, redo, close, and discard transitions are Effect-based,
  serialized, spanned, and durably persisted before reporting success.
- Session documents persist contract version, project identity, lifecycle, timestamps, pending
  operation evidence, the versioned draft, fingerprints, and receipts.
- Atomic replacement fsyncs the temporary document before rename. Malformed documents are moved to
  uniquely named quarantine files rather than overwritten.
- Added restart and corruption tests plus the project-scoped `authoring sessions` CLI surface for
  list/create/show/resume/close/discard/edit/review/validate/diff/undo/redo/Apply/Save. Removed the
  superseded raw-path draft and session commands.
- Added typed, durable Add, Duplicate, Remove, Rename, and Reorder intents. Row names follow Unreal's
  `FName`/`NAME_None` and case-insensitive uniqueness behavior; Add requires schema-proven defaults,
  while Duplicate preserves the source row's complete typed values. The same operations are exposed
  through process-tested `authoring sessions` CLI commands.
- Added schema-owned review, validation, and semantic diff models for multi-table sessions, including
  dirty rows/cells, command groups, diagnostics, undo/redo state, and pipeline state.
- Added recursive value compatibility checks and typed recovery failures for the supported scalar,
  reference, enum, struct, and container shapes. Apply preparation now rejects invalid reviews.
- Added v1-to-v2 session migration with atomic persistence, plus host-neutral SDK, Workbench IPC, and
  CLI parity for the complete trusted session contract.

## Outcome

Library and CLI users can create, list, open, resume, mutate, review, validate, undo, redo, discard,
and close persistent sessions without Workbench. Every successful state transition is atomically
persisted. The maintained extension consumes a browser-safe client contract over an injected host
transport, while Workbench remains replaceable.

## Work

1. Add an Effect-based `AuthoringSessionService` with typed configuration, failures, spans, and
   operations for create/open/resume/list/close. Resolve storage from explicit configuration or a
   documented project/user data policy; callers never coordinate arbitrary raw paths.
2. Persist contract and fingerprint versions, project identity, base authority/provenance, pending
   operation state, receipts, and updated-at evidence. Add migrations, corruption quarantine,
   atomic replacement, restart recovery, and serialized mutation per session.
3. Keep `foldTable`, diff, validation, and command construction pure. Add safe intent builders for
   Set Cell, Add, Duplicate, Remove, Rename, and Reorder. Validate a whole gesture group against the
   schema and working state before append; never persist half a batch.
4. Return discriminated failures with recovery for duplicate/invalid row names, incompatible values,
   missing fields, stale fingerprints, invalid permutations, malformed sessions, and unsupported
   edits. Semantic warnings remain review diagnostics, not structural acceptance.
5. Add derived view models for working tables, dirty cells/rows, command groups, diff/review,
   diagnostics, undo/redo availability, and Draft/Applied/Saved pipeline state.
6. Define the narrow trusted client contract and runtime schemas. It exposes scoped session reads and
   intents, not filesystem paths, arbitrary Unreal calls, or renderer-owned mutation authority.
7. Move all CLI draft commands onto the service and add list/resume/review/validate/diff/discard.
   Preserve machine-readable JSON and make CLI/UI behavior share the same services.
8. Make Workbench main/preload a validated transport adapter for that public service. Do not embed
   domain transitions in Electron handlers.

## Tests and verification

Add cheap tests for every command boundary and inverse, grouped append atomicity, undo-tail discard,
multi-table sessions, autosave after each transition, concurrent calls, migration, corrupted/truncated
files, restart recovery, and CLI parity. Test route clients against a fake public service rather than
mocking Electron internals.

- `pnpm exec vitest run packages/authoring/src apps/cli/src`
- `pnpm ue-shed authoring sessions list --project fixtures/unreal-project`
- create a fixture draft, restart the command, then show/review/undo/redo it successfully
- `pnpm --filter @ue-shed/workbench build`
- `pnpm check`

## STOP conditions

- Any renderer or Workbench-only store becomes the canonical command log.
- A transition can report success before durable persistence completes.
- Existing drafts are overwritten when migration or decoding fails.
- Immediate type compatibility depends on converting rich values through JSON strings or JavaScript
  numbers.

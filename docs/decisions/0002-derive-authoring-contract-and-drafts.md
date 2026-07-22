# 0002: Derive authoring producers and drafts from shared contracts

- **Status:** Accepted
- **Date:** 2026-07-14
- **Updated:** 2026-07-22 (Plan 022 public-contract hardening)

## Context

Read-only authoring can inspect saved Unreal packages without an editor. Live authoring can inspect
unsaved editor memory and mutate it through a separately enabled companion. If these sources define
independent table models, every domain feature must translate and reconcile both representations.

Draft editing also needs a durable model that supports review, undo, conflicts, transactional Apply,
and separate Save without making a renderer authoritative.

The same authority question appears wherever TypeScript and C++ share a wire shape, including Map
Review capture and selection messages.

## Decision

Define one language-neutral authoring contract for schemas, authority-tagged snapshots, typed values,
unsupported values, and semantic fingerprints. The saved-package reader and Unreal companion derive
their authoring output from that contract. TypeScript runtime schemas and types derive from it as
well.

Drafts are a persistent ordered log of five typed command kinds: Set Cell, Add Row, Remove Row, Rename
Row, and Reorder Rows. Commands capture enough prior data for pure inversion. Working state is folded
from the active command prefix over recorded base snapshots. The headless authoring service owns
folding, validation, persistence, Apply, and Save state.

Apply accepts a bounded, potentially multi-table plan under one editor transaction. Semantic
fingerprints protect the base. Stable operation IDs and result lookup handle transport uncertainty
without automatic mutation replay. Apply and Save create separate durable receipts.

### Authority order for shared wire contracts

1. Checked-in language-neutral JSON Schema under `packages/protocol/contracts/…`, plus fixtures.
2. Conformant Effect Schema codecs and derived TypeScript types.
3. Rust and/or C++ producers with fixture or trusted-engine evidence.
4. Consumers only after producers pass.

Do not generate the JSON Schema from TypeScript.

### Recursive Effect Schema exception

`Schema.suspend` codecs that need a type parameter (authoring `AuthoringValue` /
`AuthoringTypeDescriptor` and their field wrappers) may keep a narrow manual type declaration. Every
retained exception must stay bidirectional with the suspend body through compile-time equality
assertions and decode/encode fixtures. Manual recursive types are a defended boundary, never a
shortcut for ordinary public records.

### Map Review

Stable editor wire messages for capture request/response and selection / subject-inspection live under
`packages/protocol/contracts/cameras/review`. Portable Review Set persistence and Workbench IPC remain
TypeScript-owned Effect schemas until unfinished Map Review slices stop changing those surfaces.

### Check commands

| Gate                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Authoring JSON ↔ Effect      | `pnpm --filter @ue-shed/protocol contract:check`                        |
| Map Review fixture parity    | `pnpm --filter @ue-shed/cameras contract:check`                         |
| Both portable contract gates | `pnpm contract:check` (also part of `pnpm check`)                       |
| Trusted Unreal evidence      | `pnpm check:unreal` (includes Map Review wire evidence when RC is live) |

## Consequences

- Project-files and live-editor modes have equal authoring shapes but distinct authority and
  capabilities.
- Parser-specific package evidence and companion transport details remain outside the authoring
  payload.
- Structured fields and containers begin as complete typed cell values; nested commands require
  demonstrated need.
- Session files require explicit contract, fingerprint, and persistence versions plus atomic writes.
- Invalid folds, partial decoding, drift, and indeterminate Apply outcomes are typed states, not
  silent fallbacks.
- Renderers and trusted host clients draft through the same public service and receive no Apply or
  Save authority implicitly.
- Cross-language Map Review capture/selection messages follow the same JSON-first authority as
  authoring; TypeScript-only review documents do not pretend to be C++ wire contracts.

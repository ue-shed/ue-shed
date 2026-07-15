# Plan 009: Make schemas and typed errors the only application contracts

> **Executor instructions**: Execute every step and gate in order. Update `plans/README.md` when
> complete. Stop rather than inventing a wire representation.
>
> **Drift check (run first)**: `git diff --stat 2f7ac8b..HEAD -- packages/protocol packages/authoring-sdk packages/authoring packages/cameras packages/unreal-assets packages/unreal-connection packages/asset-audits packages/game-text apps/workbench/src/renderer extensions`

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH — these types cross saved files, IPC, CLI JSON, and TypeScript/C++ contracts
- **Depends on**: Plan 008
- **Category**: migration
- **Planned at**: commit `2f7ac8b`, 2026-07-16

## Why this matters

UE Shed already has 233 `Schema.Struct` and 34 `Schema.Union` sites, but important public contracts
remain handwritten, duplicated, or throwing. Effect-core architecture needs schema-owned values and
typed failures before services are introduced; otherwise layers merely inject loosely defined APIs.

## Current state

- `packages/protocol/src/index.ts:1-102` hand-rolls branded identifiers, throwing constructors,
  `ProtocolVersion`, capability records, and `ConnectionState`.
- `packages/unreal-connection/src/index.ts:24-38` uses a sync decoder and `Data.TaggedError`.
- `packages/authoring/src/session-service.ts:34-107` has schema-owned documents but five
  `Data.TaggedError` classes.
- `extensions/data-authoring/src/authoring-route.tsx:20-68` defines renderer result unions and a
  Promise client by hand; `apps/workbench/src/renderer/authoring-client.ts:11-45` defines a second
  schema for part of the same contract.
- `extensions/camera-review/src/map-review-client.ts:1-115` is an entirely handwritten IPC/client
  contract.
- Production source has 20 `Data.TaggedError` and zero `Schema.TaggedErrorClass` sites.

The language-neutral authoring contracts under `packages/protocol` remain authoritative where C++
shares the wire. Their encoded JSON must not change.

## Commands you will need

| Purpose              | Command                                          | Expected on success    |
| -------------------- | ------------------------------------------------ | ---------------------- |
| Protocol conformance | `pnpm --filter @ue-shed/protocol contract:check` | exit 0                 |
| Typecheck            | `pnpm typecheck`                                 | exit 0                 |
| Fast tests           | `pnpm test:fast`                                 | all enabled tests pass |
| Full gate            | `pnpm check`                                     | exit 0                 |

## Scope

**In scope**: TypeScript-owned data/error definitions in `packages/protocol`, `authoring-sdk`,
`authoring`, `cameras`, `unreal-assets`, `unreal-connection`, `asset-audits`, `game-text`; duplicated
IPC result contracts in Workbench renderer and extensions; their tests and exports.

**Out of scope**: service tags/layers, app runtime composition, C++ wire definitions, new product
fields, rich-value work from Plan 007.

## Steps

### Step 1: Convert identifiers and ordinary records

Replace manual identifier brands with constrained Effect Schema brands and expose trusted
constructors plus effectful unknown decoders. Convert handwritten reusable records/unions to
`Schema.Struct`, `Schema.TaggedStruct`, or `Schema.TaggedUnion`, deriving decoded types from the
schema. Preserve external discriminator names such as `status` and `kind`; do not force `_tag` onto
existing wire JSON.

For internal control-flow-only variants, use `Data.TaggedEnum`. Do not create schemas merely for
matching helpers.

**Verify**: protocol tests prove identifiers reject blank input and all existing encoded fixtures are
byte-for-byte semantically equivalent.

### Step 2: Replace application errors

Convert expected errors to `Schema.TaggedErrorClass` with stable tags and structured fields. Include
operation, safe identifiers, retry safety, completion/indeterminate state, and recovery guidance
where the owning boundary knows them. Preserve defects for broken invariants only.

Do not expose raw `message: String(cause)` as the decision surface. UI/CLI adapters may render error
text, but branch on tags/reasons.

**Verify**: `rg -n "Data\.TaggedError|class .* extends Error" packages -g '*.ts'` contains only
reviewed non-application exceptions, documented in the architecture allowlist.

### Step 3: Make unknown decoding effectful

Replace exported sync decoders used at JSON, file, process, Unreal, IPC, CLI, and UI boundaries with
`Schema.decodeUnknownEffect` or schema `.makeEffect`. Keep sync construction only for trusted
constants, tests, or proven hot startup paths where throwing is explicitly the contract.

Map parse failures into the owning typed error instead of catching arbitrary exceptions later.

**Verify**: malformed IPC, reader output, stored session, and Remote Control payload tests assert the
typed error channel.

### Step 4: Establish one IPC DTO authority

Move authoring and map-review request/result DTOs to their public SDK/domain owner. Derive renderer
types and decoders from those schemas. Delete the duplicate catalog schema and manual record guards
in `apps/workbench/src/renderer/authoring-client.ts`. Preload/global declarations import types from
the schema owner and do not redefine shapes.

Keep transport results distinct from domain errors where Electron serialization requires it, but
derive both from schemas and map between them once.

**Verify**: one search result owns each DTO schema; component and Workbench E2E tests still observe
the same statuses and error fields.

## Test plan

- Add round-trip and malformed-input tests for each converted schema family.
- Keep `packages/protocol/src/authoring.test.ts` conformance against checked-in JSON Schema.
- Add explicit tests that different branded IDs are not assignable.
- Test error encode/decode only for errors that cross IPC/persistence; internal errors need typed
  failure assertions, not gratuitous serialization.

## Done criteria

- [x] Reusable application records and variants are schema-owned.
- [x] Expected application errors use `Schema.TaggedErrorClass`.
- [x] Unknown production inputs decode in Effect rather than throw.
- [x] IPC DTOs have one schema authority.
- [x] Language-neutral wire encodings are unchanged.
- [x] `pnpm check` exits 0.

## STOP conditions

- A TypeScript/C++ contract lacks enough evidence to preserve its encoded form.
- Two existing consumers rely on incompatible encodings hidden behind one TypeScript type.
- Conversion requires casts to bypass schema validation.

## Maintenance note

Future fields must be added to the owning base schema and derived into related contracts. Do not
restore interface/schema pairs that can drift.

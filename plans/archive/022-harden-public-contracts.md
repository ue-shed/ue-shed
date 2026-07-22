# Plan 022: Make public TypeScript and Map Review contracts schema-governed

> **Executor instructions**: Read docs/README.md, the authoring contract README, and the Effect skill before editing. Preserve language-neutral schema authority. Run every check and update plans/README.md when done.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- packages/protocol packages/cameras unreal/Plugins/UEShedCameras docs/decisions/0002-derive-authoring-contract-and-drafts.md docs/products/map-review.md package.json

## Status

- **Priority**: P0
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 020
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22
- **Completed**: 2026-07-22 — recursive authoring exceptions asserted; Map Review capture/selection
  fixture parity in `pnpm check`; UEShedCameras wire evidence wired into `pnpm check:unreal`

## Why this matters

Most exported UE Shed contracts derive their TypeScript type from an Effect runtime schema. Recursive authoring values/descriptors are intentional exceptions because Schema.suspend needs a type parameter. Map Review is schema-first in TypeScript but has no authoring-equivalent language-neutral conformance gate. Before packages become public, each exception must be explicit, tested, and unable to silently drift across TypeScript, Rust, and C++.

## Current state

- packages/protocol/src/authoring.ts declares recursive AuthoringValue and descriptors before Schema.suspend codecs.
- packages/protocol/contracts/authoring is the language-neutral authority. Its README requires JSON schema first, Effect second, then Rust/C++ producers; package script contract:check enforces it.
- packages/cameras/src/review-schema.ts derives most types through Schema.Schema.Type, and review-ipc.ts consumes those values.
- Map Review has no checked-in language-neutral schema nor split portable/Unreal parity gate
  comparable to authoring.
- Internal Effect service ports may remain plain TypeScript. This plan applies only to external input, persisted/public/IPC values, and cross-language wire contracts.

## Commands you will need

| Purpose                  | Command                                         | Expected on success             |
| ------------------------ | ----------------------------------------------- | ------------------------------- |
| Authoring parity         | pnpm --filter @ue-shed/protocol contract:check  | Exit 0                          |
| Targeted tests           | pnpm test -- packages/protocol packages/cameras | All selected tests pass         |
| Typecheck                | pnpm typecheck                                  | Exit 0                          |
| Full gate                | pnpm check                                      | Exit 0                          |
| Unreal boundary evidence | pnpm check:unreal                               | Exit 0 on trusted UE 5.7 runner |

## Scope

**In scope**

- packages/protocol/src/authoring.ts, tests, contracts, contract scripts, and package.json
- packages/cameras/src/review-schema.ts, review-ipc.ts, and review wire tests
- A new packages/protocol/contracts/cameras/review authority and fixture suite
- UEShedCameras only at a reviewed wire serialization boundary
- ADR 0002 and the Map Review product contract

**Out of scope**

- Redesigning Map Review behavior or unfinished Slice 2/3 state.
- Generating JSON Schema from TypeScript.
- Replacing every private helper type with Schema.
- Breaking contract versions without an approved migration.

## Steps

### Step 1: Inventory public contract ownership

List every exported protocol/camera wire value as derived schema, recursive exception with a compile-time conformance assertion, or JSON-authoritative value with fixture parity. Add an automated assertion for every retained manual recursive declaration.

**Verify**: no manually declared public wire type lacks a named, tested reason.

### Step 2: Tighten authoring recursive exceptions

Derive types where Effect can infer them. Where recursive codecs genuinely require manual declarations, retain only the narrow declaration and add bidirectional compile-time plus decode fixtures. Keep checked-in JSON schema authoritative.

**Verify**: pnpm --filter @ue-shed/protocol contract:check exits 0.

### Step 3: Add Map Review cross-language parity

Define only the stable public review/session/IPC wire surface under packages/protocol/contracts/cameras/review. Add valid and invalid fixtures plus a portable checker comparing JSON and Effect decode/encode. Add the portable checker to the root gate and the UEShedCameras serialization evidence to the trusted Unreal lane.

**Verify**: an invalid fixture is rejected by the portable checker and the Unreal boundary suite passes.

### Step 4: Record the rule

Update ADR 0002 and docs/products/map-review.md with the authority order, recursive exception rule, and exact check commands.

**Verify**: pnpm typecheck and pnpm check exit 0.

## Test plan

- Existing authoring JSON parity stays green.
- Compiler-level assertions and decode fixtures cover every retained recursive exception.
- Map Review valid/invalid fixtures cover JSON and Effect; the trusted Unreal suite covers C++ serialization.
- Existing review wire tests remain green.

## Done criteria

- [x] No new public wire type is manually duplicated without a documented tested exception.
- [x] Map Review has authoritative schemas, fixtures, and a portable JSON/Effect parity command.
- [x] The JSON/Effect check runs from pnpm check and C++ serialization evidence runs from pnpm check:unreal.
- [x] pnpm check exits 0.
- [x] plans/README.md marks Plan 022 DONE.

## STOP conditions

- A schema would freeze a behavior still under active Plans 017, 018, or 019.
- Effect cannot retain required recursive validation and type fidelity.
- C++ conformance needs a machine-specific engine path in a portable gate.
- Work requires an unapproved breaking contract migration.

## Maintenance notes

For new cross-language values: JSON schema, fixtures, Effect schema, producers, then consumers. A manual recursive type is a defended boundary, never a shortcut.

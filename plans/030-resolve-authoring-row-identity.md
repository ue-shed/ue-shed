# Plan 030: Resolve `AuthoringRow` identity provenance

> **Executor instructions**: This is a decision plan, not an implementation plan. Produce a decision
> record first. Do not change `AuthoringRow`, `foldTable`, `diffAuthoringTable`, or any `rowId`
> consumer until the fork below is answered and the record is accepted.
>
> **Drift check (run first)**: re-verify the evidence table against `packages/protocol/src/authoring.ts`,
> `packages/authoring/src/draft.ts`, `packages/authoring/src/session-service.ts`, and
> `packages/authoring/src/review.ts`. Confirm no read path minting row ids has landed since
> commit 673289e — if one has, its id derivation supersedes the "no read path" finding and this plan
> must be re-scoped before proceeding.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MEDIUM
- **Depends on**: none — decide _before_ Plan 007 adds further `rowId` consumers
- **Category**: direction
- **Planned at**: commit 673289e, 2026-07-25

## Why this matters

`AuthoringRow.id` advertises a stable row identity. Unreal DataTables cannot supply one: rows are
`TMap<FName, uint8*> RowMap` (`Engine/Source/Runtime/Engine/Classes/Engine/DataTable.h:98`), so the
row name _is_ the engine's identity and a rename is a re-key. `foldTable` and `diffAuthoringTable`
are written as if the id were sound.

Two id spaces exist today and do not reconcile: session-created rows get
`` `draft-row:${ids.generate()}` `` while rows read from the engine have no defined id at all. The
consequence is that a row's id does not survive the apply → re-read round trip, and no future read
path can fix that, because the information does not exist in the source.

`joined-views.ts` and `relationships.ts` already key their contracts on `rowId`. Cross-table joins
keyed on an unstable identity silently associate the wrong rows — a worse failure than an incorrect
diff, and harder to detect. Every module added before this decision is more to unwind.

## Current state

- `AuthoringRow = { id: Schema.String, name: Schema.String, fields }` — untyped strings, no
  provenance (`packages/protocol/src/authoring.ts:118`).
- Every builder takes `rowId` as caller input; none derives it from engine data
  (`draft.ts:627,648,675`).
- New rows: `draft-row:<generated>` (`session-service.ts:977,1001`).
- **No read-path id minting exists in non-test code.** Only test fixtures hand-write `"row:Alpha"`.
  `packages/game-text/src/corpus.ts:199` uses `row:${row.name}` but that is an unrelated
  text-location key.
- Consumers assume soundness: `draft.ts:196,230` match `row.id === body.rowId`; `review.ts:135-136`
  keys `baseById`/`workingById`.
- `rename_row` mutates `name`, preserves `id` (`draft.ts:230-238`).
- Package is `private: true`, `version: 0.0.0`, no external consumers — no compatibility pressure.

## Commands you will need

| Purpose                          | Command                                                              | Expected on success               |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------- |
| Find every `rowId` consumer      | `grep -rn "rowId\|row\.id" packages/ --include=*.ts \| grep -v test` | complete blast-radius list        |
| Confirm no read-path minting     | `grep -rn "id: " packages/ --include=*.ts \| grep -v test`           | only `draft-row:` sites appear    |
| Check for level authoring intent | `grep -rniE "actor.?guid\|instance.?guid" packages/ crates/`         | decides the fork in Step 1        |
| Run authoring package tests      | `pnpm --filter @ue-shed/authoring test`                              | green before and after any change |

## Scope

**In scope**

- A decision record answering the fork and naming the chosen option.
- A complete blast-radius list of `rowId` consumers.
- Under option (B): the provenance representation design.

**Out of scope**

- Changing `diffAuthoringTable`'s value-derived comparison, the strict `foldTable` checks, `groupId`
  command groups, `ApplyReceipt`/`SaveReceipt`, or `decodeDraftSessionWithMigration`. These were
  assessed as sound and are identity-independent. Do not touch them.
- Removing `draft-row:<uuid>`. `buildDuplicateRowCommand` legitimately needs to distinguish "same
  name, different row" transiently; a session-local temp handle is the right tool. The flaw is
  generalizing it into a claimed stable identity on _every_ row.
- Any change to the downstream Electron host. Its plan is settled and deliberately independent
  (see Stipulations in that repo's `docs/authoring-diff-hardening-plan.md`).

## Steps

### Step 1: Answer the fork

Determine whether this authoring interface must cover asset types that have real identity. Level
actors carry stable actor GUIDs; DataTable rows do not. Check `packages/authoring/`, `plans/`,
`docs/`, and the parser crates for level _authoring_ intent, not merely level parsing.

- **If DataTable-shaped** → option **(A) collapse**: set `id = name`, stop claiming an identity the
  source cannot supply.
- **If it must span identity-bearing assets** → option **(B) tag**: keep a uniform abstraction but
  make provenance explicit, so a consumer cannot use an id without knowing its origin. DataTables set
  `id = name`; levels set `id = actorGuid`.

**Verify**: the record names which asset types are in scope and cites where that scope is defined,
not an assumption.

### Step 2: Map the blast radius

List every module and wire contract consuming `AuthoringRow.id`. Start from `joined-views.ts`,
`relationships.ts`, `session-service.ts`, `review.ts`, `draft.ts`,
`packages/protocol/src/authoring.ts`, and `authoring-review.ts`. Mark each as mechanical, semantic,
or wire-breaking.

**Verify**: no consumer is discovered after the record is accepted.

### Step 3: Design the representation (option B only)

Prefer a branded or tagged union over `Schema.String`, so an engine-backed handle and a session-local
handle are not interchangeable at the type level. Specify what `foldTable` and `diffAuthoringTable`
do when handed a session-local id — including whether a `draft-row:` id may ever appear in a diff
against a re-read base.

**Verify**: a test asserts that a session-local id cannot be silently consumed where an engine-backed
one is required.

### Step 4: Prove or refute the round trip

If any read path exists by this point, add a throwaway probe that adds a row, applies, re-reads, and
compares ids. Record the result in the decision record and delete the probe.

**Verify**: the round-trip claim is settled by evidence, not inference.

## Done criteria

- [ ] Decision record accepted, naming option (A) or (B) with reasoning and cited scope.
- [ ] Complete `rowId` blast-radius list, each entry classified.
- [ ] Under (B): provenance representation specified and type-level separation tested.
- [ ] Round-trip behavior settled by probe or explicitly recorded as untestable until a read path lands.
- [ ] `diffAuthoringTable`, strict `foldTable`, `groupId`, receipts, and session migration are unchanged.

## STOP conditions

- Step 1's scope question cannot be answered from a written source — escalate rather than assume.
- A read path minting row ids has landed since 673289e — re-scope this plan against its derivation.
- The change would require touching the downstream Electron host before its Plan 029 gate opens.
- Implementation is proposed before the decision record is accepted.

## Maintenance notes

The value of acting early is only that each `rowId` consumer added first is more to unwind — there is
no external compatibility pressure while the package stays `0.0.0` and private. If Plan 007 is about
to add editable joins or further relationship contracts keyed on `rowId`, resolve this first.

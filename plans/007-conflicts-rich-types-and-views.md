# Plan 007: Complete conflicts, rich Unreal types, composites, and views

> **Executor instructions**: Split implementation into reviewable vertical commits, but preserve the
> dependency order below. Do not claim a field family writable until its real-Unreal round trip is
> green. Update `plans/README.md` when done.
>
> **Drift check**: `git diff --stat 52df5c0..HEAD -- packages/authoring packages/protocol packages/unreal-assets unreal/Plugins/UEShedAuthoring fixtures extensions/data-authoring apps/cli apps/workbench`

## Status

- **Priority**: P1
- **Effort**: XL (several multi-day vertical slices)
- **Risk**: HIGH — merge semantics and rich serialization can lose authored meaning if guessed
- **Depends on**: Plans 006 and 015
- **Planned at**: commit `52df5c0`, 2026-07-15

## Outcome

UE Shed reaches the intended maintained-editor scope: explicit concurrent-change resolution, common
Unreal field families, Composite DataTables, polished keyboard/search workflows, annotations, and
reusable filtered/joined views. It still does not host arbitrary custom UIs.

## Ordered slices

### 1. Three-way drift and conflicts

Implement pure base/draft/live diffs and discriminated conflict types for cell edits, row add/remove,
rename, and reorder. Rebase unrelated live changes without losing either side. Persist explicit
resolution state and commands for choosing draft/live values; refresh and retry only after every
conflict is resolved. Add exhaustive table-driven pure tests before the UI.

### 2. Lossless and structured value editing

- Replace the current `FText::ToString` / `FText::FromString` path with a versioned, lossless Unreal
  text representation preserving namespace, key, and history where available.
- Add enum controls, vectors/common structs, asset/object and row-reference pickers, arrays, sets,
  maps, and nested structs through dedicated editors. Preserve exact integer and special-float
  semantics throughout.
- Honor read-only, deprecated, clamp, step, unit, description, and reference-target metadata.
- Unknown/opaque values stay visible and round-trippable but read-only. Never reconstruct an entire
  row from only the fields the editor understands.

Each family needs codec tests, session/restart tests, saved/live parity, and a real `Apply -> Save ->
reload` fixture test before becoming editable. Expand the real matrix beyond `DT_Scalars` to every
declared fixture family.

### 3. Composite DataTables

Expose ordered parents and effective/overridden provenance. Route edits to an explicitly writable
source parent; never mutate an effective composite row ambiguously. Test parent precedence, override
creation/removal, read-only parents, drift, rollback, and Save across affected packages against real
UE 5.7 behavior.

### 4. Reusable views and product finish

Add named filter/sort/column views first, then joined read-only views over public catalog/session
data. A joined surface may draft only when one source table/row/field is unambiguous; otherwise it is
read-only with guidance. Views contain presentation/query state, never duplicate canonical drafts.
Add deep focus, column sizing, row detail, large-table performance budgets, accessible keyboard
navigation, and clear authority/capability/conflict/pipeline states.

### 5. Release conformance

Add browser component tests and a small Electron fixture E2E for discover → edit → restart → review
→ drift → resolve → Apply → Save. Expand fixture verification to compare checked-in semantic
snapshots, stable set/map canonicalization, metadata, localized text identity, parents, and overrides.
Update the conformance ledger only with commands that actually prove each status.

## Verification

- exhaustive pure conflict/diff/codec suites
- `pnpm fixture:generate && pnpm fixture:verify`
- saved/live parity suite for every fixture table
- the real-Unreal authoring matrix, including localized text and composites
- Workbench production build and Electron fixture E2E
- CLI validate/diff/resolve/apply/save parity tests
- `pnpm check`

## Done criteria

All ten steps in `docs/products/data-authoring.md` are executable through public services and the
maintained extension; CLI covers discovery, inspection, validation, diff, Apply, and Save; every
writable field family is engine-proven; drift never becomes silent last-writer-wins; Draft, Applied,
and Saved survive restart and remain visibly distinct; deleting Workbench leaves the library and CLI
workflow intact.

## STOP conditions

- A conflict algorithm cannot preserve both base-relative intentions deterministically.
- A rich type requires lossy serialization or unverified Unreal behavior.
- A joined/composite edit cannot identify one authoritative target.
- Product code introduces studio-specific schemas, paths, roles, source-control policy, or assets.
- Scope expands into arbitrary custom UI isolation, grants, publishing, or generated interfaces.

# UE Shed core parser swap (2026-09-19)

The optimized source-model parser works through current main's UE Shed consumers when deployed
with its matching protocol and Game Text updates. Replacing only the native executable fails the
older consumers' strict wire validation. No additional Rust parser fix was needed.

## Trial

Snapshot main at `09d3797` plus its current uncommitted work into an isolated detached checkout.
Preserve and hash all 1,651 source files. Install its locked dependencies and build its TypeScript
packages. Keep its existing 71 fixture packages and its own test suite.

Build main's original native binary from that snapshot. Compare it with the optimized `f9ff76f`
binary using the supported `UE_SHED_UASSET_EXECUTABLE` override. `scripts/test.ts` honors this
override, so the replacement is used by real CLI processes, scoped reader workers, project scans,
Data Authoring, Game Text, Blueprint, saved-world, and Project Index consumers.

The experiment's inspection, project IO, Blueprint, and WASM entry points already supply the embedded
engine source model. This trial specifically checks integration with current main's consumers and
dependencies, rather than repeating only the experiment branch's tests.

## Findings

| Trial                                     | Result                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing binary and existing consumers    | 1,161 passed, 3 failed, 48 skipped; the three failures were a missing Windows supervisor artifact in the fresh checkout. After assembling it, all 10 supervisor tests passed. |
| Replacement binary and existing consumers | 1,147 passed, 17 failed, 48 skipped. Three failures were the same setup issue; 14 were swap compatibility failures.                                                           |
| Replacement binary and matching consumers | 1,164 passed, zero failed, 48 opt-in integration tests skipped in one complete run.                                                                                           |

The binary-only failures came from rejecting package metadata and the newly supported string-table
text identity at strict protocol boundaries. The paired implementation updates already on the
experiment branch were applied to the isolated checkout:

- `packages/protocol/src/uasset-inspection.ts` and the authoritative
  `packages/protocol/contracts/uasset-io/v1/event.schema.json`.
- `packages/game-text/src/corpus.ts` and `packages/game-text/src/schema.ts`, including native/instanced
  value traversal and string-table identities.
- `extensions/game-text/src/game-text-view.ts`, so the UI can label a string-table identity.

The language-neutral schema conformance test caught the missing JSON schema companion. Repository
type checking caught the old UI label formatter's assumption that every non-localized identity had
an unresolved reason. Both passed after including their matching files.

Two existing test expectations also needed the intended coverage improvement: the CLI text review
and Game Text fixture now report complete coverage. The same 71 packages produce 38 text units and
39 occurrences, with no unsupported text properties. The fixture test additionally verifies the
recovered table/key identity and its original property location.

## Verification

- Complete current-main TypeScript/component suite: **1,164 passed, 48 opt-in tests skipped**.
- Repository-wide type checking, including Workbench: passed.
- Lint and formatting for the seven migration files: passed.
- Current main's WASM wrappers with the replacement generated payload: native parity for nine
  fixtures, compact text/texture projections for two fixtures, Blueprint and Level Sequence coverage,
  and typed failure/resource-limit checks passed.
- Real Chromium WASM smoke test: passed.

The Rust implementation is unchanged from the optimized branch, whose full `pnpm check` and fresh
Unreal conformance results are recorded in the [performance report](uasset-source-model-performance-2026-09-19.md).
This trial did not rerun opt-in live-editor or Perforce integrations. It did not replace binaries or
source files in the original main checkout; every snapshotted original file retained its hash.

## Reproduce or inspect locally

Ignored `out/source-codegen/core-swap/` contains the isolated `main/` checkout, source hash manifest,
both executables, JSON test reports, typecheck/WASM logs, and `consumer-migration.patch`. The patch
contains only the seven consumer/contract/test changes relative to the original working files. Its
forward application was checked against main and reverse application against the tested checkout.

From the isolated checkout, with the repository's Node/pnpm toolchain available:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = (Resolve-Path ../source-model-f9ff76f.exe).Path
pnpm test
pnpm typecheck
node scripts/test-uasset-wasm.ts
node scripts/test-uasset-wasm-browser.ts
```

Keep the parser, protocol schemas, and affected consumers together when promoting this branch.
The public schema version alone does not make a newer producer compatible with an older strict
decoder that rejects additional fields or union variants.

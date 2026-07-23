# Plan 023: Separate HyperFormula and establish an MIT distribution boundary

> **Executor instructions**: Treat license conclusions as release-blocking. Coordinate the Peculiar Sheets source change before updating UE Shed. Do not state that HyperFormula itself is MIT. Update plans/README.md only after both repositories have evidence.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- extensions/data-authoring package.json pnpm-lock.yaml docs/decisions/0005-gate-peculiar-sheets-and-defer-custom-authoring-ui.md docs/vision-and-architecture.md README.md

## Status

- **Status**: DONE on 2026-07-23
- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plan 020
- **Category**: migration
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

UE Shed is intended to be MIT-licensed and public. Data Authoring currently depends on peculiar-sheets 0.9.1, whose current distribution directly depends on HyperFormula. HyperFormula is dual GPLv3 or commercial, so ownership of Peculiar Sheets does not permit relicensing HyperFormula. The dependency graph, not whether formula UI is visible, is the release gate.

## Current state

- extensions/data-authoring/package.json declares peculiar-sheets 0.9.1.
- The grid imports Sheet, rowId, types, and styles; UE Shed does not need formula evaluation.
- The current Peculiar Sheets package brings HyperFormula transitively.
- Root and workspace packages are private and there is no root MIT license/public release policy.
- ADR 0005 deferred formulas and made external distribution a gate.

## Commands you will need

| Purpose               | Command                                                                  | Expected on success                |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| External core tests   | pnpm --dir <peculiar-sheets-checkout> test                               | Exit 0                             |
| Pack core             | pnpm --dir <peculiar-sheets-checkout> pack --pack-destination <temp-dir> | Core manifest has no HyperFormula  |
| Inspect UE Shed graph | pnpm why hyperformula                                                    | No UE Shed production path remains |
| UE Shed gate          | pnpm check                                                               | Exit 0                             |

## Scope

**In scope in Peculiar Sheets**

- Split MIT grid core from formula evaluation.
- Publish MIT core with no HyperFormula dependency/import.
- Keep any HyperFormula integration in a separately named, GPL-licensed optional adapter.
- Add an MIT license only for code its owner authorizes.

**In scope in UE Shed**

- Upgrade to the exact MIT core release and refresh pnpm-lock.
- Add root MIT LICENSE and accurate public-release documentation.
- Update ADR 0005 and adoption docs.
- Add a packed-dependency/release check that rejects HyperFormula from distributable UE Shed artifacts.

**Out of scope**

- Relicensing HyperFormula, bundling it in MIT artifacts, or adding formulas.
- Publishing UE Shed packages; that is Plan 025.
- Treating a GPL showcase as a normal public release.

## Steps

### Step 1: Split at the source

Move formula imports, types, initialization, and tests behind an optional adapter. Preserve the core grid API UE Shed uses without installing HyperFormula. Test the packed core artifact, not only source imports.

**Verify**: a fresh temporary consumer installs the packed core and npm ls hyperformula reports no dependency.

### Step 2: Release the MIT core lawfully

The authorized copyright holder tags/publishes a concrete MIT core version. Its public metadata and release notes identify it as formula-free. Any formula adapter stays separately licensed.

**Verify**: npm view <core-package>@<version> license reports MIT and dependencies omit HyperFormula.

### Step 3: Remove the GPL path from UE Shed

Pin the exact core version, remove the transitively GPL path, add the root license, revise ADR/release/adoption text, and add a deterministic dependency check.

**Verify**: pnpm why hyperformula finds no production path and pnpm check exits 0.

## Test plan

- Peculiar Sheets core tests and packed-manifest inspection.
- UE Shed dependency check fails on a reintroduced formula engine.
- Existing Data Authoring component and adoption tests pass.

## Done criteria

- [x] Core is MIT by authorized decision and has no HyperFormula dependency.
- [x] Formula integration, if retained, is optional and absent from UE Shed.
- [x] UE Shed root license/release docs accurately say MIT.
- [x] pnpm why hyperformula finds no distributable UE Shed path.
- [x] pnpm check exits 0.
- [x] plans/README.md marks Plan 023 DONE.

## Completion evidence

- Registry metadata reports `peculiar-sheets@0.11.0` as MIT with no formula-engine dependency.
- UE Shed pins that exact core release and `pnpm license:check` rejects HyperFormula, the IronCalc
  adapter, or IronCalc WASM on any production path.
- The root MIT license and amended ADR 0005 describe the actual distribution boundary.
- Data Authoring adoption conformance passes from a fresh materialized host against all 12 fixture
  tables.
- `pnpm check` passes on the canonical integration branch.

## STOP conditions

- Core cannot retain its required API without HyperFormula.
- Copyright authorization is unclear.
- The supposedly formula-free core still depends on HyperFormula.
- Formula removal breaks a documented UE Shed requirement.

## Maintenance notes

Review packed dependency and license manifests at every release. Source-level absence alone is not legal-release evidence.

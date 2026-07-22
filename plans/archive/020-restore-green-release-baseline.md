# Plan 020: Restore a trustworthy portable release baseline

> **Executor instructions**: Follow this plan in order. Run every verification command. If a STOP condition occurs, stop and report rather than changing fixture data or weakening a test. Update the plan index when done.
>
> **Drift check (run first)**: git diff --stat a1df704..HEAD -- packages/unreal-assets/src/fixture.integration.test.ts fixtures/unreal-project/FixtureSource/Authoring/DT_Scalars.json fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset fixtures/unreal-project/fixture-contract.json package.json

## Status

- **Priority**: P0
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit a1df704, 2026-07-22

## Why this matters

The root check currently fails because the inspected saved asset reports Count 80 while the fixture assertion expects 7. Every CI and release result is ambiguous until the saved asset, fixture source, contract, and assertion have one engine-evidenced value. Fix the evidence, not the parser to fit a stale assertion.

## Current state

- packages/unreal-assets/src/fixture.integration.test.ts asserts the first DT_Scalars row, including Count.
- fixtures/unreal-project/FixtureSource/Authoring/DT_Scalars.json currently declares Count 7.
- The checked-in uasset is the input under test. It and Unreal-generated evidence determine whether source data or only the assertion is stale.
- Root package.json defines pnpm check, including Rust, TypeScript, architecture, adoption, lint, format, and tests. The product remains headless-first.

## Commands you will need

| Purpose       | Command                                                                                            | Expected on success                 |
| ------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Inspect asset | pnpm ue-shed authoring inspect fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset | Reports Count without parse failure |
| Focused test  | pnpm test -- packages/unreal-assets/src/fixture.integration.test.ts                                | All tests pass                      |
| Full gate     | pnpm check                                                                                         | Exit 0                              |

## Scope

**In scope**

- packages/unreal-assets/src/fixture.integration.test.ts
- Fixture source, uasset, and fixture-contract only through the documented generation flow if engine evidence proves they are stale.

**Out of scope**

- Parser decoding changes merely to make the expected number appear.
- Broad fixture regeneration, package publishing, or CI work.

## Git workflow

- Branch feature/020-green-release-baseline from the temporary branch.
- Use a conventional test or fixture commit. Do not merge, push, or target main during the judging freeze.

## Steps

### Step 1: Establish the authoritative value

Inspect JSON source, parser output, fixture contract, and existing engine evidence. If evidence is inadequate, run the documented fixture evidence command before any regeneration. Record the basis close to the regression assertion or fixture provenance.

**Verify**: parser output agrees with the saved asset evidence.

### Step 2: Apply the smallest correction

If the uasset is intentional and only the assertion is stale, correct the assertion. If the generated asset is stale, regenerate through existing scripts so source, asset, contract, and assertion agree. Retain the numeric assertion as a parser regression check.

**Verify**: focused test passes.

### Step 3: Prove the portable baseline

Run the whole portable suite without exclusions.

**Verify**: pnpm check exits 0.

## Test plan

- Preserve object path, field, and Count assertions in the fixture integration test.
- Compare direct CLI inspection with the asserted value.
- Run the full portable gate.

## Done criteria

- [x] One evidenced Count value exists across all applicable fixture representations.
- [x] Focused fixture test passes.
- [x] pnpm check exits 0.
- [x] No unrelated fixture or parser behavior changed.
- [x] plans/README.md marks Plan 020 DONE.

## STOP conditions

- Saved uasset and Unreal evidence disagree.
- A correction requires parser behavior changes.
- Fixture regeneration alters unrelated assets/contracts.
- A different pnpm check failure remains after this correction.

## Maintenance notes

Any fixture source edit must use the engine-backed regeneration flow. Never update this assertion on parser output alone.

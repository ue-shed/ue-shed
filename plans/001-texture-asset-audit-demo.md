# Plan 001: Deliver the first Texture Asset Audit demo end to end

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP conditions"
> section occurs, stop and report—do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c2df417..HEAD -- package.json pnpm-lock.yaml fixtures/unreal-project packages/unreal-assets packages/asset-audits apps/cli extensions/asset-audits apps/workbench README.md docs/vision-and-architecture.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts
> against the live code before proceeding. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day vertical slice)
- **Risk**: MED — the saved-package payload is versioned but Texture2D evidence must be proven against
  the new real fixture before domain or UI work proceeds
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `c2df417`, 2026-07-14

## Why this matters

Asset Audits is the fastest of the three authored-content products to a convincing demo. The first
slice should let a technical artist scan a project without launching Unreal, see the shape of its
texture corpus, select an outlier from a distribution, inspect the supporting evidence, and apply a
small explicit rule set. The same report must be available from a headless package and CLI; Workbench
is a route and presentation host, not the domain authority.

This plan intentionally delivers only the Texture and Import Audit lens. Audio, animation, input,
gameplay tags, history, saved exceptions, automatic repair, thumbnails, runtime memory estimates,
and generalized validation are follow-ups.

## Demo contract

The finished demo is one coherent flow:

1. A deterministic UE 5.7 fixture contains five generated Texture2D assets under
   `/Game/Fixture/Audits/Textures`.
2. The assets include ordinary power-of-two peers, a `300×180` non-power-of-two texture, and a
   `1024×512` UI-group texture whose configured maximum is `512`.
3. `ue-shed audit textures <project-root> --rules <rule-file> [--reader <path>]` emits the same typed
   report consumed by Workbench.
4. The Workbench `#/asset-audits/textures` route shows scan coverage, corpus distributions, a texture
   sheet, and two evidence-backed findings.
5. Selecting a distribution bucket filters the sheet; selecting a row opens an inspector showing
   dimensions, available serialized settings, unavailable evidence, and triggered rules.
6. The Camera Load Lab remains available at `#/camera-lab` and its existing implementation is not
   rewritten as part of this work.

The two first-slice rule kinds are deliberately narrow:

- `dimensions_power_of_two`: both dimensions must be powers of two;
- `max_dimension_for_texture_group`: the largest dimension must not exceed a configured value for a
  named texture group.

Do not add a mask/sRGB rule in this slice. Unreal omits default-valued UObject properties from tagged
property serialization, so absence in `uasset inspect` does not prove the effective default. Missing
properties must be represented as unavailable evidence, not silently filled with guessed values.

## Current state

### Product and dependency boundaries

`docs/vision-and-architecture.md:27-30` makes the deletion test explicit:

```text
The deletion test is an architectural acceptance criterion: if `apps/workbench` disappears, every
capability must remain usable and testable through public libraries or the CLI. The Workbench gets no
private transport, privileged endpoint, or direct project knowledge.
```

`docs/vision-and-architecture.md:116-120` fixes dependency direction:

```text
- Domain packages depend on protocol primitives and narrow connection interfaces, not on a UI.
- Saved-package parsing is isolated behind `@ue-shed/unreal-assets`; domain packages consume
  normalized results rather than parser implementation details.
- Extensions depend on public domain packages and host extension contracts.
- The CLI and Workbench compose extensions; they do not own domain behavior.
```

`docs/ideas/asset-audits.md` is the product authority for this plan. In particular:

- show the corpus before judging it;
- keep specialist texture meaning instead of inventing a universal asset score;
- make findings, scope, and evidence quality explainable;
- keep remediation deliberate and out of the read-only scan;
- start with texture/import auditing and use the generic fixture.

### Saved-package boundary

`packages/unreal-assets/src/index.ts:34-72` currently has only a DataTable-specific process boundary:

```ts
return await execFileAsync(
	executableFrom(options),
	["authoring", options.assetPath, "--format", "json"],
	{ encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }
);
```

The independent `uasset` reader's generic `inspect` JSON is the behavioral contract to consume. At
planning time its CLI schema is version `6`. Its envelope contains:

```text
schema_version, status, path, package, assets[], decode_errors[]
```

Texture2D primary exports appear as `kind: "UObject"` with
`class_path: "/Script/Engine.Texture2D"`. Properties are recursively tagged by `value_kind`; the
full v6 value union is bool, int, uint, float, double, name, enum, string, text, vector, int_point,
object_ref, guid, soft_object_path, array, set, map, struct, and raw. A struct contains nested
`properties`. The reader returns exit code `6` with valid stdout for partial package results.

Do not copy Rust implementation into UE Shed and do not import the sibling repository. Consume only
the released/versioned CLI behavior through `@ue-shed/unreal-assets`. If the real generated fixture
does not expose the required source dimensions in v6, stop and request an upstream reader plan.

### Fixture

`fixtures/unreal-project/fixture-contract.json` currently declares DataTables and the camera load map,
but no audit corpus. `fixtures/unreal-project/Source/UEShedFixtureEditor/Private/
UEShedBuildFixtureCommandlet.cpp:80-94` already centralizes package saving:

```cpp
bool SaveAsset(UPackage* Package, UObject* Asset)
{
	const FString Filename = FPackageName::LongPackageNameToFilename(
		Package->GetName(), Asset->IsA<UWorld>()
			? FPackageName::GetMapPackageExtension()
			: FPackageName::GetAssetPackageExtension());
	IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);

	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	SaveArgs.SaveFlags = SAVE_NoError;
	return UPackage::SavePackage(Package, Asset, *Filename, SaveArgs);
}
```

Generation is idempotent, calls `FAssetRegistryModule::AssetCreated` only for newly created assets,
marks the package dirty, saves it, and has a matching `Verify*` path. Follow that pattern.

The local UE 5.7 source confirms the supported fixture API at
`Engine/Source/Runtime/Engine/Classes/Engine/Texture.h`: `FTextureSource::Init(SizeX, SizeY,
NumSlices, NumMips, ETextureSourceFormat, const uint8*)`. Use engine source as authority during
implementation. Do not place the local engine installation path in runtime code or fixture data.

### CLI

`apps/cli/src/index.ts` is a single explicit command dispatcher. It parses external JSON as unknown
through domain decoders and prints JSON with tabs. Preserve existing authoring commands and add one
top-level `audit` branch rather than hiding scan behavior in Workbench.

### Workbench

`apps/workbench/src/renderer/index.tsx` currently renders Camera Load Lab directly:

```tsx
import { render } from "solid-js/web";
import { CameraLab } from "./camera-lab.js";
import "./reset.css";

render(() => <CameraLab />, document.getElementById("root")!);
```

`apps/workbench/src/main/preload.ts` exposes a context-isolated `window.ueShed` API. Keep
`contextIsolation: true` and `sandbox: true`; new audit IPC must return a typed result union and must
not give the renderer filesystem or process access. The main process may use Electron's directory
picker and public headless services.

At planning time the working tree contains unrelated camera changes, including
`apps/workbench/src/renderer/camera-lab.tsx`. That file is explicitly out of scope. The aggregate
`pnpm check` baseline passed typecheck and lint but failed `format:check` on that existing modified
file; tests passed. Execution should begin only after the owner has integrated or resolved that
unrelated formatting state.

### Applicable conventions

- Tabs, double quotes, semicolons, no trailing commas, approximately 100 columns.
- Define TypeScript-owned runtime schemas with Effect Schema, then infer types.
- Use branded asset identifiers at the domain boundary and discriminated unions for available versus
  unavailable evidence and scan/UI states.
- Keep metadata extraction, distribution folding, filtering, and rule evaluation pure.
- Use Effect for filesystem discovery, file stats, bounded process execution, rule-file loading,
  concurrency, typed failures, and spans.
- Validate CLI JSON, rule files, parser output, and Electron IPC as `unknown` at their boundaries.
- Keep Solid components thin; inject a host-neutral client and render loading, empty, ready, partial,
  error, unsupported, not-configured, and cancelled states.
- Keep StyleX styles local. Do not add global selectors or use stylesheet ordering as a contract.
- Prefer real fixture integration tests over mocks; use synthetic values only for cheap pure tests.

## Commands you will need

Run commands from `C:\Users\Ryzen\git\swag\ue-shed` in PowerShell.

| Purpose                | Command                                  | Expected on success                            |
| ---------------------- | ---------------------------------------- | ---------------------------------------------- |
| Install/update lock    | `pnpm install`                           | exit 0; only intended manifest/lock changes    |
| Typecheck              | `pnpm typecheck`                         | exit 0, no TypeScript errors                   |
| Lint                   | `pnpm lint`                              | exit 0                                         |
| Format check           | `pnpm format:check`                      | exit 0                                         |
| Unit/integration tests | `pnpm test`                              | exit 0; all non-environment-gated tests pass   |
| Workbench build        | `pnpm --filter @ue-shed/workbench build` | exit 0; main, preload, renderer build          |
| Fixture generate       | `pnpm fixture:generate`                  | exit 0; audit textures generated and saved     |
| Fixture verify         | `pnpm fixture:verify`                    | exit 0; texture definitions match the contract |
| Full gate              | `pnpm check`                             | exit 0                                         |

Reader-backed gates require a compatible executable:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm exec vitest run packages/unreal-assets/src packages/asset-audits/src
pnpm ue-shed audit textures fixtures/unreal-project `
  --rules fixtures/unreal-project/FixtureSource/Audits/texture-rules.json
```

The test command must exit 0. The CLI command must emit a report with five texture records, two
findings, and no fatal scan error.

## Suggested executor toolkit

- Before unfamiliar Effect code, consult `effect-solutions` if available, then the installed Effect
  3.22 source or official Effect documentation. Do not guess at concurrency, schema, or error APIs.
- Use the `quality-code` skill if available for the schema, branded-ID, error, and test design.
- Use `frontend-design` and `emil-design-eng` if available for the Workbench route. Preserve this
  plan's product flow and states; use those skills for presentation quality, not scope expansion.
- Verify every Unreal API against `C:\Program Files\Epic Games\UE_5.7\Engine\Source` before writing
  fixture C++.

## Scope

### In scope

Existing files to modify:

- `package.json` only if a focused script is genuinely needed
- `pnpm-lock.yaml`
- `README.md`
- `docs/vision-and-architecture.md` only to add the new package/extension ownership rows
- `fixtures/unreal-project/fixture-contract.json`
- `fixtures/unreal-project/fixture-contract.test.ts`
- `fixtures/unreal-project/Source/UEShedFixtureEditor/Private/UEShedBuildFixtureCommandlet.cpp`
- `fixtures/unreal-project/Source/UEShedFixtureEditor/UEShedFixtureEditor.Build.cs` only if verified UE
  APIs require an additional stock module
- `packages/unreal-assets/package.json`
- `packages/unreal-assets/README.md`
- `packages/unreal-assets/src/index.ts`
- `packages/unreal-assets/src/fixture.integration.test.ts`
- `packages/unreal-assets/src/live-parity.integration.test.ts`
- `apps/cli/package.json`
- `apps/cli/src/index.ts`
- `apps/workbench/package.json`
- `apps/workbench/README.md`
- `apps/workbench/src/main/main.ts`
- `apps/workbench/src/main/preload.ts`
- `apps/workbench/src/renderer/global.d.ts`
- `apps/workbench/src/renderer/index.tsx`

Files/directories to create:

- `fixtures/unreal-project/FixtureSource/Audits/textures.json`
- `fixtures/unreal-project/FixtureSource/Audits/texture-rules.json`
- `fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_World_256.uasset`
- `fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_World_512x256.uasset`
- `fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_UI_1024x512.uasset`
- `fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset`
- `fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_Defaults_256.uasset`
- `packages/unreal-assets/src/inspect.test.ts`
- `packages/asset-audits/package.json`
- `packages/asset-audits/tsconfig.json`
- `packages/asset-audits/README.md`
- `packages/asset-audits/src/index.ts`
- `packages/asset-audits/src/schema.ts`
- `packages/asset-audits/src/texture.ts`
- `packages/asset-audits/src/texture.test.ts`
- `packages/asset-audits/src/fixture.integration.test.ts`
- `extensions/asset-audits/package.json`
- `extensions/asset-audits/tsconfig.json`
- `extensions/asset-audits/README.md`
- `extensions/asset-audits/src/index.ts`
- `extensions/asset-audits/src/texture-audit-route.tsx`
- `extensions/asset-audits/src/texture-audit-route.test.tsx`
- `apps/workbench/src/renderer/app-shell.tsx`
- `apps/workbench/src/renderer/asset-audits-client.ts`

If implementation naturally needs one additional test/helper file inside one of those new package
directories, add it and record why in the final handoff. Do not expand into another domain.

### Out of scope

- `apps/workbench/src/renderer/camera-lab.tsx` and all camera protocol/C++ files
- Changes in `C:\Users\Ryzen\git\swag\ue-parser`; request an upstream plan if the reader gate fails
- Any Unreal companion plugin or running-editor dependency for audit scans
- Audio, animation, input, gameplay-tag, settings, history, or Janitor lenses
- Thumbnail or source-pixel extraction
- GPU/cooked/runtime memory estimates; use package file bytes and source dimensions only
- Automatic fixes, reimports, source-control operations, exceptions, assignments, or persisted scans
- A general expression language or universal validation engine
- A new charting dependency; use accessible HTML/SVG or styled bars for the small first-slice
  distributions
- Refactoring Camera Load Lab, adopting a full router, or building the entire shared UI system
- Studio-specific paths, assets, naming schemes, or thresholds

## Git workflow

- Branch: `advisor/001-texture-asset-audit-demo`
- The repository uses short imperative commit subjects such as
  `Add executable headless authoring path via saved-package reader`. Use the same style.
- Commit by logical vertical unit: fixture/reader gate, domain/CLI, then extension/Workbench.
- Do not push or open a PR unless the operator explicitly instructs it.
- Preserve all pre-existing dirty files. If an in-scope file has unrelated user edits, stop and ask
  the owner to land or isolate them before execution.

## Steps

### Step 0: Establish a clean executable baseline

1. Run `git status --short` and the drift check.
2. Confirm the three uncommitted product vision documents exist, especially
   `docs/ideas/asset-audits.md`.
3. Confirm unrelated camera changes are committed, isolated, or otherwise no longer causing the
   baseline format failure. Do not format or edit `camera-lab.tsx` under this plan.
4. Run `pnpm check` before feature changes.

**Verify**: `pnpm check` → exit 0. If it does not, STOP and report the baseline failure with the
failing command and file; do not absorb unrelated repairs into this plan.

### Step 1: Add the deterministic texture-audit fixture

1. Extend `fixture-contract.json` with a `textureAudit` section:
    - `contentRoot`: `/Game/Fixture/Audits/Textures`;
    - `source`: `FixtureSource/Audits/textures.json`;
    - `rules`: `FixtureSource/Audits/texture-rules.json`;
    - five texture entries with object path, width, height, source format, declared settings, and
      expected finding IDs;
    - the fixture expects exactly `dimensions.power_of_two` on the `300×180` asset and
      `dimensions.ui_max_512` on the `1024×512` UI asset.
2. Create `textures.json` as the reviewable generation authority. Use generic names listed in Scope,
   deterministic checker/stripe patterns, dimensions listed in the filenames, one slice, one mip,
   and `TSF_BGRA8`. Include varied non-studio texture groups, compression settings, sRGB values, and
   mip settings, but do not claim that every default-valued setting will be serialized.
3. Create `texture-rules.json` with schema version `1`, a human-readable fixture rule-set name, and
   exactly two typed rules:
    - `{ id: "dimensions.power_of_two", kind: "dimensions_power_of_two", severity: "warning" }`;
    - `dimensions.ui_max_512` uses `max_dimension_for_texture_group`, `TEXTUREGROUP_UI`, maximum
      `512`, and warning severity.
4. Extend the fixture contract test's local type and assertions. Prove source/contract agreement,
   unique object paths, positive bounded dimensions, portable paths, the expected two findings, and
   presence of every committed generated `.uasset`.
5. In the commandlet, parse `textures.json`, reject unknown enum/pattern strings explicitly, generate
   deterministic BGRA bytes, call the UE 5.7 `FTextureSource::Init` API, set declared `UTexture2D`
   settings, notify Asset Registry for newly created objects, and save through `SaveAsset`.
6. Add `GenerateAuditTextures()` and `VerifyAuditTextures()` to ordinary generation and verification.
   Verification must load every declared texture and check source dimensions and declared UObject
   settings directly in Unreal. Generation must be idempotent.
7. Run generation, inspect the diff, and commit only the five declared `.uasset` files. Do not commit
   DerivedDataCache, Intermediate, Saved, binaries, or machine-specific files.

**Verify**:

```powershell
pnpm exec vitest run fixtures/unreal-project/fixture-contract.test.ts
pnpm fixture:generate
pnpm fixture:verify
git status --short fixtures/unreal-project
```

Expected: all commands exit 0; the contract test passes; verification reports five matching audit
textures; status shows only declared source, contract, commandlet, and five content assets.

### Step 2: Prove and expose the generic saved-asset inspection boundary

Do this before creating `@ue-shed/asset-audits` or any UI.

1. In `packages/unreal-assets/src/index.ts`, factor the shared bounded child-process invocation used by
   both authoring and generic inspection. Preserve:
    - executable selection from explicit option, `UE_SHED_UASSET_EXECUTABLE`, then `uasset` on PATH;
    - `windowsHide: true`;
    - maximum stdout of 16 MiB;
    - exit code 6 as partial success when valid stdout exists.
2. Add a finite default process timeout (30 seconds per package) with an explicit option for tests and
   callers. Map timeout, spawn/process, malformed JSON, unsupported schema, and contract failure into
   typed `AssetReaderError` kinds with path, operation, retry guidance, and exit code where available.
3. Define Effect Schemas for the generic `uasset inspect` v6 envelope and recursive property-value
   union described in Current state. Infer types; do not duplicate interfaces. Validate the complete
   shapes consumed by downstream code rather than casting JSON. Accept the documented optional fields
   and preserve `status`, `decode_errors`, `class_path`, properties, and raw evidence.
4. Export `decodeSavedAssetInspection(unknown)` for pure contract tests and
   `readSavedAsset(options)` which invokes:

    ```text
    uasset inspect <asset-path> --format json
    ```

5. Keep `readSavedTable` behavior and public shape compatible.
6. Add pure tests for:
    - a complete Texture2D v6 envelope with nested `Source` struct;
    - a partial result with decode errors;
    - every property-value discriminator, including recursive arrays/maps/structs;
    - malformed JSON shape, wrong discriminator, and unsupported schema version;
    - absence of optional settings remains absence.
7. Update existing fixture authoring tests to select only the 11 table assets declared by the fixture
   contract. They currently discover every `.uasset`; adding texture assets must not make them call
   the authoring projection on non-table packages.
8. Add a reader-backed integration test that inspects all five real fixture textures and asserts:
    - schema version 6;
    - a Texture2D export is present;
    - `Source.SizeX` and `Source.SizeY` match the fixture contract;
    - partial package output remains consumable;
    - absent default-valued properties are not synthesized.
9. Update the package README with the generic inspect operation, compatibility behavior, limits, and
   partial-result semantics.

**Verify**:

```powershell
pnpm exec vitest run packages/unreal-assets/src
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm exec vitest run packages/unreal-assets/src/fixture.integration.test.ts
```

Expected: both commands exit 0; five real texture packages expose matching source dimensions. If the
real gate cannot prove dimensions or distinguish Texture2D, STOP before Step 3.

### Step 3: Build the headless Texture Audit domain

1. Create `@ue-shed/asset-audits` as a private workspace package with strict TypeScript settings
   matching `packages/unreal-assets/tsconfig.json`. Depend on `@ue-shed/unreal-assets` and Effect, not
   on Workbench, Electron, Solid, or an Unreal connection.
2. In `schema.ts`, define and export schemas plus inferred types for:
    - branded texture object paths and rule IDs;
    - `Evidence<T>` as `available` with a value and source (`serialized` or `file`), or `unavailable`
      with a typed reason;
    - texture records: object path, file path, package file bytes, source dimensions/format/mips,
      compression, sRGB, texture group, and mip-generation evidence;
    - the two rule variants and a versioned rule set;
    - findings with rule ID, severity, asset identity, human-readable explanation, and structured
      actual/expected evidence;
    - scan coverage and diagnostics;
    - distributions for maximum-dimension buckets, texture group, compression setting, and sRGB
      evidence;
    - a report whose status is `complete` or `partial`;
    - a Workbench-safe run result union: `completed`, `not_configured`, `cancelled`, or `failed` with
      a typed public error.
3. In `texture.ts`, keep these operations pure:
    - find Texture2D exports by exact class path;
    - locate root properties and nested `Source` properties by exact name and value kind;
    - produce available/unavailable evidence without filling missing defaults;
    - evaluate the two rule variants;
    - fold deterministic, sorted distributions and findings;
    - filter a report by distribution selection without recomputing source evidence.
4. Add an Effect scan service that:
    - validates the project root and versioned rule file;
    - discovers `.uasset` files through `@ue-shed/unreal-assets`;
    - processes files with explicit bounded concurrency (default 4) and a maximum asset count;
    - reads package file size and generic inspection once per file;
    - treats per-package failures as bounded diagnostics and a partial report;
    - fails with a typed fatal error only when the project/rules/discovery boundary cannot start or no
      truthful report can be formed;
    - records spans for discovery, each bounded inspect operation, and the aggregate scan using safe
      counts and durations, never full payloads or unbounded paths as metric labels.
5. Sort records by object path, findings by severity/rule/object path, and distribution buckets by a
   documented stable order so CLI and UI tests do not depend on filesystem scheduling.
6. Add pure tests covering:
    - power-of-two edges (`1`, powers of two, zero invalid, `300×180` failing);
    - maximum dimension scoped to `TEXTUREGROUP_UI`;
    - no finding when required group/dimension evidence is unavailable;
    - serialized false remains false and absent sRGB remains unavailable;
    - nested Source extraction, wrong value kinds, raw fields, duplicate exports, and partial packages;
    - deterministic ordering and distribution totals;
    - complete versus partial coverage.
7. Add a real fixture integration test, gated by `UE_SHED_UASSET_EXECUTABLE`, which loads the fixture
   rule file and produces five records with exactly the two expected findings.
8. Document the package's evidence model, rule-set format, limits, and explicitly unsupported default
   inference in its README.

**Verify**:

```powershell
pnpm --filter @ue-shed/asset-audits typecheck
pnpm exec vitest run packages/asset-audits/src/texture.test.ts
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm exec vitest run packages/asset-audits/src/fixture.integration.test.ts
```

Expected: exit 0; the integration report has 5 records, 2 findings, and distributions whose bucket
counts sum to the number of records with available evidence.

### Step 4: Add the headless CLI flow

1. Add `@ue-shed/asset-audits` to `apps/cli/package.json`.
2. Extend help with:

    ```text
    ue-shed audit textures <project-root> --rules <rule-file> [--reader <path>]
    ```

3. Parse required flags explicitly and reject missing/duplicate/unknown arguments with useful usage
   errors. Do not read a fixture-specific default rule path.
4. Invoke the public scan service and print the report using the existing tab-indented JSON helper.
5. Translate typed fatal errors at the CLI boundary into a concise message and nonzero exit code. A
   partial report is successful JSON and must retain its diagnostics.
6. Update the root README with one portable example using placeholder paths and state that scanning
   does not require a running editor or companion plugin.

**Verify**:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm ue-shed audit textures fixtures/unreal-project `
  --rules fixtures/unreal-project/FixtureSource/Audits/texture-rules.json
pnpm ue-shed --help
```

Expected: first command exits 0 and emits 5 records/2 findings; help contains the new command and all
existing authoring commands.

### Step 5: Create the host-neutral Asset Audits extension

1. Create `extensions/asset-audits` as `@ue-shed/extension-asset-audits`, a private SolidJS/StyleX
   package depending on `@ue-shed/asset-audits`. It must not import Electron, Node APIs,
   `window.ueShed`, or Workbench modules.
2. Export a `TextureAuditRoute` that receives an injected client with two actions:
    - load the optionally configured project;
    - choose a project and, when no rule path is configured, choose a rule file before scanning.
      Both return the decoded `TextureAuditRunResult` union.
3. Model view state as a discriminated union and cover:
    - no project selected;
    - loading;
    - complete report;
    - partial report with visible coverage/diagnostics;
    - fatal failure with recovery guidance;
    - cancelled directory selection;
    - zero Texture2D assets.
4. Implement the first route layout:
    - route header and Choose Project/Rescan actions;
    - coverage strip: discovered packages, inspected packages, texture assets, partial/failed packages;
    - accessible distribution bars for maximum dimension, texture group, compression, and sRGB
      evidence;
    - searchable/filterable texture sheet;
    - finding count/severity and a finding filter;
    - selected-asset inspector with evidence sources, unavailable reasons, and structured rule
      explanations.
5. Clicking a distribution bucket must filter the sheet. Clearing the filter restores all records.
   Selecting a sheet row must preserve the current filter and open the inspector.
6. Use local StyleX styles and semantic visual roles. Do not add a chart library, global selectors,
   hover-only information, or color-only severity. Keep the presentation polished at 1120×720 and
   1540×940.
7. Add component tests using an injected fake client. Cover choose/scan, complete and partial states,
   distribution filtering, row selection, unavailable evidence, error recovery, cancel, and cleanup.
   Add only the focused testing dependencies needed by this extension and update the lockfile.

**Verify**:

```powershell
pnpm --filter @ue-shed/extension-asset-audits typecheck
pnpm exec vitest run extensions/asset-audits/src/texture-audit-route.test.tsx
```

Expected: exit 0; tests prove visible user behavior and state transitions, not generated class names
or DOM snapshots.

### Step 6: Compose the Workbench routes through validated IPC

1. Add dependencies on `@ue-shed/asset-audits` and `@ue-shed/extension-asset-audits` to Workbench.
2. In the main process:
    - register namespaced IPC for `asset-audits:textures:configured-scan` and
      `asset-audits:textures:choose-and-scan`;
    - use `UE_SHED_PROJECT_ROOT` and `UE_SHED_TEXTURE_AUDIT_RULES` only as optional explicit
      configuration for the configured scan;
    - return `not_configured` when the configured scan lacks either required environment value;
    - use Electron's directory picker for choose-and-scan, then use the configured rule path or open
      a JSON file picker for the rule set;
    - return `cancelled` when either picker is dismissed;
    - invoke only the public headless audit service;
    - return `TextureAuditRunResult`, mapping cancellation and typed failures without exposing stacks;
    - never accept a reader executable path from the renderer.
3. Extend preload/global types under `window.ueShed.assetAudits` while preserving existing camera APIs.
   Expose only the two audit operations and return `unknown` across the raw IPC boundary.
4. In `asset-audits-client.ts`, decode IPC results with the public Effect Schema decoder before
   passing them to the extension. Contract failure becomes a typed failed result, not an unchecked
   cast.
5. Add `app-shell.tsx` with a small static route registry and hash routes:
    - `#/asset-audits/textures` (default);
    - `#/camera-lab`.
      Use real navigation semantics, preserve deep links, and avoid introducing a router dependency.
6. Change `index.tsx` to render the shell. Keep `CameraLab` intact and reachable. Change the window
   title to `UE Shed Workbench` and update the Workbench README with both routes and the environment
   variables for a deterministic fixture demo.
7. Build and run Workbench with the fixture project/rules configured. Confirm it loads without Unreal
   running, renders five records/two findings, filters from a distribution, and shows unavailable
   evidence honestly.

**Verify**:

```powershell
pnpm --filter @ue-shed/workbench typecheck
pnpm --filter @ue-shed/workbench build
$env:UE_SHED_PROJECT_ROOT = (Resolve-Path fixtures/unreal-project)
$env:UE_SHED_TEXTURE_AUDIT_RULES = `
  (Resolve-Path fixtures/unreal-project/FixtureSource/Audits/texture-rules.json)
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm --filter @ue-shed/workbench start
```

Expected: typecheck/build exit 0. The launched route visibly satisfies the fixture flow; Camera Load
Lab remains reachable. Close Workbench after the manual interaction check.

### Step 7: Finish documentation and run the full gate

1. Update `docs/vision-and-architecture.md` repository shape with `packages/asset-audits` and
   `extensions/asset-audits`; do not rewrite sequencing unrelated to this slice.
2. Ensure all package READMEs state ownership and dependency direction.
3. Run formatter only on files changed by this plan, then the full repository gate.
4. Inspect status for generated/cache pollution and remove only plan-created ignored artifacts. Do not
   clean or revert user-owned changes.
5. Update this plan's status row in `plans/README.md` to `DONE` only after all gates pass.

**Verify**:

```powershell
pnpm check
pnpm --filter @ue-shed/workbench build
git diff --check
git status --short
```

Expected: all commands exit 0; status contains only the intentional files listed in Scope; no
DerivedDataCache, Intermediate, Saved, binary build product, local path, or studio-specific content
is added.

## Test plan

### Pure and schema tests

- `packages/unreal-assets/src/inspect.test.ts`
    - full/partial v6 envelopes;
    - every property discriminator and recursive shape;
    - malformed, wrong-version, and absent-property cases.
- `packages/asset-audits/src/texture.test.ts`
    - exact Texture2D/property extraction;
    - available/unavailable evidence;
    - both rule kinds and edge conditions;
    - stable findings/distributions/filtering;
    - partial coverage and diagnostics.

Use `packages/cameras/src/index.test.ts` as the style exemplar for focused pure tests and
`packages/protocol/src/authoring.test.ts` as the schema-boundary exemplar.

### Real integration tests

- `packages/unreal-assets/src/fixture.integration.test.ts` proves the released reader against five
  real generated texture packages.
- `packages/asset-audits/src/fixture.integration.test.ts` proves the actual rule file produces five
  records and exactly two findings.
- Preserve environment gating so ordinary portable tests skip when the external reader is absent;
  reader-backed CI/demo verification must set `UE_SHED_UASSET_EXECUTABLE` and treat absence as a
  failed gate.

### UI tests

- `extensions/asset-audits/src/texture-audit-route.test.tsx` tests visible states and actions through
  an injected client.
- Assert user-facing labels, row counts, filters, inspector evidence, and recovery actions.
- Do not snapshot StyleX output or internal DOM structure.

### Final verification

`pnpm check` and `pnpm --filter @ue-shed/workbench build` must both pass. The reader-backed fixture
test and CLI demo command must also pass with the configured executable.

## Done criteria

- [ ] The fixture contract declares five reproducible generic texture assets and exactly two expected
      findings.
- [ ] `pnpm fixture:generate` and `pnpm fixture:verify` exit 0 on UE 5.7.
- [ ] `@ue-shed/unreal-assets` validates generic inspect v6 as unknown, accepts partial exit 6, and
      proves source dimensions against all five real fixture packages.
- [ ] `@ue-shed/asset-audits` produces five records, two evidence-backed findings, truthful unavailable
      states, deterministic distributions, and bounded partial diagnostics.
- [ ] The CLI command emits the same public report without Workbench or a running editor.
- [ ] The host-neutral extension has no imports from Electron, Node, Workbench, or camera modules.
- [ ] `#/asset-audits/textures` supports choose/rescan, distributions, filter-to-sheet, row inspection,
      complete/partial/error/empty states, and visible evidence quality.
- [ ] `#/camera-lab` remains reachable and `camera-lab.tsx` is unchanged by this plan.
- [ ] No rule infers missing serialized settings or claims runtime/cooked memory.
- [ ] `pnpm check`, Workbench build, `git diff --check`, reader-backed fixture tests, and the CLI fixture
      command all exit 0.
- [ ] `git status --short` contains no out-of-scope or generated-cache changes.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report back; do not improvise if:

- The baseline `pnpm check` still fails because of unrelated camera or other user-owned changes.
- Any in-scope file contains overlapping uncommitted work that cannot be preserved cleanly.
- UE 5.7 source contradicts the fixture API described here or generated textures do not survive a
  generate/verify round trip.
- The compatible released `uasset inspect` payload is not schema v6, does not expose Texture2D by
  exact class path, or does not expose truthful `Source.SizeX`/`Source.SizeY` for the real fixture.
  Request an upstream parser plan; do not parse `.uasset` bytes in TypeScript or add an Unreal plugin.
- Meeting the demo requires guessing omitted Unreal default properties. Keep them unavailable and
  report the product limitation instead.
- Adding the audit route appears to require rewriting Camera Load Lab, changing camera protocols, or
  building a general runtime-extension loader.
- A step's verification fails twice after a reasonable scoped correction.
- A proposed dependency requires copying internal/studio source or introduces unclear licensing.

## Maintenance notes

- `uasset inspect` is an external versioned contract. A future schema version needs explicit
  compatibility tests before acceptance; do not silently accept unknown discriminators.
- The first scan starts one bounded reader process per package. Asset Registry prefiltering, caching,
  and incremental scans are likely follow-ups for large projects, but should be driven by measured
  scan time rather than added speculatively here.
- Default-valued UObject properties remain a known evidence gap. A future solution may use a
  versioned reader projection or another authoritative source, but must identify its authority and
  engine compatibility.
- Rule variants should grow as a discriminated union when a real audit lens needs them. Do not replace
  the two concrete rules with an expression language prematurely.
- Audio Audit should reuse the report/finding/coverage interaction language while owning its own
  specialist evidence. Do not force audio measurements into texture schemas.
- Reviewers should scrutinize partial-result handling, bounded concurrency/process cleanup, exact
  property-name extraction, stable sorting, IPC validation, and whether the UI ever turns missing
  evidence into a confident value.

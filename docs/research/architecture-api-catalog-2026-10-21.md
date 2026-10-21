# Architecture and API catalog (2026-10-21)

A code-quality and architecture pass over every package in `packages/*`, and the host-facing parts
of `crates/*`, `extensions/*` and `apps/cli`. It asks one question: can a downstream host use UE
Shed's libraries without changing and releasing UE Shed? The owner's downstream product keeps
needing changes like that, just to expose something that should have been public.

This continues [Plan 058](../../plans/058-game-text-actions-rules-and-codebase-week.md) Lane D. D1
narrowed Game Text's entry points, D4–D8 settled the error, parser and layer shapes, D11 required
JSDoc, and D13 measured the eight reviewed SDKs. This pass does not repeat that work. It covers
the packages D13 left out, the capabilities that live only in the Workbench or the CLI, and the
policy that is still hard-coded ([base, not constraints](../vision-and-architecture.md#base-not-constraints)).

Line numbers are taken at `f77a4dfb`, the head of PR #156. Items marked **done in this PR** are the
additive fixes this branch makes. Everything else is a recommendation.

**Notation**

- **Priority.** P0 means it blocks downstream consumption today. P1 means a host has to copy code
  or fork policy. P2 is quality, consistency or a smaller gap.
- **Size.** S is under a day, M is a few days, L is a week or more.
- **Kind.** Additive changes add surface without changing current behaviour. Breaking changes
  remove or rename surface, or change behaviour or wire shape.

## Method

- **Export usage.** `node scripts/measure-package-exports.ts --json` was run for all 25 code
  packages, not only D13's seven. It compares each entry point's exported names with imports
  across `apps/`, `packages/`, `extensions/` and `scripts/`, so it cannot see uses in other
  repositories.
- **Deep imports.** Relative imports into another workspace's `src` were grepped across apps,
  extensions and packages.
- **Workbench and CLI code.** Every Workbench main service and IPC module, and every CLI workflow
  over about 100 lines, was read for domain logic that has no library entry point.
- **Hard-coded policy.** Module-level numeric constants, regexes and string lists that act as
  policy were collected per package.
- **Checks.** `scripts/check-public-api.ts` and `scripts/check-effect-architecture.ts` were
  reviewed for which packages they cover.

Five read-only review passes, one per package group, gathered the findings, and the high-impact
ones were spot-checked against the source. Raw measurements:

| Package               | Entry point                                                                   | Used / exported (outside the package)             | Notes                                                             |
| --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `asset-audits`        | `.` / `./browser`                                                             | 78/78, 26/60                                      | private                                                           |
| `authoring`           | `.` / `./analysis` / `./joined-views` / `./review-contracts`                  | 101/101, 2/8, 2/4, **0/10**                       | private                                                           |
| `authoring-catalog`   | `.`                                                                           | 11/11                                             | private                                                           |
| `authoring-sdk`       | `.`                                                                           | 25/32                                             | private                                                           |
| `blueprints`          | `.`                                                                           | 14/35                                             | public, no JSDoc guard                                            |
| `cameras`             | `.` / `./review-contracts` / `./map-tiles` / `./browser`                      | 476/476, 31/40, 18/59, 25/279                     | `./browser` is a strict subset of `.`                             |
| `config-explorer`     | `.` / `./browser`                                                             | 9/47, 10/29                                       | public, no JSDoc guard                                            |
| `engine`              | `.`                                                                           | 89/89                                             |                                                                   |
| `enhanced-input`      | `.` / `./browser`                                                             | 6/44, 9/27                                        | private                                                           |
| `game-text`           | `.` / `./browser` (deprecated)                                                | **0/569, 0/484**                                  | deprecated since 0.17.0, promised "kept for one release"          |
| `game-text`           | `./schema` `./rules` `./checks` `./labels` `./corpus` `./index` `./workspace` | 91/164, 63/63, 18/105, 8/11, 176/176, 84/84, 9/17 |                                                                   |
| `host`                | `.`                                                                           | 13/13                                             | private                                                           |
| `localization`        | `.` / `./browser`                                                             | 171/171, 41/129                                   |                                                                   |
| `map-history`         | `.` / `./contract` / `./playback`                                             | 112/112, 11/38, 2/8                               | 13× `export *` at the root                                        |
| `niagara`             | `.` / `./browser`                                                             | 33/33, 5/18                                       | public, no JSDoc guard                                            |
| `observability`       | `.` / `./health` / `./metrics`                                                | 13/33, 1/9, 1/21                                  | public, no JSDoc guard                                            |
| `observatory`         | `.` / `./presentation` / `./browser`                                          | 73/73, 12/30, 21/40                               | `./presentation` is a subset of `./browser`                       |
| `plugin-distribution` | `.`                                                                           | 23/137                                            | public, no JSDoc guard; about 95 of the unused names are host API |
| `project-custodian`   | `.` / `./browser`                                                             | 6/39, 10/34                                       | public, no JSDoc guard                                            |
| `protocol`            | `.`                                                                           | 273/273                                           | `contracts/` is packed but not exported                           |
| `scenarios`           | `./files` / `.` / `./browser`                                                 | 2/3, 75/75, 20/69                                 | private                                                           |
| `ui`                  | `.` and five subpaths                                                         | about 21/44 at the root, counted by grep          | private                                                           |
| `unreal-assets`       | `.` and four subpaths                                                         | 77/165, 8/9, 1/1, 2/2, 7/11                       |                                                                   |
| `unreal-connection`   | `.`                                                                           | 21/21                                             |                                                                   |
| `world`               | `.` / `./browser`                                                             | 27/27, 0/18                                       | public, no JSDoc guard                                            |

Relative imports into other workspaces' sources: 24 import statements in 16 files, all in
tests, test support or an e2e fixture.

- 17 reach six private Game Text `*.test-support.ts` modules.
- 2 reach the cameras test support.
- 4 reach extension sources from the site, the Workbench renderer tests and a Workbench e2e
  fixture.
- 1 reaches `packages/localization/src/review-file.js`. Its two names are already public in
  `@ue-shed/localization/browser`; fixed in this PR.

Production code has no deep imports.

## Top 15 recommendations

Ranked by how directly each one blocks or taxes a downstream host. "Done" means fixed in this PR;
"part" means this PR does the additive part and the rest is still a recommendation.

| #                                                                                                              | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Pri                                           | Size       | Kind                 | State |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------- | -------------------- | ----- |
| 1                                                                                                              | **Publish the authoring adoption boundary, or withdraw the promise.** `@ue-shed/authoring`, `authoring-sdk`, `host`, `ui` and `ui-theme` are private. [Vision](../vision-and-architecture.md) lines 189-190 say Data Authoring's "host-neutral UI and integration contract live behind public packages", and `README.md:90-91` points hosts at `examples/authoring-headless`, whose only dependencies are two private packages. The adoption kit vendors about 70 paths, including public `protocol`, `unreal-assets` and `unreal-connection` sources. A host that also installs those from npm has two copies, and tag and `Schema.is` checks fail across them.                    | P0                                            | L          | additive             | open  |
| 2                                                                                                              | **Make the localization write audit usable on real projects.** `snapshotLocalizationProject` hashes every project file outside seven scratch folders, `Content/` included, before and after every `loc run` and Game Text operation. It fails with `limit_exceeded` past 100,000 entries or 2 GiB (`packages/localization/src/operation-io.ts:91,110`). A typical game project is larger. This PR adds `makeLocalizationOperationsLayer({ auditLimits })`. The remaining fix is to audit only the plan's outputs and configs, or to compare size and mtime before hashing.                                                                                                          | P0 (likely; not reproduced on a real project) | S done / M | additive             | part  |
| 3                                                                                                              | **Let hosts add their own Remote Control classes to the UE 5.8 allowlist.** The allowlist was a closed map of UE Shed plugin IDs (`packages/engine/src/remote-control-permissions.ts:2-23`), so on UE 5.8 a host's own editor plugin was refused. This PR adds `remoteControlAllowedClasses` to the `with_plugins` launch mode and to `SupervisedEditorSessionRequest`, and exports `unrealRemoteControlPermissions` and `RemoteControlAllowedClass`. Still open: an `additionalArguments` field for other editor arguments.                                                                                                                                                        | P0 for hosts with their own RC plugin         | S          | additive             | part  |
| 4                                                                                                              | **Batch path lists inside `AssetReader`, and classify an oversized request as input.** The four path-taking reader operations do not batch (`packages/unreal-assets/src/asset-reader.ts:621-664`). Four production callers pass unbounded lists: asset-audits `texture.ts:528`, game-text `corpus.ts:995` and `workspace-id-repairs.ts:382`, and Workbench `project-workspace.ts:909`. Over 4 MiB the request fails as `contract` + `escalate` ("install the paired reader"), when it should be `fix_input` (`protocol-transport.ts:1129-1133`). Coordinate with the perf lane, which owns the transport.                                                                           | P1                                            | M          | additive + behaviour | open  |
| 5                                                                                                              | **Move the Workbench-only Map Review workflows into `@ue-shed/cameras` and `@ue-shed/observatory`.** About 1,250 of the 2,420 lines in `apps/workbench/src/main/services/map-review.ts` are domain workflow: the authoring candidate live preview (`:1639-1897`), shared live observation (`:468-811`), review-set views (`:1038-1240`), approval with stale-pose checks (`:1959-2086`), and the camera-set workspace and its storage layout (`camera-workspace.ts:98-432`). Tile and artifact verification is also Workbench-only (`map-capture.ts:351-406`), and review artifacts are read without checking `contentHash` (`map-review.ts:1050-1064`).                            | P1                                            | L          | additive             | open  |
| 6                                                                                                              | **Enforce the play-session capture guard in the library.** `evaluateReviewCapturePolicy` runs only in Workbench (`map-review.ts:1338-1354`). `ReviewCapture.captureSet` and CLI `review capture` (`apps/cli/src/workflows/review.ts:426-484`) can capture during PIE, which the Workbench refuses.                                                                                                                                                                                                                                                                                                                                                                                  | P1                                            | S          | additive             | open  |
| 7                                                                                                              | **Give the CLI-only capabilities a library entry point.** These are: the localization gate (`apps/cli/src/workflows/localization-gate.ts:74-204`); project plugin install (`apps/cli/src/plugin-installer.ts`, 687 lines, which also contradicts plugin-distribution `ADOPTING.md:27`); the authoring parity report (`apps/cli/src/workflows/authoring.ts:192-295`); Niagara video encoding (`scripts/encode-niagara-preview.ts`, script-only); and carry-across-gather. This PR moves carry-across-gather to `localizationCarryChanges` in `@ue-shed/game-text/corpus`.                                                                                                            | P1                                            | M each     | additive             | part  |
| 8                                                                                                              | **Publish test kits and transport contracts.** Add `./testing` subpaths. Today the Game Text fixtures and the in-memory index oracle are reached by relative path, and the Workbench rebuilds a 391-line index oracle (`game-text-index.test-support.ts`). Add a browser-safe `GameTextWorkspaceContract`, the 33 method→schema pairs the Workbench keeps privately (`apps/workbench/src/shared/ipc-contracts.ts:716-880`). Add a fake-editor Remote Control layer that owns a capability manifest; 28 test files hand-roll one. This PR adds test layers for MapCapture, Observatory, LocalizationOperations, PluginDistribution, CompiledPluginBuilder and three engine services. | P1                                            | M          | additive             | part  |
| 9                                                                                                              | **Remove the remaining base-not-constraints breaches.** These are the closed Game Text audience policy, `/debug/i` and `TextRenderComponent` exclusions (B5; `text-audience.ts:88`, `localization-checks.ts:283-305`); project-custodian's closed target set and file-only policy (`schema.ts:16-29`, `node-scanner.ts:28-30`); the closed texture-audit rule kinds and severities (`asset-audits/src/schema.ts:135-138`); and observability's closed health dimensions (`health.ts:10-60`).                                                                                                                                                                                        | P1                                            | M–L        | mixed                | open  |
| 10                                                                                                             | **Turn fixed run budgets into options with today's defaults.** Open: map tile batches, polling and timeouts (`map-tile-capture.ts:64-65,129,230,253,256`); Niagara commandlet timeouts (`preview.ts:45,1022,1061`); and the reader's `maximumOutputBytes` (`asset-reader.ts:35`). Done in this PR: the world-preparation request timeout and lease options, scenario deadlines, blueprint search hits, the `FileDropZone` size, and the localization audit limits.                                                                                                                                                                                                                  | P1                                            | S each     | additive             | part  |
| 11                                                                                                             | **Close the engine launch gaps.** `SupervisedEditorSessionLive` skips the build-ID and Remote Control validation that `UnrealProjectLauncherLive` runs (`project-launcher.ts:585-599`), so a mismatch shows up as a 3-minute readiness timeout. The supervisor executable path cannot be overridden for bundled hosts (`supervised-editor-session.ts:362-372`, `editor-window-activation.ts:88-95`). Engine identity reading was private. This PR exports `readEngineInstallation` and adds `EditorConnectionRequest.requestTimeout`.                                                                                                                                               | P1                                            | S          | additive + behaviour | part  |
| 12                                                                                                             | **Let hosts configure transport auth.** Done in this PR: `makeRemoteControlClient` now accepts `passphrase` and `headers`. Before, every request sent `unreal-rc`'s built-in default passphrase. Also done: `makeAuthoringHttpClient` accepts `headers` and `fetch`. Still open: `HttpPluginReleaseSourceOptions` has no `headers` for private registries (`source.ts:391-403`).                                                                                                                                                                                                                                                                                                    | P1                                            | S          | additive             | part  |
| 13                                                                                                             | **Fix the WASM package's types and give the WASM adapters a public home.** Under `moduleResolution: bundler`, the root `types` resolve the synchronous Node API (`index.d.ts` is `export * from "./node.js"`), while the bundler loads `browser.js`. Three extensions carry near-identical `wasm-reader.ts` adapters, and protocol has no schema for the generic inspect v8 shape.                                                                                                                                                                                                                                                                                                  | P1                                            | M          | additive             | open  |
| 14                                                                                                             | **Finish D9: one progress mechanism and one completeness shape.** There are four progress mechanisms. `GameTextWorkspaceProgress` has no schema and a `stage: string` (`workspace-host.ts:21-27`). Completeness uses five or more shapes (`status`, `completeness`, `truncated`, `omitted`). Concurrent texture-audit scans share one progress `Ref` (`texture.ts:664`).                                                                                                                                                                                                                                                                                                            | P1                                            | M          | partly breaking      | open  |
| 15                                                                                                             | **Extend the public-API guard and remove `export *`.** Nine published packages are outside `scripts/check-public-api.ts`: plugin-distribution, observability, config-explorer, project-custodian, world, observatory, niagara, blueprints and map-history. Across them there are 53 `export *` lines, and JSDoc coverage runs from 4% to 30% where it was                                                                                                                                                                                                                                                                                                                           |
| measured. Then remove Game Text's deprecated `.` and `./browser` aggregates, which are three releases overdue. | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | M                                             | breaking   | open                 |

## Cross-cutting patterns

**C1. Capabilities live in the shell, not the library.** These modules hold domain workflow with no
library entry point:

| Module                                 | Size              | What it holds                     |
| -------------------------------------- | ----------------- | --------------------------------- |
| Workbench `map-review.ts`              | about 1,250 lines | Map Review workflows (top 15 #5)  |
| Workbench `camera-workspace.ts`        | 330 lines         | camera-set workspace              |
| Workbench `asset-audits.ts`            | about 240 lines   | texture-audit query session       |
| Workbench `offline-texture-preview.ts` | 556 lines         | texture preview orchestration     |
| Workbench `project-workspace.ts`       | about 400 lines   | Project Index consumption         |
| Workbench `editor-responsiveness.ts`   | about 135 lines   | foreground supervision            |
| Workbench `niagara-preview.ts`         | about 250 lines   | Niagara catalogue and frame reads |
| CLI `plugin-installer.ts`              | 687 lines         | project plugin install            |
| CLI `localization-gate.ts`             | about 130 lines   | localization gate                 |
| CLI `workflows/authoring.ts`           | about 100 lines   | authoring parity                  |
| `scripts/encode-niagara-preview.ts`    |                   | Niagara video encoding            |

The deletion test in the vision passes for testability, because the CLI can drive most of these,
but not for reuse. Recommendation: move each one into a library service with host hooks, the way
D10 did for the Game Text workspace.

**C2. Policy constants live in code that a host cannot reach.** The pattern repeats: a module-level
`const` that is neither exported nor an option. Examples:

- tiles per request and lit batch size (`map-tile-capture.ts:63-65`);
- the Niagara pixel budget (`preview.ts:43`);
- the scenario document cap (`document-file.ts:7`);
- the saved-review change cap (`saved-review.ts:230,662`);
- investigation file caps (`investigation-files.ts:17,53`);
- the World Partition request timeout (`preparation.ts:220`);
- the Game Text workspace byte budgets (`workspace.ts:693` and five more, `workspace-investigation.ts:8-9`);
- observability's 30 s export interval;
- the 64 MiB `FileDropZone` limit.

Rule to adopt: a limit that a wire contract enforces is an exported constant; a limit that is
judgment is an option with today's value as the default. This PR applies the rule to the first
five and to the drop zone.

**C3. Error guidance is copied instead of imported.**

- Six packages keep a local copy of `ErrorGuidanceFields`: config-explorer
  `file-access.ts:4-10`, project-custodian `error-guidance.ts:3-8`, enhanced-input
  `project.ts:53-59`, niagara `schema.ts:178-183`, plugin-distribution `errors.ts:13-26` and
  localization `schema.ts:74-80`. Localization depends on protocol.
- Outside tests, 169 `nextStep: Schema.Literals([...])` declarations sit in 122 files. 54 of them
  are the full four-value list, which protocol already exports as `ErrorNextStep`.
- Two of the copies claim the package "does not depend on protocol", although it does.

Recommendation: a small `@ue-shed/protocol/errors` subpath (see protocol P-5), then delete the
copies. This continues D4.

**C4. Test layers exist for some services and not others.** D8 required complete test layers, but
measured coverage is uneven:

- **Missing** (several added in this PR, see below): MapCapture, Observatory,
  LocalizationOperations, PluginDistribution, CompiledPluginBuilder, EditorWindowActivation,
  EditorForegroundPermission and EditorForegroundResponsiveness.
- **Still `Partial`:** `makeCameraFeedTestLayer`.
- **Inconsistent naming:** `cameraRendererTestLayer`, `worldPreparationTestLayer` and
  `runtimeHealthLayer` against `make*TestLayer`.
- **No fake editor:** there is no Remote Control fake-editor layer at all.

**C5. Browser entries are safe, but only two were guarded.** All nine `./browser` entries checked
here are free of Node imports today. The guard in `check-effect-architecture.ts` walked only the
localization and Game Text closures. This PR adds `checkBrowserEntryClosures`. It walks every
package's `./browser` entry plus the documented browser-safe subpaths (map-history `./contract`,
`./playback` and `./diff`; observatory `./presentation`; three unreal-assets subpaths; cameras
`./map-tiles`), following workspace imports through their `exports`. Its regression test covers a
Node import, a `process` use and an unreviewed third-party dependency.

Two subset entries remain: cameras `./browser` is a strict subset of `.`, and observatory
`./presentation` is a subset of `./browser`. Cameras `./review-contracts` reaches `unreal-rc`
through `provisioned-cameras-live.ts`.

**C6. Cross-package type re-exports.** These continue the D1 pattern that was fixed for Game Text:

- unreal-assets re-exports about 39 protocol symbols (`index.ts:124-182`), and `./text-extraction`
  is a single protocol re-export;
- blueprints re-exports protocol's graph projection (`index.ts:1-10`);
- authoring re-exports seven protocol schemas (`review.ts:13-21`).

Recommendation: deprecate, then remove.

**C7. Brands and names collide.**

- `WorldId` in world and protocol use different validation (`world/src/schema.ts:9` against
  `protocol/src/index.ts:66`).
- `ActorId` in observatory and protocol differ the same way.
- `WorldVector` is defined twice.
- `AuthoringTableCatalogEntry` has two shapes (`authoring-catalog/src/index.ts:38` and
  `authoring-sdk/src/index.ts:156`).
- `Evidence` is defined in both enhanced-input and asset-audits with different reasons.
- `PluginInstallOptions` means different things in the library and the CLI.

A host importing both sides of any of these has to alias. This belongs with D3, the Unreal path
module.

**C8. Duplication that should be shared.**

- `failureParts` appears 4×, `plural` 5×, byte formatting 3× and the short object name 5×.
- Blueprint and Sequence asset search are 351 and 356 lines that differ in 19.
- There are three extension WASM adapters.
- The Project Index "read every page" loop appears 3× (`project-workspace.ts:178-233`,
  `countProjectIndexPages`, and a benchmark).
- The `AssetReaderError` → `MapHistoryError` mapping appears 3×.
- `.uproject` engine association parsing is copied in three Workbench services instead of using
  `parseUnrealProjectDescriptor`.

## Additive fixes in this PR

| Package                   | Change                                                                                                                                                                                                                                                 | Finding                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `unreal-connection`       | `makeRemoteControlClient({ passphrase?, headers? })`, with a test against a real HTTP server                                                                                                                                                           | UC-1                               |
| `engine`                  | `remoteControlAllowedClasses` on the `with_plugins` launch mode and on `SupervisedEditorSessionRequest`; exported `RemoteControlAllowedClass` and `unrealRemoteControlPermissions(pluginIds, additionalClasses?)`; test                                | E-1                                |
| `engine`                  | `readEngineInstallation(root)` exported                                                                                                                                                                                                                | E-3                                |
| `engine`                  | `makeEditorWindowActivationTestLayer`, `makeEditorForegroundPermissionTestLayer` and `makeEditorForegroundResponsivenessTestLayer`                                                                                                                     | E-4                                |
| `engine`                  | `EditorConnectionRequest.requestTimeout`                                                                                                                                                                                                               | E-6                                |
| `plugin-distribution`     | `githubReleaseSourceLayer({ assetNames? })`; `makePluginDistributionTestLayer` and `makeCompiledPluginBuilderTestLayer`, with a test                                                                                                                   | PD-2, PD-4                         |
| `localization`            | `makeLocalizationOperationsLayer({ auditLimits })`, `defaultLocalizationAuditLimits` and `LocalizationAuditLimits`, with a test                                                                                                                        | L1                                 |
| `localization`            | `makeLocalizationOperationsTestLayer`, now used by the Workbench test                                                                                                                                                                                  | L2                                 |
| `game-text`               | `GameTextIdRepairsApi` from `./workspace`, now used by Workbench                                                                                                                                                                                       | GT7                                |
| `game-text`               | `localizationCarryChanges` and `LocalizationCarryChanges` from `./corpus`; the CLI uses them instead of its private copy                                                                                                                               | H2                                 |
| `unreal-assets`           | `DEFAULT_TIMEOUT_MS` and `DEFAULT_CATALOG_TIMEOUT_MS` exported and documented                                                                                                                                                                          | UA3                                |
| `unreal-assets`           | `SAVED_REVIEW_MAX_CHANGES`, and `INVESTIGATION_PRESET_MAX_BYTES` / `INVESTIGATION_EXPORT_MAX_BYTES`, replacing magic numbers                                                                                                                           | UA9, Workbench investigation files |
| `cameras`                 | `MAP_TILE_CAPTURE_MAX_TILES_PER_REQUEST` from `.`, `./browser` and `./map-tiles`, used by the schemas and the runner                                                                                                                                   | CF5                                |
| `cameras`                 | `makeMapCaptureTestLayer`                                                                                                                                                                                                                              | CF10                               |
| `world`                   | `worldPreparationLayer(endpoint, { requestTimeout })` and `makeWorldPreparation(..., options)`; `withPreparedWorld(requirements, use, { leaseId, leaseMs })`; exported `WorldVector`, `WorldExtent`, `WorldLayerRequirement` and `WorldContract` types | W1, W2, W6                         |
| `observatory`             | `observatoryLayer`, which requires `EditorWindowActivation`; `ObservatoryLive` composes it with the engine's activation; `makeObservatoryTestLayer`, used by a Workbench test                                                                          | O3, Observatory test layer         |
| `niagara`                 | `NIAGARA_PREVIEW_MAXIMUM_TOTAL_PIXELS`; the pure `presentation` module exported from `./browser`                                                                                                                                                       | N2, N8                             |
| `blueprints`              | `searchBlueprint({ maximumHits? })`, with a test                                                                                                                                                                                                       | BP1                                |
| `map-history`             | browser-safe `./diff` subpath, documented, with a packed-consumer import                                                                                                                                                                               | MH1                                |
| `project-custodian`       | `resolvePolicyDocument`, `PolicyResolution` and `ProjectTargetDefinition` from `./browser` and `.`                                                                                                                                                     | PC-2 (part)                        |
| `uasset-inspection-wasm`  | `DEFAULT_LIMITS` declared in the browser and Node type entries                                                                                                                                                                                         | W2                                 |
| `scenarios` (private)     | `RunScenarioOptions.pieStartTimeout` / `resultTimeout`; `MAX_SCENARIO_DOCUMENT_BYTES` from `./files`                                                                                                                                                   | scenarios F2, F4                   |
| `authoring-sdk` (private) | `makeAuthoringHttpClient({ headers?, fetch? })`, with a test                                                                                                                                                                                           | authoring-sdk F1                   |
| `ui` (private)            | `FileDropZone` `maxBytes`                                                                                                                                                                                                                              | ui F1                              |
| `asset-audits` (private)  | `TextureAuditProgress` exported (the return type of `TextureAuditApi.progress`)                                                                                                                                                                        | asset-audits F7                    |
| repository                | `checkBrowserEntryClosures` architecture guard, with a regression test                                                                                                                                                                                 | C5                                 |
| extension test            | imports `@ue-shed/localization/browser` instead of a relative `src` path                                                                                                                                                                               | GT6                                |

## Per package

Each section lists the package's purpose, its entry points, what is well shaped, and its findings.
Findings already fixed in this PR say so.

### @ue-shed/protocol (public, JSDoc-guarded)

**Purpose and entry points.** Wire primitives, runtime schemas, compatibility, error guidance and
the language-neutral `contracts/`. One root entry, `.`, with 273 names, all retained.

**Well shaped.** Named exports, contract parsers, error guidance fields, and no Node imports.

| ID  | Finding                                                                                                                          | Why it hurts a host                                                                                   | Recommendation                                                                                               | Pri | Size | Kind     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --- | ---- | -------- |
| P-1 | `contracts/` is in `files` (`package.json:15-20`) but not in `exports`.                                                          | Non-TypeScript hosts cannot resolve the authoritative JSON schemas (`ERR_PACKAGE_PATH_NOT_EXPORTED`). | Add `./contracts/*`. `scripts/pack-public-packages.ts:365-368` rejects wildcard targets, so adjust it first. | P1  | S    | additive |
| P-2 | There are no capability-ID constants. 30+ IDs are string literals (`"game-text.actions.v1"` 11×, `"authoring.snapshot.v2"` 10×). | Hosts hand-type IDs for `requiredCapabilities` and manifest checks.                                   | A `CompanionCapability` literal schema or constant map in `companion.ts`.                                    | P1  | M    | additive |
| P-3 | `"/Script/UEShedCore.Default__UEShedCoreLibrary"` is repeated in 15 source files.                                                | It is a contract fact with no export.                                                                 | Export it from `companion.ts`.                                                                               | P2  | S    | additive |
| P-4 | The 16,384-byte companion request limit exists only in C++ and `unreal-connection/src/index.ts:173-181`.                         | Hosts cannot size requests before sending them.                                                       | Export a protocol constant.                                                                                  | P2  | S    | additive |
| P-5 | One heavy root (about 197 KB of JavaScript). Packages import all of it just for `ErrorGuidanceFields`, or copy the fields (C3).  | Load cost; duplication.                                                                               | `./errors` and `./companion` subpaths.                                                                       | P2  | M    | additive |

### @ue-shed/observability (public, not guarded)

**Purpose and entry points.** Shared telemetry, metrics and health. Entries: `.` (33 names, which
re-exports the others with `export *`), `./health` (9) and `./metrics` (21). `./health` and
`./metrics` are browser-safe.

**Well shaped.** The root lazily loads the Node SDK, and `spanProcessor` can be injected.

| ID  | Finding                                                                                                                                                                  | Why it hurts                                                                                    | Recommendation                                                                     | Pri | Size | Kind      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --- | ---- | --------- |
| O-1 | Nothing calls `RuntimeHealthService.report` in production. `doctor` and the Showcase only call `snapshot()`.                                                             | Health always reads `not_configured`.                                                           | Wire the connection, reader and stream producers to `report`, or drop the service. | P1  | M    | behaviour |
| O-2 | The health model is closed: fixed `connection`, `reader` and `telemetry` dimensions with a fixed severity policy (`health.ts:10-60`). `report` replaces the whole state. | A host cannot add a dimension or change what counts as unhealthy. Producers clobber each other. | Keyed components, an injectable policy, and `patch`.                               | P2  | M    | breaking  |
| O-3 | Feature metrics (Observatory 14, Map Review 4, cameras, authoring) live in the generic package (`metrics.ts:25-141`).                                                    | Adding a domain metric needs a UE Shed release.                                                 | Move them to their domain packages.                                                | P2  | M    | breaking  |
| O-4 | `observeOperation` counters carry no `operation` attribute (`metrics.ts:249-262`).                                                                                       | Per-operation rates are indistinguishable.                                                      | Tag the counters with the operation.                                               | P2  | S    | behaviour |
| O-5 | `TelemetryMode` is only `disabled \| console` and comes from the environment. The metric reader, the log processor and the 30 s interval are fixed.                      | OTLP metrics need a bypass.                                                                     | Accept `metricReader?`, `logRecordProcessor?` and `mode?`.                         | P2  | S    | additive  |
| O-6 | Nine OpenTelemetry packages are hard dependencies, even for `./health`-only consumers.                                                                                   | Install weight.                                                                                 | Make the SDK packages optional peers.                                              | P2  | S    | packaging |

### @ue-shed/unreal-connection (public, guarded)

**Purpose and entry points.** Remote Control transport, the negotiated authoring and automation
ports, asset locate/open, and `SelectedUnrealTarget`. One entry, `.`, with 21 names.

**Well shaped.** Explicit idempotency, no automatic retry, guidance-rich errors, and a complete
request test port.

| ID   | Finding                                                                                                                               | Why it hurts                                                                | Recommendation                                                                                        | Pri | Size | Kind     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --- | ---- | -------- |
| UC-1 | There was no `passphrase` or `headers` option. `unreal-rc` sent its built-in default passphrase on every request.                     | A host whose editor enforces an RC passphrase could not connect.            | **Done in this PR.** Still open: a redacted `Config` for the passphrase in `RemoteControlClientLive`. | P1  | S    | additive |
| UC-2 | No fake-editor test layer. 28 test files hand-roll a `GetCapabilityManifest` dispatcher.                                              | Hosts testing against UE Shed ports must reverse-engineer manifest routing. | `makeFakeUnrealEditorLayer({ manifest, handlers })`.                                                  | P1  | M    | additive |
| UC-3 | The manifest is re-fetched on every call (`index.ts:236,281,515,575,630`).                                                            | Extra round trips.                                                          | Accept an optional negotiated `manifest`.                                                             | P2  | S    | additive |
| UC-4 | `inspectUnrealProducer` (`index.ts:721-735`) leaks raw client and parse errors where its siblings return `UnrealConnectionError`.     | An inconsistent error union on the most-used entry.                         | Map them through `connectionError`.                                                                   | P2  | S    | breaking |
| UC-5 | A new `UnrealRC` client is created per request (`remote-control-client.ts:178-195`).                                                  | No connection reuse for pollers.                                            | Scope one client per endpoint.                                                                        | P2  | M    | additive |
| UC-6 | `SelectedUnrealTarget` has one consumer. `@ue-shed/host` keeps a parallel endpoint seam.                                              | Two "selected endpoint" concepts.                                           | Pick one.                                                                                             | P2  | M    | —        |
| UC-7 | There is no exported default endpoint. `http://127.0.0.1:30001` is repeated in Workbench config, 6 scripts and the adoption consumer. | Copy drift.                                                                 | Export the default.                                                                                   | P2  | S    | additive |

### @ue-shed/engine and @ue-shed/engine-win32-x64 (public, guarded)

**Purpose and entry points.** Engine discovery, the project launcher, supervised editor sessions,
and the editor ports (connection, play session, world control, window activation, foreground).
One entry, `.`, with 89 names. The win32 package ships only the supervisor executable.

**Well shaped.** Per-request readiness and world-control timeouts, an injectable registry query,
test layers for eight services, and scope-owned process trees.

| ID  | Finding                                                                                                                                                                                                             | Why it hurts                                                                | Recommendation                                                                                               | Pri               | Size | Kind      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------- | ---- | --------- |
| E-1 | The UE 5.8 RC allowlist was closed per UE Shed plugin ID, and there is no extra-arguments field.                                                                                                                    | A host's own RC plugin was refused on 5.8.                                  | **Done in this PR** (`remoteControlAllowedClasses`). Still open: `additionalArguments`.                      | P0 for such hosts | S    | additive  |
| E-2 | `SupervisedEditorSessionLive` skips `validateUnrealProjectBuildId` and `validateUnrealRemoteControlBuild`.                                                                                                          | A 3-minute readiness timeout instead of an immediate `build_mismatch`.      | Validate before spawning.                                                                                    | P1                | S    | behaviour |
| E-3 | Engine identity reading was private (`engine-installation.ts:225`). `.modules` BuildId reading is duplicated three times, and `installedEngineRoots` returns paths only.                                            | Hosts cannot build engine pickers or compiled-plugin variant requests.      | **Done in part** (`readEngineInstallation`). Still open: `readUnrealEditorBuildId` and a discovery `list()`. | P1                | S    | additive  |
| E-4 | No test layers for window activation, foreground permission or foreground responsiveness.                                                                                                                           | Hosts used raw `Layer.succeed`.                                             | **Done in this PR.**                                                                                         | P2                | S    | additive  |
| E-5 | The supervisor executable path cannot be overridden; `require.resolve` appears twice. The 3 s activation timeout is fixed.                                                                                          | Bundled hosts (Electron asar, SEA) cannot point at the unpacked executable. | A `supervisorExecutable` option and one shared resolver.                                                     | P1                | S    | additive  |
| E-6 | No per-probe timeout on `EditorConnectionRequest`. Workbench `fixture-launcher.ts:55-155` reimplements readiness.                                                                                                   | Duplicated readiness logic.                                                 | **Done in part** (`requestTimeout`). Still open: `expectedProducerKind`.                                     | P2                | S    | additive  |
| E-7 | Foreground backoff (1–30 s) and the release timeout are fixed (`editor-foreground-responsiveness.ts:119,161-163,463`). The WebSocket port is http+1, and `-NoLiveCoding` is forced (`project-launcher.ts:443-446`). | Policy a host may need to change.                                           | Options.                                                                                                     | P2                | S    | additive  |

### @ue-shed/plugin-distribution (public, not guarded)

**Purpose and entry points.** Verified source and compiled bundle acquisition, a caller-owned cache
with leases, local, HTTP and GitHub sources, and `CompiledPluginBuilder`. One entry, `.`, made of
8× `export *` with 137 names. About 95 of the 114 names unused in this repository are legitimate
host API: service contracts, release sources, variants, every tagged error, the build host and
publishing helpers.

**Well shaped.** Single-flight installs, a `limits` override, injectable source and store, and a
thorough error union.

| ID   | Finding                                                                                                                                                                                                                                                                                                                               | Why it hurts                                                                            | Recommendation                                                               | Pri | Size | Kind     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --- | ---- | -------- |
| PD-1 | Project install exists only in the CLI (`apps/cli/src/plugin-installer.ts`, 687 lines): ownership record, tamper check, `.uproject` edit, atomic swap and rollback. It hard-codes `Plugins/UEShed`, cannot be cancelled, and extracts the archive twice. Its library's `ADOPTING.md:27` tells hosts _not_ to install into `Plugins/`. | A host vendoring plugins must copy 687 lines. The CLI contradicts the library contract. | Decide the policy. If it is supported, move it to `installIntoProject(...)`. | P1  | M    | additive |
| PD-2 | `githubReleaseSourceLayer` hard-coded the Map Review asset names.                                                                                                                                                                                                                                                                     | Unusable for any other bundle.                                                          | **Done in this PR** (`assetNames`).                                          | P1  | S    | additive |
| PD-3 | `HttpPluginReleaseSourceOptions` has no `headers` or auth (`source.ts:391-403`).                                                                                                                                                                                                                                                      | Private registries need a full rewrite.                                                 | `headers`, dropped on cross-origin redirects.                                | P1  | M    | additive |
| PD-4 | No test layers.                                                                                                                                                                                                                                                                                                                       | Host code calling `install` cannot be tested cheaply.                                   | **Done in this PR.** Still open: in-memory source and store.                 | P2  | S    | additive |
| PD-5 | Not in the public-API guard. `splitUstarPath` leaks only for a test; six alias pairs and four UE Shed-specific asset-name helpers are public.                                                                                                                                                                                         | Accidental surface.                                                                     | Named exports, the JSDoc guard, and removal of the aliases.                  | P2  | M    | breaking |
| PD-6 | `PluginErrorGuidanceFields` copies protocol's fields (C3). The CLI `PluginInstallerError` always says `escalate`.                                                                                                                                                                                                                     | Duplication; input errors read as escalations.                                          | Reuse protocol; classify `fix_input`.                                        | P2  | S    | —        |

### @ue-shed/host (private, guarded)

**Purpose and entry points.** The authoring host composition. One entry, `.`, with 13 names.

**Findings.**

- `ShedHostConfiguration.remoteControlEndpoint` is a seam parallel to `SelectedUnrealTarget`
  (UC-6).
- The connection cache TTL (30 s) and capacity (4) are fixed (`authoring.ts:266-268`). P2, S,
  additive.
- Publication: see top 15 #1.

### @ue-shed/unreal-assets (public, guarded)

**Purpose and entry points.**

- `.` (Node): the reader, the Project Index, and the scan-target and native Game Text clients.
- `./investigation`, `./saved-review` and `./text-extraction` are browser-safe.
- `./investigation-files` is Node-only.

**Well shaped.**

- A complete `AssetReaderApi` port with a full test layer.
- Branded, generation-bound Project Index queries.
- A path-free `protocolObserver`.
- A parity test that pins the request limit to Rust.

| ID   | Finding                                                                                                                                                                                                                                                         | Why it hurts                                           | Recommendation                                                                                                        | Pri | Size | Kind          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --- | ---- | ------------- |
| UA1  | The reader does not batch path lists (top 15 #4). `MAX_PROTOCOL_REQUEST_BYTES` has 0 uses outside the package, and `batchProtocolPaths` has 1.                                                                                                                  | Large projects fail with a misleading error.           | Batch in `protocolProjectionStream` and `invokeProtocolScan`, and merge the summaries. Coordinate with the perf lane. | P1  | M    | additive      |
| UA2  | An oversized request maps to `contract` + `escalate` (`protocol-transport.ts:1129-1133`).                                                                                                                                                                       | Wrong recovery guidance.                               | `resource_limit` / `request_too_large` / `fix_input`.                                                                 | P1  | S    | behaviour     |
| UA3  | `maximumOutputBytes` is always 10 GiB (`asset-reader.ts:35`). The default timeouts were not exported. `readSavedWorld` silently uses the 50-minute catalog timeout (`:752`).                                                                                    | Hosts cannot bound output or see defaults.             | **Done in part** (timeouts exported and documented). Still open: a `maximumOutputBytes` option.                       | P1  | S    | additive      |
| UA4  | `assetReaderLayer()` defaults `executable` to `"uasset"` and spawns without a shell (`asset-reader.ts:877,905`; `protocol-transport.ts:728,817`). The npm `.cmd` shim therefore does not run on Windows, yet the docs point hosts at `@ue-shed/uasset`.         | Following the README gives a reader that cannot start. | Document `assetReaderLayer({ executable: resolveUassetExecutable() })`, or fall back to it when unset.                | P1  | S    | docs/additive |
| UA5  | There is no Project Index → scan adapter. The page loop is private (`countProjectIndexPages:497-531`), the `SavedAssetScan` that Workbench synthesizes (`project-workspace.ts:262-337`) is required by enhanced-input, and LevelSequence has no class constant. | Every Project Index host re-creates about 200 lines.   | `queryAllProjectIndex` and a header-based scan input. Coordinate with the perf lane.                                  | P1  | M    | additive      |
| UA6  | The root re-exports about 39 protocol symbols, and `./text-extraction` is a single re-export (C6).                                                                                                                                                              | Type leakage.                                          | Deprecate.                                                                                                            | P2  | S    | breaking      |
| UA7  | The browser-safe Project Index schemas are reachable only through the Node root.                                                                                                                                                                                | Browser hosts cannot name them.                        | A `./project-index` subpath.                                                                                          | P2  | S    | additive      |
| UA8  | Page-size and diagnostics bounds are copied from protocol (`project-index.ts:9,14`).                                                                                                                                                                            | Drift risk.                                            | Re-export protocol's values (perf-lane file).                                                                         | P2  | S    | —             |
| UA9  | The saved-review 5000-change cap is a magic number in 3 places.                                                                                                                                                                                                 | No constant.                                           | **Done in this PR** (`SAVED_REVIEW_MAX_CHANGES`).                                                                     | P2  | S    | additive      |
| UA10 | No `SavedReviewOutput` builder. The CLI hand-builds both shapes (`saved-review-workflows.ts:22-53`); inventory and reference resolution are Workbench-only (`ipc/saved-review.ts:67-82`).                                                                       | Copying.                                               | Builders.                                                                                                             | P2  | S    | additive      |
| UA11 | `AssetReaderError.code` is an open `Schema.String`. Two Workbench IPC files and three extension adapters switch on literal codes.                                                                                                                               | No exhaustive match.                                   | Publish the literal set.                                                                                              | P2  | S    | breaking      |
| UA12 | Contract-minor literals are spread over 8 sites in 5 files.                                                                                                                                                                                                     | Version drift.                                         | One table.                                                                                                            | P2  | S    | —             |

### @ue-shed/uasset, uasset-win32-x64 and uasset-inspection-wasm (public)

**@ue-shed/uasset** is clean: typed errors and `resolveUassetExecutable()` with no PATH fallback.
Its only gap is UA4.

**@ue-shed/uasset-inspection-wasm**

| ID  | Finding                                                                                                                                                                                   | Why it hurts                               | Recommendation                                                               | Pri | Size | Kind             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- | --- | ---- | ---------------- |
| W1  | Root `types` resolve to the synchronous Node API under `bundler` resolution, while bundlers load `browser.js`, whose `inspect()` returns a Promise.                                       | Wrong types for browser hosts.             | Conditional `types` per condition, or root types pointing at `browser.d.ts`. | P1  | S    | breaking (types) |
| W2  | `DEFAULT_LIMITS` was exported at runtime but not declared.                                                                                                                                | Unusable from TypeScript.                  | **Done in this PR.**                                                         | P2  | S    | additive         |
| W3  | Limits can only be narrowed; `maxExports` and `maxProjectionItems` cannot be set at all (`runtime.js:101-106`).                                                                           | No headroom for large assets.              | Options up to Rust's compile-time caps.                                      | P2  | M    | additive         |
| W4  | Limits are defined in 4 places (`lib.rs:42-51`, `runtime.js:26-31`, and two scripts).                                                                                                     | Drift.                                     | One source.                                                                  | P2  | S    | —                |
| W5  | The glue URL is always `import.meta.url`, and the runtime is a first-initialization singleton.                                                                                            | Bundler hosts cannot relocate the `.wasm`. | A `wasmUrl` option.                                                          | P2  | S    | additive         |
| W6  | There are three duplicated extension `wasm-reader.ts` adapters, and protocol has no schema for the generic inspect v8 shape (`legacy_ue3` is typed `Number`; the real value is nullable). | Hosts must copy a private adapter.         | Give the adapters and the schema a public home.                              | P1  | M    | additive         |

### Rust crates (host-facing surface)

**uasset-io.**

- **Host entry points:** `run(argv)`, `pub mod protocol` and `protocol_result`.
- **Well shaped:** `deny_unknown_fields`, per-minor field stripping, and typed `failed` with
  `retrySafe`.

| ID  | Finding                                                                                                                                                                                                               | Why it hurts                               | Recommendation                                     | Pri | Size | Kind      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | --- | ---- | --------- |
| U1  | Versioning is one-sided. `validate_contract` checks only the major version (`protocol.rs:577`); the worker echoes the request's minor; the maximum minor, 18, is implicit; `--version` prints only the crate version. | Non-TypeScript hosts cannot negotiate.     | `CONTRACT_*` constants and `uasset protocol-info`. | P1  | S–M  | additive  |
| U2  | The `rejected` event is never emitted. Decode failures print to stderr and exit 2 (`protocol_adapter.rs:63-73,101-111`), which kills a `protocol-session`. This contradicts ADR 0007.                                 | One bad request ends the session.          | Emit `rejected`.                                   | P2  | M    | behaviour |
| U3  | `limits.timeoutMs` is accepted but not enforced by Rust.                                                                                                                                                              | Misleading contract.                       | Document it as client-enforced.                    | P2  | S    | docs      |
| U4  | Blueprint and sequence input is capped at 64 MiB, while `inspect` and `authoring` read without a bound.                                                                                                               | Inconsistent bounds.                       | `maximumInputBytes` in `ResourceLimits`.           | P2  | M    | additive  |
| U5  | Concurrency defaults are 4 in the protocol and `available_parallelism` in the CLI. Discovery workers (32 and 16 threads) ignore `limits.concurrency`.                                                                 | Hosts cannot throttle.                     | Honour the limit (perf-lane files).                | P2  | S    | behaviour |
| U6  | `Request`, `Event` and `ResourceLimits` derive only `Deserialize`.                                                                                                                                                    | Rust hosts cannot run requests in-process. | Derive `Serialize` and an `execute` API.           | P2  | M    | additive  |
| U7  | Publication is undecided: 5 of 7 crates lack `publish = false`, and path dependencies have no version.                                                                                                                | A publish would fail.                      | Owner decision.                                    | P2  | S    | —         |

**uasset-parser.** `ArchiveLimits` cannot be applied to `Package::parse` and its siblings
(`package.rs:336-583`). Recommendation: `parse_with_limits`. P2, S–M, additive. Well shaped:
`forbid(unsafe)`, no `unwrap` or `expect`, and a real `SchemaProvider` seam.

**uasset-inspection.** `embedded_source_model()` is hard-wired in four modules, so a host's
`SchemaProvider` cannot reach inspection. Two different shapes are both called "inspect": WASM and
CLI produce snake_case v8, while the protocol produces camelCase. P2.

**game-text-index and the uasset-io catalog** belong to the perf lane. Findings only:

- `Operation::GameTextIndex` exposes `game_text_index` types in the public `Operation`.
- The Project Index scans only `<root>/Content` (`scanner/discovery.rs:100`), so plugin and Game
  Feature content is not indexed and this scope is undocumented.
- The 16 MiB engine payload is defined three times.

**engine-process-supervisor.** See E-5.

### @ue-shed/blueprints (public, not guarded)

**Purpose and entry points.** Pure, browser-safe graph index, layout, presentation and search.
One entry, `.`: 35 exports, 14 used.

**Well shaped.** Pure functions throughout, and portable SVG link paths.

| ID  | Finding                                                                                                                                 | Recommendation                            | Pri | Size | Kind     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --- | ---- | -------- |
| BP1 | The search hit cap of 500 was fixed.                                                                                                    | **Done in this PR** (`maximumHits`).      | P2  | S    | additive |
| BP2 | Layout geometry is a constant: `BLUEPRINT_LAYOUT`, the 760×480 minimum and the handle formula (`layout.ts:5-92`).                       | `layoutBlueprintGraph(graph, geometry?)`. | P2  | S–M  | additive |
| BP3 | Asset-level Blueprint search lives in Workbench main (`ipc/blueprint-graphs.ts:15-68`), and Sequences use a different, unranked search. | `searchSavedAssetCandidates`.             | P2  | S    | additive |
| BP4 | Re-exports protocol's projection and has 4× `export *` (C6).                                                                            | Named exports and deprecation.            | P2  | S    | breaking |
| BP5 | 7 of 26 exports are documented; `blueprintPinFlags` and `blueprintNodeDisplay` return anonymous types.                                  | Named types and the guard.                | P2  | S    | additive |

### @ue-shed/map-history (public, not guarded)

**Purpose and entry points.**

- `.` (Node, Perforce): 13× `export *`, 112 names.
- `./contract` and `./playback` are browser-safe.
- New in this PR: `./diff`.

**Well shaped.**

- Limits travel in the query, and the duration limit becomes a typed `resource_limit`.
- `mapHistoryLayer` takes its services from Context.
- There are Perforce test layers.

| ID  | Finding                                                                                                                                                | Recommendation                                                  | Pri | Size | Kind              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | --- | ---- | ----------------- |
| MH1 | The pure saved-world diff was Node-root only, and `extensions/content-observatory/src/world-log-actors.ts:49-59` re-implements the identity functions. | **Done in this PR** (`./diff`). The extension can switch to it. | P2  | S    | additive          |
| MH2 | `MAX_DIRECT_MAP_MOVES = 16` is not part of `MapHistoryLimits` (`perforce-map-scope.ts:32`).                                                            | Add it to the limits.                                           | P2  | S    | additive (schema) |
| MH3 | The `AssetReaderError` → `MapHistoryError` mapping is written 3× (two in the package, one in Workbench `content-observatory.ts:58-71`).                | Export one mapper.                                              | P2  | S    | additive          |
| MH4 | `perforceHistorySourceLayer(options: P4ClientOptions)` exposes a third-party type, and `mapHistoryLiveLayer` hard-wires `AssetReaderLive`.             | Document `mapHistoryLayer` composition.                         | P2  | S    | docs              |

### @ue-shed/enhanced-input (private)

**Purpose and entry points.** The Input Atlas. Entries: `.` (Node, 44 names) and `./browser` (27).

| ID  | Finding                                                                                                                                                                          | Pri                   | Size | Kind     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---- | -------- |
| EI1 | The package is private, so downstream hosts cannot use the Input Atlas at all. The CLI and the extension use it.                                                                 | P1 (package decision) | M    | additive |
| EI2 | It batches 100 paths by count, not by bytes (`project.ts:419-421`), and requires the synthesized `SavedAssetScan` (UA5).                                                         | P2                    | S    | additive |
| EI3 | It has a local `ErrorGuidanceFields` copy, `EnhancedInputPublicError` has no `nextStep`, and an options decode failure is labelled `scan_limit_exceeded` (`project.ts:521-531`). | P2                    | S    | —        |
| EI4 | `AtlasDevice` is closed to `gamepad\|keyboard\|mouse`, so touch, motion and vendor keys are classed as keyboard (`atlas.ts:12,80-84`).                                           | P2                    | S    | breaking |
| EI5 | `Evidence` is duplicated with asset-audits (C7).                                                                                                                                 | P2                    | S    | —        |

The CLI does a full scan while Workbench uses the header index, so their results can differ on
plugin content.

### @ue-shed/localization (public, guarded)

**Purpose and entry points.** Unreal localization formats, target discovery, change sets, review
files, commandlet operations and string-table migrations. Entries: `.` (171 names) and `./browser`
(129, verified free of Node imports).

**Well shaped.** `LocalizationLimits`, request-level `timeoutSeconds`, a configurable review path,
and evidence and file-access test layers.

| ID  | Finding                                                                                                                                 | Why it hurts                                  | Recommendation                                                                                                                                                                    | Pri | Size | Kind      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | --------- |
| L1  | The write-audit caps (top 15 #2).                                                                                                       | Blocks commandlet runs on large projects.     | **Done in part** (`makeLocalizationOperationsLayer({ auditLimits })`). Still open: audit only planned paths, or check mtime first. The audit also reads every byte twice per run. | P0  | S/M  | additive  |
| L2  | There was no operations test layer.                                                                                                     | Hosts hand-built `LocalizationOperations.of`. | **Done in this PR.**                                                                                                                                                              | P2  | S    | additive  |
| L3  | Library guidance text names CLI commands (`operation-plan.ts:61`; game-text `localization-gate.ts:128`, `localization-reports.ts:103`). | Wrong advice inside other hosts.              | Neutral wording, or host-supplied copy.                                                                                                                                           | P2  | S    | behaviour |

### @ue-shed/game-text (public, guarded)

**Purpose and entry points.**

- Browser-safe: `./schema`, `./rules`, `./checks`, `./labels`, `./corpus`.
- Node: `./index` and `./workspace`.
- Deprecated: `.` and `./browser`.

**Well shaped.**

- Named exports only, and the storage modules are private.
- `GameTextWorkspaceHost` has hooks for the project, files, rules location, recovery copy,
  reviewer and author.
- One index progress reporter.
- Check parameters, severity and enabled state come from the rules file.
- The Workbench Game Text services are now thin: id-repairs is 35 lines, operations 44.

| ID   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why it hurts                                                                   | Recommendation                                                                                                                                               | Pri | Size | Kind            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ---- | --------------- |
| GT1  | The deprecated `.` (569 names, 0 used) and `./browser` (484, 0 used) were "kept for one release" in 0.17.0 and still exist at 0.20.0. `main` and `types` point at the aggregate.                                                                                                                                                                                                                                                                                                                             | Editor auto-import picks the Node-mixed root.                                  | Remove them in the next breaking release; fix the README now.                                                                                                | P1  | S    | breaking        |
| GT2  | There is no published workspace contract. `GameTextWorkspaceApi` has 34 methods, some host-only, and the 33 method→schema pairs exist only in Workbench `ipc-contracts.ts:716-880`.                                                                                                                                                                                                                                                                                                                          | A host serving the workspace over its own IPC, WebSocket or MCP rebuilds them. | A browser-safe `GameTextWorkspaceContract` in `./schema`.                                                                                                    | P1  | M    | additive        |
| GT3  | No public test kit: only `makeTextCorpusServiceTestLayer`. Fixtures and oracles are private, and the Workbench copies 391 lines.                                                                                                                                                                                                                                                                                                                                                                             | Hosts cannot test a Game Text UI without a native reader and a project.        | `./testing` with fixtures, `textCorpusQuery`, `referenceNativeQuery` and an in-memory index layer. Five of the six support modules are browser-safe already. | P1  | M    | additive        |
| GT4  | D9 is still open: four progress mechanisms; `GameTextWorkspaceProgress` is an interface with `stage: string`; the workspace replaces phase codes with English text (`workspace.ts:279-291`); the quality signatures disagree (`index-contract.ts:72-118`).                                                                                                                                                                                                                                                   | Hosts re-narrow strings.                                                       | A schema with raw phase codes, plus `GAME_TEXT_INDEX_PHASE_LABELS`.                                                                                          | P1  | M    | partly breaking |
| GT5  | B5 remains: `TEXT_AUDIENCE_POLICY` is read directly by the classifiers and persisted by array position (`text-audience.ts:88,355,602-727`). `/debug/iu` and `TextRenderComponent` are fixed exclusions (`localization-checks.ts:283-305`). `MAX_GATE_ITEMS = 200` is built into the schema. The id-repair folder is fixed. CLI `loc check` reads only the default rules path. Game Text always uses the default review location and bypasses the host's `localizationFiles` hook (`index-steps.ts:638-642`). | Studio policy needs a UE Shed change.                                          | Policy in the rules file or host options, with the current preset as default. Exclusions become check params. Touches perf-lane cache keys and Rust.         | P1  | M–L  | mixed           |
| GT6  | Workspace byte budgets are fixed: rules 1 MiB ×6, report 16 MiB, lines 64 MiB, investigation 512 MiB, preset 4 MiB, id-repair 4 MiB.                                                                                                                                                                                                                                                                                                                                                                         | A host can lower them but never raise them.                                    | `limits` on `GameTextWorkspaceHost`.                                                                                                                         | P2  | S    | additive        |
| GT7  | Shape gaps: there was no `GameTextIdRepairsApi`; `makeGameTextWorkspaceLocalization` takes 4 positional arguments; the host passes `Layer.Layer<LocalizationFileAccess>`, contrary to D8; `checkLocalizationTarget` takes 5 positional arguments.                                                                                                                                                                                                                                                            | Awkward and inconsistent.                                                      | **Done in part** (`GameTextIdRepairsApi`). Still open: object arguments and requiring the service.                                                           | P2  | S    | mixed           |
| GT8  | Labels are split: the extension holds five label maps, the CLI holds gate labels, and the library's `textReviewSignalLabel` disagrees with the extension on three signals.                                                                                                                                                                                                                                                                                                                                   | Hosts pick inconsistent wording.                                               | Canonical maps in `./labels`.                                                                                                                                | P2  | S    | additive        |
| GT9  | Index composition is duplicated in the CLI and Workbench. The CLI reads `UE_SHED_PROJECT_INDEX_CACHE_ROOT` as a literal with a `~/.cache` default, contradicting `ProjectIndexConfig`.                                                                                                                                                                                                                                                                                                                       | Copying; inconsistent config.                                                  | `gameTextIndexNodeLayer(cacheRoot, options)`.                                                                                                                | P2  | S    | additive        |
| GT10 | `GameTextIndexRefreshResult` names private types (`index-contract.ts:7-21`).                                                                                                                                                                                                                                                                                                                                                                                                                                 | Hosts cannot name them, and internals leak into the public type.               | Opaque types (perf lane).                                                                                                                                    | P2  | M    | breaking        |

Host-side copies:

- **H1.** The gate orchestration is CLI-only (top 15 #7). P1, M, additive.
- **H2.** Carry-across-gather was CLI-only. **Done in this PR.** P2, S.
- **H3.** Filter-clause parsing is CLI-only, and its help text omits three fields
  (`apps/cli/src/workflows/text-filter.ts:8-43`). P2, S, additive.
- **H4.** Target and manifest resolution is repeated 3× in the CLI. P2, S.
- **H5.** There are three ways to load the rules file, and `createStarterTextRules` writes through
  `node:fs` directly (`rules-file.ts:60`). P2, S.
- **H6.** The deprecated `WorkbenchOperation*` names are still used 48× in the extension. P2, S.

### @ue-shed/cameras (public, guarded)

**Purpose and entry points.** Map Review schemas, framing, review capture, map tile pyramids,
camera arrangements and transports. Entries: `.` (476 names), `./review-contracts` (40),
`./map-tiles` (59) and `./browser` (279).

**Well shaped.**

- Render policy is a host-owned document validated against capabilities.
- Destinations are pluggable, and ports are separate from storage.
- Framing is pure and parameterised.
- `reviewCaptureRemotePortLayer` accepts `string | Effect<string>`.

| ID   | Finding                                                                                                                                                                                                                                                                          | Why it hurts                                                        | Recommendation                                                                                                                                                                | Pri | Size | Kind      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | --------- |
| CF1  | The authoring live preview is Workbench-only (`map-review.ts:1639-1897`, about 330 lines plus policy constants).                                                                                                                                                                 | Hosts offering reframe and preview copy it.                         | `ReviewAuthoringPreview`, plus a pure `livePreviewSchedule`.                                                                                                                  | P1  | L    | additive  |
| CF2  | The camera-set workspace and its storage layout (`.ue-shed/camera-sets/<sha256(id)[0..20]>/`) are Workbench-only (`camera-workspace.ts:98-432`).                                                                                                                                 | Neither the CLI nor library hosts can find Workbench's camera sets. | `cameraSetsRoot`, `listCameraArrangements`, `CameraArrangementWorkspace`.                                                                                                     | P1  | M    | additive  |
| CF3  | The PIE capture guard is Workbench-only (top 15 #6).                                                                                                                                                                                                                             | Captures during PIE.                                                | A guard in `captureSet`, or `captureSetGuarded`.                                                                                                                              | P1  | S    | additive  |
| CF4  | Verified tile and artifact reads are Workbench-only, and review artifacts are not hash-checked.                                                                                                                                                                                  | Hosts copy the reads, and integrity is not checked.                 | `ReviewRepository.readArtifact` and `MapCaptureRepository.readTile`.                                                                                                          | P1  | M    | additive  |
| CF5  | Tile capture policy is fixed: 64 per request, a lit batch of 4, 1M maximum tiles, and poll and timeouts of 5 s / 30 s / 200 ms / 15 min. 64 duplicates the native capability.                                                                                                    | Hosts cannot lower batches for memory or raise timeouts.            | **Done in part** (`MAP_TILE_CAPTURE_MAX_TILES_PER_REQUEST` exported and used). Still open: `tilesPerBatch` and timeout options on `RunMapCaptureOptions` and the remote port. | P1  | S    | additive  |
| CF6  | `runMapCapture`, `runMapCapturePlan` and `captureReviewSet` construct their own RC client (5 min and 10 s) and repository (`map-tile-capture.ts:1040-1070`, `review-capture.ts:770-782`). `mapTileCaptureRemotePortLayer` and `cameraRendererLayer` take only a string endpoint. | The host's client, telemetry and repository are bypassed.           | Accept a client and repository, or document `MapCaptureLive` composition.                                                                                                     | P2  | S    | additive  |
| CF7  | Review-set view projection and the approve and start-session steps are duplicated between the CLI and Workbench. The CLI lacks the stale-pose checks.                                                                                                                            | Behaviour drift.                                                    | `approveCandidateFromSelection` and a pure `reviewSetView`.                                                                                                                   | P2  | M    | additive  |
| CF8  | Workbench ignores project framing parameters (`map-review.ts:1478,1626,1980,2043`), and the `editor_view` candidate uses `defaultMargin` (`review-framing.ts:465`).                                                                                                              | Projects cannot change framing in Workbench.                        | Pass the parameters through and fix the margin.                                                                                                                               | P2  | S    | behaviour |
| CF9  | Entry hygiene: `./browser` is a strict subset of `.`; `./review-contracts` reaches `unreal-rc`; the `CameraFeed` implementation (about 600 lines) sits in `index.ts`.                                                                                                            | Three import paths for the same names.                              | Move the provisioned-camera types into a schema module.                                                                                                                       | P2  | M    | mixed     |
| CF10 | No MapCapture test layer; `makeCameraFeedTestLayer` takes a `Partial`; extension tests import cameras test support by relative path.                                                                                                                                             | Incomplete fakes.                                                   | **Done in part** (`makeMapCaptureTestLayer`). Still open: `./testing`.                                                                                                        | P2  | S    | additive  |
| CF11 | `map-review.ts` has 25 `Effect.catch` calls and 5 `String(cause)`; `fitMapCapturePlanToSelection` throws `RangeError`; the extension re-validates plan bounds by hand.                                                                                                           | Lost causes; duplicated validation.                                 | Typed failures, and `mapCapturePlanIssues(plan, capabilities)`.                                                                                                               | P2  | M    | —         |

### @ue-shed/world (public, not guarded)

**Purpose and entry points.** World Partition preparation leases. Entries: `.` and `./browser`
(schema only).

**Well shaped.** Contract-checked wire schemas, full error guidance, and careful restoration.

| ID  | Finding                                                                                                                  | Recommendation                                 | Pri | Size | Kind     |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | --- | ---- | -------- |
| W1  | The 30 s RC timeout was fixed (`preparation.ts:220`).                                                                    | **Done in this PR** (`requestTimeout` option). | P1  | S    | additive |
| W2  | `withPreparedWorld` could not pass a lease ID or duration, so callers got 120 s.                                         | **Done in this PR.**                           | P1  | S    | additive |
| W3  | Fixed lease policy: a progress buffer of 16, one silent reconnect, and renewal at `leaseMs/3`.                           | Options.                                       | P2  | S    | additive |
| W4  | `code` is `Schema.String` although `worldPreparationGuidance` handles 20 codes, and one recovery text covers every code. | A literal union.                               | P2  | S    | breaking |
| W5  | `worldPreparationGuidance` is Node-root only.                                                                            | Move it to a browser-safe module.              | P2  | S    | additive |
| W6  | `WorldVector`, `WorldExtent`, `WorldLayerRequirement` and `WorldContract` had no types.                                  | **Done in this PR.**                           | P2  | S    | additive |
| W7  | `worldPreparationTestLayer` is unused, and there are 7 hand-written lease fakes.                                         | A lease fake.                                  | P2  | S    | additive |
| W8  | The `WorldId` brand collides with protocol's (C7).                                                                       | D3.                                            | P2  | S    | breaking |

### @ue-shed/observatory (public, not guarded)

**Purpose and entry points.** Actor discovery and live state. Entries:

- `.` (Node: `node:net`, the engine root);
- `./browser`;
- `./presentation` (a subset of `./browser`).

**Well shaped.** Pure `applyWorldObservationEvent` and `applyTransformBatch`, and recovery budgets
as options.

| ID  | Finding                                                                                                                                                                                                                         | Recommendation                                                              | Pri | Size | Kind     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --- | ---- | -------- |
| O1  | Shared live observation (ref counting, pause around exclusive work, diffing, 60 Hz coalescing, wire encoding) is Workbench-only (`map-review.ts:104-157,468-811`). Its schema lives in Workbench IPC and the renderer re-diffs. | `shareObservation(...)` plus browser schema and codecs.                     | P1  | M    | additive |
| O2  | Editor-foreground liveness supervision is Workbench-only (`editor-responsiveness.ts:84-218`).                                                                                                                                   | Move it to engine.                                                          | P1  | M    | additive |
| O3  | `ObservatoryLive` built its own window activation.                                                                                                                                                                              | **Done in this PR** (`observatoryLayer` requires `EditorWindowActivation`). | P1  | S    | additive |
| O4  | Fixed backoff (200 ms·2ⁿ, capped at 5 s), a 1–10 Hz polling clamp, and one capacity driving two buffers.                                                                                                                        | Options.                                                                    | P2  | S    | additive |
| O5  | `attemptFailed` drops the cause; `RecoveryExhausted` and `SessionError` have no `cause` (`actor-feed.ts:330-347,740-758`).                                                                                                      | Keep the causes.                                                            | P1  | S    | additive |
| O6  | `observe` takes a plain number while `setObservationCadence` takes a brand; negotiated limits are dropped.                                                                                                                      | Use the brand.                                                              | P2  | S    | breaking |
| O7  | Internal duplication: `SnapshotResponse` twice, and `catalogFromSnapshot` against `catalogFromWireEntries`.                                                                                                                     | Merge them.                                                                 | P2  | S    | —        |
| O8  | Leftover `*Shape` aliases, 7× `export *`, a test-only `corrupt?` field on a public encoder type, and an unused `projectActors`.                                                                                                 | Clean up.                                                                   | P2  | S    | breaking |
| O9  | There are no CLI observatory commands, although the README promises snapshot and focus.                                                                                                                                         | Add them, or fix the README.                                                | P2  | S    | —        |
| O10 | No Observatory test layer; Workbench hand-built 8 fakes.                                                                                                                                                                        | **Done in this PR** (`makeObservatoryTestLayer`).                           | P2  | S    | additive |

### @ue-shed/niagara (public, not guarded)

**Purpose and entry points.** Headless Niagara preview runs. Entries: `.` and `./browser`.

**Well shaped.** Versioned contract fixtures, branded IDs, an exit-code-to-failure map, atomic
publish, and a test layer.

| ID  | Finding                                                                                                                                                  | Recommendation                                                                                                       | Pri | Size | Kind      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --- | ---- | --------- |
| N1  | Video and poster encoding exist only in `scripts/encode-niagara-preview.ts:69-190`, which reaches an unexported module by relative import.               | `encodeNiagaraPreviewVideo` and a presentation record schema.                                                        | P1  | M    | additive  |
| N2  | Fixed timings: commandlet 30 min, termination grace 15 s, poll 250 ms; the session timeout is not forwarded. The pixel budget was unexported.            | **Done in part** (`NIAGARA_PREVIEW_MAXIMUM_TOTAL_PIXELS`). Still open: timing options on `RunNiagaraPreviewOptions`. | P1  | S    | additive  |
| N3  | Diagnostics thresholds (`preview.ts:353,359`) and presentation-selection heuristics (`presentation.ts:91-123`) are fixed.                                | A policy argument with today's defaults.                                                                             | P1  | S    | additive  |
| N4  | The run pipeline is one closure. `submitNiagaraSessionRequest` and the session arguments are private.                                                    | Expose the pieces.                                                                                                   | P1  | M    | additive  |
| N5  | Workbench-only: `.uproject` association parsing (duplicating engine), plugin discovery, the Niagara System catalogue and frame reads.                    | A library catalogue and reads.                                                                                       | P1  | M    | additive  |
| N6  | `safeIo` maps every session error to `process_failed` + `retrySafe: true` (`preview.ts:1037-1052`), overriding the session's `reconcile` and `escalate`. | Keep the session guidance, because a retry may resubmit a running capture.                                           | P1  | S    | behaviour |
| N7  | `NiagaraPreviewFailure` has no `nextStep`; the guidance fields are copied (C3); Workbench wires no progress.                                             | Align with D4.                                                                                                       | P2  | S    | mixed     |
| N8  | `./browser` omitted the pure `presentation` module.                                                                                                      | **Done in this PR.**                                                                                                 | P2  | S    | additive  |
| N9  | The CLI copies literal lists and bounds 3×, and hand-merges 13 overrides instead of calling `niagaraPreviewProfile`.                                     | Reuse the library.                                                                                                   | P2  | S    | —         |

### @ue-shed/config-explorer (public, not guarded) and extensions/config-explorer

**Purpose and entry points.** Saved config provenance. Entries: `.` and `./browser` (merge,
parser, schema).

**Well shaped.** The hierarchy mirrors Unreal's fixed behaviour (layers and the `NotForLicensees`,
`NoRedist` and `LimitedAccess` folders), so it is correctly not configurable. The Workbench wrapper
is plumbing only.

**Findings.**

- **C-1.** A local `ConfigErrorGuidanceFields` duplicates protocol's (C3). P2, S, breaking.
- **C-2.** The service only explains and compares a single key; it cannot list sections or keys.
  P2, M, additive.

### @ue-shed/project-custodian (public, not guarded) and extensions/project-custodian

**Purpose and entry points.** Reclaimable Unreal workspace storage. Entries: `.` and `./browser`
(schema and policy).

| ID   | Finding                                                                                                                                                                                                  | Recommendation                                                                                               | Pri | Size | Kind     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --- | ---- | -------- |
| PC-1 | The target set is closed: `ProjectTargetKey` is a literal union, and per-target risk, `defaultOn` and the minimum age are fixed (`schema.ts:16-29`, `policy.ts:15-126`).                                 | Targets as policy data, with today's list as the default preset.                                             | P1  | M    | breaking |
| PC-2 | Policy comes only from the project file. The scan request has no `policy`. Depth 8, concurrency 4 and the 30-day heuristic are fixed (`node-scanner.ts:28-30,502`). `resolvePolicyDocument` was private. | **Done in part** (`resolvePolicyDocument` exported). Still open: `policy?` and `scanLimits?` on the request. | P1  | S–M  | additive |
| PC-3 | Workbench drops `CustodianError.code` (`project-custodian.ts:50-55,100,118`).                                                                                                                            | Pass it through.                                                                                             | P2  | S    | app      |
| PC-4 | A local `ErrorGuidanceFields` copy (C3).                                                                                                                                                                 | Use protocol's.                                                                                              | P2  | S    | —        |

### @ue-shed/asset-audits (private) and extensions/asset-audits

**Purpose and entry points.** Saved Texture2D audit. Entries: `.` (Node) and `./browser`.

**Well shaped.** Rules are a versioned project document with per-rule thresholds and severity;
`concurrency` and `maximumAssets` are options; there are service, live and test layers; and the
CLI is thin.

| ID  | Finding                                                                                                                                                                                                                                                                                      | Recommendation                                                                                         | Pri | Size | Kind     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --- | ---- | -------- |
| AA1 | Query session, preset override, refresh cache and progress mapping exist only in Workbench (`services/asset-audits.ts:105-341`), and there is no transport contract.                                                                                                                         | `TextureAuditWorkspace` plus a transport schema, as D10 did for Game Text.                             | P1  | M    | additive |
| AA2 | Offline texture preview is Workbench-only (`offline-texture-preview.ts`, 556 lines). It re-implements engine discovery with plain `JSON.parse`, swallows parse failures, falls back silently to the newest engine, and always looks for `UnrealEditor-Cmd`, so UE 4.x roots are never found. | A library service over `@ue-shed/engine`. First check whether the preview commandlet supports UE 4.27. | P1  | M    | additive |
| AA3 | Rule kinds and severities are closed unions (`schema.ts:126-154`, `texture.ts:233-327`).                                                                                                                                                                                                     | An evaluator hook (B5/B6 pattern).                                                                     | P1  | M    | breaking |
| AA4 | Report assembly is private, so changing rules forces a full rescan (`texture.ts:451-490`, Workbench `:568`).                                                                                                                                                                                 | A pure `reevaluateTextureAudit(report, rules)`.                                                        | P1  | S    | additive |
| AA5 | Fixed presentation caps: buckets 256/512/1024, diagnostics 100, findings 100, peers 5, cohort 3.                                                                                                                                                                                             | Bucket option; export the caps.                                                                        | P2  | S    | additive |
| AA6 | Duplication: `DistributionSelection` is a hand-written copy of the schema type; `matchesSelection` appears 2×; the error projection appears 2× in Workbench; preview prioritisation appears 2×.                                                                                              | Merge.                                                                                                 | P2  | S    | —        |
| AA7 | `ExtractionProgress` was public by return type but unexported, and concurrent scans share one `Ref`.                                                                                                                                                                                         | **Done in part** (`TextureAuditProgress`). Still open: progress per scan (D9).                         | P2  | S    | additive |
| AA8 | The CLI exposes neither `--concurrency` nor `--max-assets`, has no CI exit policy, and has no CSV or investigation export.                                                                                                                                                                   | Flags.                                                                                                 | P2  | S    | additive |

### @ue-shed/authoring, authoring-catalog and authoring-sdk (private)

**Purpose and entry points.**

- **authoring:** DataTable drafts, review, live apply and save, relationships, analysis and the
  session service. The root is Node-only through `session-service.ts`.
- **authoring-catalog:** saved and live catalog merge.
- **authoring-sdk:** the browser-safe client contract, an HTTP client and a dispatcher. It is the
  best-shaped package in this group.

**Well shaped.**

- The session service has a swappable repository and ID generator.
- Drafts are pure, and `defaultAuthoringMutationLimits` is exported.
- The catalog service has a test layer and a `concurrency` option.

| ID   | Finding                                                                                                                                     | Recommendation                                     | Pri | Size | Kind     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --- | ---- | -------- |
| AU1  | Privacy (top 15 #1).                                                                                                                        | Publish the boundary, or change the documentation. | P0  | L    | additive |
| AU2  | No browser entry for the pure core: 7 of 8 modules have no Node import. `./review-contracts` has 0 consumers.                               | `./browser`; drop `./review-contracts`.            | P1  | S    | mixed    |
| AU3  | Saved/live parity exists only in the CLI and builds an unschematized v1 contract inline (`apps/cli/src/workflows/authoring.ts:192-295`).    | `authoringParityReport` plus a schema.             | P1  | M    | additive |
| AU4  | "Read all project tables" is copied 3× in the CLI with concurrency 4.                                                                       | A helper with `concurrency`.                       | P2  | S    | additive |
| AU5  | `AuthoringSessionSummary` is a hand-written interface that drifts from the SDK schema (`needsSave` required in one, optional in the other). | Derive it from the schema.                         | P2  | S    | —        |
| AU6  | Value formatting and parsing live in the Solid extension (`authoring-view.ts:15-146`, `authoring-grid-model.ts:137-185`).                   | Move them to the library.                          | P2  | S    | additive |
| AU7  | `buildAnalysisPlan` always appends suggestions; the bin cap (24) and point cap (1000) are fixed.                                            | Options.                                           | P2  | S    | additive |
| AC1  | `AuthoringTableCatalogEntry` has two shapes (C7).                                                                                           | Rename one.                                        | P2  | S    | breaking |
| SDK1 | The HTTP client could not send auth headers or use a custom fetch.                                                                          | **Done in this PR.**                               | P1  | S    | additive |

### @ue-shed/scenarios (private) and extensions/scenarios

**Purpose and entry points.** Scenario documents, timeline, live contract and runner. Entries:
`./files`, `.` and `./browser`.

| ID  | Finding                                                                                                                                                                                                                                                                   | Recommendation                                               | Pri | Size | Kind     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --- | ---- | -------- |
| SC1 | Live execution is hard-wired to the Movement Gym fixture: `/Game/Fixture/Input/IA_*` paths (`live.ts:157-161`), a closed `Move\|Jump\|Interact` union, exactly 4 actions and 11 keyframes, and fixed probe times. This contradicts AGENTS.md's "no fixture/studio paths". | Generalise the contract; the wire is shared with C++.        | P1  | L    | breaking |
| SC2 | Fixed deadlines: PIE start 15 s and result 45 s, so any scenario over 45 s always fails with `poll_timeout`.                                                                                                                                                              | **Done in this PR** (`pieStartTimeout` and `resultTimeout`). | P1  | S    | additive |
| SC3 | Workbench IPC turns `ScenarioRunnerError` into defects (`ipc/scenarios.ts:52,57,72`).                                                                                                                                                                                     | Keep the typed errors.                                       | P2  | S    | app      |
| SC4 | The 4 MiB document cap was private.                                                                                                                                                                                                                                       | **Done in this PR** (`MAX_SCENARIO_DOCUMENT_BYTES`).         | P2  | S    | additive |

### @ue-shed/ui and @ue-shed/ui-theme (private)

**Well shaped.**

- `createTheme(tokens, partial)` lets a host brand the UI without global selectors.
- `tokens` is exported.

| ID  | Finding                                                                                                                                                                 | Recommendation                                                             | Pri | Size | Kind      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --- | ---- | --------- |
| UI1 | `FileDropZone` fixed the limit at 64 MiB and assumes a `<main>` ancestor.                                                                                               | **Done in part** (`maxBytes`). Still open: drop-target scoping.            | P2  | S    | additive  |
| UI2 | Extensions copy helpers `@ue-shed/ui` lacks: `failureParts` 4×, `plural` 5×, bytes 3×, short object name 5×, and asset search 2× (351 and 356 lines that differ in 19). | Add `format.ts` and a generic `ProjectAssetSearch`.                        | P2  | M    | additive  |
| UI3 | Literals bypass the theme: the accent `#7cc0ff` appears 29× and white tints 52×; Data Authoring chart colours are fixed, so `ADOPTING.md:71` is wrong for charts.       | Tokens for accent-active and hover/active tints, and a chart palette prop. | P1  | S–M  | additive  |
| UI4 | `themes.stylex.ts` repeats every token value; the `workbenchDarkTheme` alias remains.                                                                                   | Derive one from the other.                                                 | P2  | S    | —         |
| UI5 | Extension copy names Workbench in host-neutral UI ("Restart Workbench…").                                                                                               | Neutral wording.                                                           | P2  | S    | behaviour |
| UI6 | Actor-preset helpers read `window.localStorage` directly.                                                                                                               | Inject the storage.                                                        | P2  | S    | additive  |

### Extensions and apps/cli (summary)

- **Extensions** depend only on public package entries in production code. The deep imports are
  all in tests (see Method). A `./testing` subpath per package (top 15 #8) removes them.
- **The CLI** is thin over libraries for `editor`, `config`, `custodian`, `plugins cache`, `audit`
  and most of `loc`. The exceptions are listed in C1. It repeats the same `CliCommandError` recovery
  string 50×.
- **Workbench main** keeps domain policy in nine services (C1). The other services are thin
  adapters.

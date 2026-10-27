# Adopt Game Text into an existing host

This guide is for the coding agent integrating the headless Game Text Module into an established
trusted host. Read [`adoption.manifest.json`](adoption.manifest.json) first. Do not inspect or copy
Workbench unless a named verification failure leaves the public package contract insufficient.

## Fast path

1. Inspect the target's package manifest, Node version, Effect version, selected-project model, and
   saved-asset reader configuration. The Node entry supports Node 22.15+ in the 22.x line, or
   Node 23.8+ (including 24 and 26); Node 22.14 lacks the required built-in Zstd APIs.
2. Install the exact `@ue-shed/game-text` version and supply one application-owned
   `effect@^4.0.0` installation satisfying its peer dependency. Reuse a compatible existing
   `@ue-shed/unreal-assets` and `@ue-shed/uasset` installation when present.
3. In the target's trusted Node process, compose `GameTextIndexBuilderLive` with the host's
   existing `AssetReader`, source and localization evidence layers.
4. Adapt the host's selected project to `gameTextIndexStepsLayer` or the convenience
   `gameTextIndexRefreshLayer`. Prepare explicitly and retain the opened native model in a scope.
5. Expose schema-validated progress, cached `model.summary`, asynchronous bounded native search and
   focus using the host's transport. Keep full corpus exports behind explicit bulk operations.
6. Add an adopter-owned view only if the host needs one. This bundle contains no maintained UI and
   requires no Solid, StyleX, Electron, or Workbench package.
7. Prove the acceptance journey below and record the exact package versions, reader provider, target
   files, project input, and verification commands in the host repository.

## Migrating to 0.23

The root and `/browser` aggregates, their `main`/`types` fallbacks, and deprecated names were
removed. Import browser-safe schemas from `/schema`, rule documents from `/rules`, checks and
filter helpers from `/checks`, and presentation labels from `/labels`. Node hosts use `/corpus`
for corpus queries and reports, `/index` for scanning and native index composition, and
`/workspace` for selected-project workflows and operations.

| Old import or name                                                                                 | Replacement                                                                            |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `@ue-shed/game-text`, `@ue-shed/game-text/browser`                                                 | The focused entry point that owns each name, listed above                              |
| `WorkbenchOperation*`                                                                              | Corresponding `GameTextOperation*` from `/schema`                                      |
| `ScanTextCorpusOptions`                                                                            | `TextCorpusScanOptions` from `/index`                                                  |
| `TextCorpusServiceShape`, `TextCorpusServiceTestShape`                                             | `TextCorpusServiceApi`, `TextCorpusServiceTestApi` from `/index`                       |
| `TextReviewLens`                                                                                   | `TextFilter` clauses from `/schema`: `finding` for rule IDs, `fact` for review signals |
| `TextFinding`, `TextCountedFindings`, `textFindings`, `textCountedFindings`, row `countedFindings` | Row `findings` rule IDs (`TextRowFindings` from `/checks`)                             |
| `GameTextIndexStepsOptions.qualityWorker`                                                          | Omit it; quality runs in the native engine                                             |
| `gameTextCsv`                                                                                      | `NativeTextQuery.writeCorpusCsv` on the opened index query                             |
| `localizationLinesCsv`                                                                             | `NativeTextQuery.writeLocalizationLinesCsv` on the opened index query                  |
| `prepareLocalizationFile`                                                                          | Native index imports through `GameTextIndexSteps.importTarget` from `/index`           |

Saved investigation presets that still carry a `lens` keep working: `investigationRequest` reads
it as its clause. `shared`, `duplicate_source` and `long` become `finding` clauses naming
`localization.<check>`, `unresolved` and `conflicting` become `fact` clauses, and `all` adds no
clause. New presets use `filter`.

## Ownership

- UE Shed owns the installed package and its schemas.
- The adopting host owns project selection, runtime composition, transport Adapter, caching policy,
  route, presentation, and navigation.
- Browser code receives only bounded schema-validated results. It must not receive the corpus,
  filesystem paths beyond returned evidence, process authority, or the reader executable.
- Do not import `apps/workbench`, `extensions/game-text`, or Workbench transport modules.
- Do not add `@ue-shed/uasset` as a hidden dependency of Game Text. The host deliberately selects
  the default launcher or an explicit compatible executable.

## Interactive workspace

Use `makeGameTextWorkspace(host)` from `@ue-shed/game-text/workspace` for scanning, search,
quality rules, localization, edits, review, reports and investigations without copying Workbench.
Compose the same index steps and localization evidence layers described below. Build the workspace
inside the host's long-lived scope; individual requests may disconnect while its scan continues. Keep
`LocalizationEvidence` in the workspace context alongside `GameTextIndexSteps`, for example by
using `Layer.provideMerge(LocalizationEvidenceNodeLive)` when composing the steps layer.
A reconnect observing the scan's refreshed project generation joins that producer. Closing the
workspace scope releases its scans, readers and workers.

The host supplies its current selected project, refresh and candidate inventory. It retains sole
project-selection authority. Supply file hooks for dialogs or fixed paths, bounded reads and writes.
`writeFile` must create parent directories as needed and honor `exclusive: true`: starter creation
must never replace existing rules. A refusal is returned without bypassing the host's store.
Set `rulesRelativePath` to choose the project-relative rules location, and `recoveryCopy` to preserve
previous bytes before Save. A failed read or recovery copy stops the overwrite. `localizationFiles`
controls PO/review writes separately; `reviewer` and `changeAuthor` supply attribution policy.

`makeGameTextOperations(host)` adds plan/run/cancel and changed-file operations. Supply the workspace,
selected-project state, explicit engine-root policy and progress notification hook, plus the
`LocalizationOperations` service. Unreal remains a separately enabled capability.

The underlying pipeline uses `GameTextIndexProgressReporter` for each operation; `workspace.progress()`
and `progressChanges()` return the workspace's latest `GameTextWorkspaceProgress`: a raw phase code
with its counts, which the host words with `GAME_TEXT_WORKSPACE_PHASE_LABELS` from `./labels`.

To serve the workspace over a transport (IPC, WebSocket, MCP), build its handlers from
`GameTextWorkspaceContract` in `./schema`: each method's params and success schemas, and the event
schema of `progressChanges`. Map each method name to the host's own channel, decode the params,
call the method with them and encode its result. Host-only methods are not in it; its doc comment
lists them. Prove scan/search/focus through the adopter's real transport, a non-disk rules store,
refused/recovery writes and disconnect/rejoin behavior.

## Required and optional capabilities

Compose `gameTextIndexStepsLayer(cacheRoot)` with `gameTextIndexSourceNodeLayer`,
`GameTextIndexBuilderLive`, the reader and `LocalizationEvidenceNodeLive`. Use `refreshProject`
once for a package revision, then `importTarget`, `buildTarget` and `openTarget` for each requested
view. Source queries use `importTarget(project)` without a target name. Importing localization
never starts package inventory. The convenience refresh layer supplies the same steps.

`GameTextIndexBuilderLive` derives configuration from the existing reader. It requires
`game_text_index`, uasset-io protocol 1.15 and the `uasset game-text-engine` session from the same
UE Shed build. Library, CLI and Workbench
hosts use this same native engine. `nativeIndexBuilderLayer(readerConfiguration)` supports
explicit configuration. Storage, joins, incremental publication and all corpus queries run in
Rust. TypeScript test oracles are excluded from package builds and public entry points.

A localization model serves source queries too: omit `localization` from the request. A compact
model's `queryRevision` is an opaque identity comparable with its validated target handle in the
same project and cache. Borrow an already opened matching model instead of opening another.
Do not construct, parse or persist this identity.

All `model.query` operations return Effects. `model.summary` is cached native metadata;
`model.corpus` and `model.localizationJoin` are explicit asynchronous bulk reads. Search and focus
return bounded pages. Each model owns a native process and pinned read-only snapshot in its
caller's scope. The native read path holds no writer lease. Failures remain typed failures;
refresh and open a new model to recover. Input preparation still uses
`localization-import-worker.js`, `package-text-worker.js` and `cold-layer-worker.js`. Bundled
hosts must emit those entries with their package dependencies or leave the installed package
unbundled. There is no search-worker or quality-worker bundle.

Use `query.localizationDetail(request)` for interactive evidence, including culture, location and
PO-context offsets. Text focus carries a localization preview. `localizationFocus(id)` and
`localizationLines(request)` are explicit full-provenance exports through scoped files.

Ask the index rather than exporting the corpus to derive facts. Every request below is one bounded
search; keep the policy that decides what they mean in the host.

```ts
const scope = { query: "", capability: "all", pageSize: 50, localization: { target } } as const;
// Other keys holding exactly this text (case, whitespace and lone surrogates count).
search({ ...scope, filter: [{ field: "source", op: "is", values: [line.source] }] });
// Keys holding several texts, and texts under several keys, project-wide.
search({ ...scope, filter: [{ field: "fact", op: "is", values: ["conflicting"] }] });
search({ ...scope, group: "source", minGroupSize: 2 });
// One of those texts' lines.
search({ ...scope, group: "source", minGroupSize: 2, openGroup: "Mushroom" });
```

`fact` takes the four facts: `unresolved`, `conflicting`, `evidence_only` and
`compiled_copy_differs`. `finding` names rules of the request's findings layer, which a workspace
sets from the project's rules (see the README's "Findings in Browse"). A `source` clause takes up to 50 exact texts; a unit with
conflicting sources matches any of them. An `asset_type` clause takes up to 50 class paths and
matches text whose saved places include a package with that main asset class; `facets.assetTypes`
lists the types with readable labels. `group: "source"` keys and labels each group by its text
and counts the matching lines holding it (units without a target, each under its first source in
UTF-16 order). `minGroupSize` leaves smaller groups out of `groups`, including `more`; it does not
narrow totals or `openGroup`. Key changes are on each line's `keyChange`.

Bulk reads (`corpus`, exports, `readLocalizationLines`, `localizationLines`) run in a second native
process of the model, opened on the first of them, so they never hold a search or focus. The
model then holds two readers of the snapshot.

Which query answers which question:

| Question                                                         | Ask                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lines, words and unknown reasons per culture and state           | `query.aggregate({ ...scope, by: ["culture", "state"], measures: ["lineBreakWords"] })`               |
| How many lines per key, text, problem, origin, audience or asset | `query.aggregate({ ...scope, by: ["translation_key"] })`, and so on                                   |
| A target's progress report and baseline                          | `indexedLocalizationProgressReport(model, baseline)`, `indexedLocalizationBaseline(model, createdAt)` |
| Lines in changed files and their problems                        | `indexedLocalizationGateTarget(model.query, { join, files, failOn })`                                 |
| A spreadsheet of every line                                      | `query.writeLocalizationLinesCsv(request, { path })`                                                  |
| Keys and translations before a gather                            | `query.selectLocalizationLines(request, KEY_CHANGE_FIELDS)`                                           |
| Package coverage and diagnostics                                 | `query.readCorpusHeader()`                                                                            |
| The units quality findings name                                  | `query.readUnits(ids)`, or `readFindingUnits`                                                         |
| Source rules in an investigation                                 | `exportGameTextInvestigation({ sourceQuality: model.sourceQuality }, …)`                              |
| Has the model changed?                                           | Compare `model.revision`                                                                              |
| The whole corpus or join, to write it out                        | `model.corpus`, `query.readLocalizationLines()`, `query.export(request)`                              |

`aggregate` groups by up to four dimensions; `culture` fans each line out over the cultures in
scope and the culture-mark dimensions (`state`, `fact`, `unknown_reason`, `review`,
`review_status`, `review_flag`) read that culture's mark. A line counts once under each value of a
multi-valued dimension. `lineBreakWords` is the report's word count; `unknownWords` counts lines in
scripts it cannot count. `selectLocalizationLines` fields are the `LocalizationLine` fields plus
`marks`, `problems`, `signals` and `places`. Test doubles of `NativeTextQuery` must implement
`aggregate`, `selectLocalizationLines`, `readCorpusHeader`, `readUnits` and `corpusFingerprint`.

Verify cold preparation, mixed package/PO edits, failure recovery and pinned-reader queries
through the adopter's real packaged transport. The
[native engine guide](../../docs/engineering/native-game-text-index.md) describes ownership,
limits and incremental eligibility.

Use `makeRetainedGameTextIndexWith(prepare)` when a host publishes models from its own step
composition. `makeRetainedGameTextIndex()` retains the convenience workflow. Their `refresh(request)`
prepares a candidate in the calling operation's scope. Validate the candidate, publish one model
reference and run `candidate.retain` together in an uninterruptible publication step. Serialize
competing publications and validate the revision and project after asynchronous cleanup, before
changing published state. Uninterruptibility alone does not provide mutual exclusion. A rejected
candidate releases with its operation and leaves the published model usable. Before reading a
published candidate's asynchronous corpus, join or query, run `candidate.borrow` inside the
scope covering the entire operation. The retained `search` adapter also borrows automatically.
Replacing or releasing the published owner interrupts new work on the old model; existing borrowers
keep its native reader alive until they finish. Remove the model reference before calling the
retainer's `release()` when clearing a view. The host's outer scope releases everything on shutdown.

The explicit raw corpus read preserves empty and whitespace-only source evidence. Search and query exports
retain their existing visibility filters. Failed current localization reads never use a previous
successful layer as current evidence; missing and malformed inputs keep their distinct states.
Native joined keys use `joined-native-v2` and preserve snapshot format 4. Older disposable joined views rebuild once to add the native source-search arena.

The core audit requires saved project packages and a configured reader. It does not require a
running editor, Perforce, `UEShedCore`, or any other UE Shed Unreal plugin.

“Locate in Unreal” is an optional host enhancement. Keep it outside the audit Module and expose an
honest unavailable state when the host has no compatible editor-selection capability.

ID repairs are separately enabled. Compose `makeGameTextIdRepairs` from `@ue-shed/game-text/workspace`
with the host's workspace, selected-project and file hooks, chosen endpoint, and an `editorProject`
hook that verifies the editor's actual project directory. Supply Remote Control and AssetReader
services. Expose the schema-validated `prepare` and explicitly approved `apply` methods to the UI;
retain the proposal and receipt under `Saved/UEShed/GameTextActions`. Never replay a started ID,
including after a lost reply. Property edits require `UEShedGameText`; top-level DataTable text
cells use Authoring when advertised and otherwise use Game Text's `data_table_cell` selector.
The narrow `game-text.actions.key-repairs.v1` capability admits ID edits on resolved object
properties, table cells and Blueprint pins; it does not admit table migrations or conversions.
The broader `game-text.actions.authoring.v1` still admits the whole extended surface. Supply the
ID-repair `editorProject` hook from Core's actual `projectRoot` fact or another trusted editor
identity adapter, without requiring navigation or world control. Keep manual instructions for unsupported places, and stage translation moves
only after verified saved-file success. See the [product contract](../../docs/products/game-text.md#fixing-keys-in-assets).

## Acceptance journey

For localization policy/report adoption, compose `LocalizationEvidenceNodeLive` in the trusted
host and use the browser-safe `joinLocalizationTarget`, `decodeGameTextRuleDocumentJson`,
`checkLocalizationTarget`, and `localizationProgressReport` functions. Keep the v1 starter;
choose v2 only when the project supplies culture budgets or glossary terms. The report documents
word-count limitations, unknown coverage and `not_tracked` review state. Baseline IO belongs to the
host; `createLocalizationBaseline`/`diffLocalizationBaselines` are pure and do not edit Unreal files.
Prove both fixture CSV oracles and exclusive baseline creation in the target's own journey.

The integration is complete only when the target host can:

1. Select an explicit project root without relying on ambient UI state.
2. Scan its saved packages with visible progress and cancellation owned by the host.
3. Return a summary that includes scan coverage and diagnostics.
4. Search with the public maximum page size enforced.
5. Focus a selected text-unit ID and return bounded occurrence evidence.
6. Run with Unreal offline and report unsupported or partial evidence without claiming complete
   project coverage.
7. Build and run from the target's packaged application, resolving the configured reader there.

UE Shed's source release gate runs `pnpm test:release:packages`. The adopter must add a target-owned
command that proves the same scan → search → focus journey through its real host transport. A direct
package call is useful diagnosis but is not evidence that the host Adapter works.

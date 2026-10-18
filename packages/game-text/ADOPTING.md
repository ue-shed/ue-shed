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
3. In the target's trusted Node process, compose one scoped `AssetReader` layer and
   `TextCorpusServiceLive`. Do not create a sidecar server or a reader layer per asset.
4. Adapt the host's explicit project root or existing project index to `scan` or
   `scanFromProjectIndex`.
5. Keep the complete corpus and `textCorpusQuery` model in the trusted host. Add schema-validated
   host operations for progress, summary, bounded search, and bounded focus using the target's
   existing transport conventions.
6. Add an adopter-owned view only if the host needs one. This bundle contains no maintained UI and
   requires no Solid, StyleX, Electron, or Workbench package.
7. Prove the acceptance journey below and record the exact package versions, reader provider, target
   files, project input, and verification commands in the host repository.

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
returns the host/workspace's latest presentation state. Prove scan/search/focus through the adopter's
real transport, a non-disk rules store, refused/recovery writes and disconnect/rejoin behavior.

## Required and optional capabilities

For a desktop host using the compact index, compose
`gameTextIndexStepsLayer(cacheRoot, { searchWorker: true, latestSearchOnly: true })` with
`gameTextIndexSourceNodeLayer`, `GameTextIndexBuilderLive`, one reader, and
`LocalizationEvidenceNodeLive`. Use `refreshProject` once for the chosen package revision, then
`importTarget`, `buildTarget`, and `openTarget` for each requested localization view. Source queries
use `importTarget(project)` without a target name. Target steps reuse the verified project handle;
they never start package inventory or extraction. For localization-first validation, use
`openProject` and `importTarget` before refreshing packages, then pass the verified revision and
the import to `buildTarget`. These handles stay in the trusted process. The adopting host chooses
ordering, requested views, progress presentation, and cancellation; the package owns per-step
leases, cache validity, immutable publication, and query reader resources.
`gameTextIndexRefreshLayer` remains a compatible convenience workflow and also exposes the steps.

`GameTextIndexBuilderLive` selects the complete TypeScript builder/query implementation used by
CLI and Workbench. It does not acquire a native writer or require `game_text_index`; saved-package
extraction continues to use the host's separate reader. `typeScriptIndexBuilderLayer` names the same
implementation. Keep the ordinary source and localization evidence layers. Verify cold preparation,
an incremental edit, failure recovery and pinned-reader queries in the adopting host.

`nativeIndexBuilderLayer(readerConfiguration)` is an explicit experimental writer requiring
`game_text_index` (uasset-io protocol 1.13). It still uses JavaScript queries and must not be presented
as a complete native backend. There is no automatic backend switch after a failure. See the
[native preparation guide](../../docs/engineering/native-game-text-index.md) for experimental limits.

A localization index also supplies the complete raw source query and corpus. Prepare the chosen
target first when both views are needed, and use that model for requests without `localization` as
well. Keep source-only preparation as recovery when target discovery or import is unavailable.
After validating a target with `importTarget` and `buildTarget`, a compact model's optional
`queryRevision` is an opaque identity shared by the validated target handle and its opened model.
Compare it only within the same project, cache and backend. Borrow a matching prepared model
instead of opening it again. Never construct or parse the identity, persist it as a durable ID,
or depend on its encoding across releases; adapters without it use normal preparation.

Call
the retained refresh result's Effect-shaped `search(request)`. The host scope owns the worker
and its pinned reader. `latestSearchOnly` fits a single search view and preserves concurrent group
pages while cancelling replaced pages and older filter selections; leave it false for independent
concurrent callers. Worker startup and searches have 30-second bounds. Bundled hosts must emit
`dist/search-worker.js` from the installed package beside the bundle that resolves it through
`import.meta.url`. Cold preparation also resolves `localization-import-worker.js`,
`package-text-worker.js` and `cold-layer-worker.js` beside that bundle. Emit those worker entries
with their dependencies, or leave the installed package unbundled. Verify a cold preparation that
uses multiple layers through the packaged host, as well as worker-backed search. The synchronous
`query.search` remains available for headless batch use and bounded direct queries.

Worker-enabled steps share at most eight scoped workers across overlapping models with the same
configuration, physical generation and joined key. Each model acquires its worker before it is
exposed, so later file retirement cannot invalidate its first search. Unchanged replacements
acquire a pin before their predecessors release theirs. Changed joins acquire a separate worker;
the final pin releases it. Worker starts, stops and retirement duration are observable metrics.

Use `makeRetainedGameTextIndexWith(prepare)` when a host publishes models from its own step
composition. `makeRetainedGameTextIndex()` retains the convenience workflow. Their `refresh(request)`
prepares a candidate in the calling operation's scope. Validate the candidate, publish one model
reference and run `candidate.retain` together in an uninterruptible publication step. Serialize
competing publications and validate the revision and project after asynchronous cleanup, before
changing published state. Uninterruptibility alone does not provide mutual exclusion. A rejected
candidate releases with its operation and leaves the published model usable. Before reading a
published candidate's lazy corpus, join or synchronous query, run `candidate.borrow` inside the
scope covering the entire operation. The retained `search` adapter also borrows automatically.
Replacing or releasing the published owner interrupts new work on the old model; existing borrowers
keep its reader and worker alive until they finish. Remove the model reference before calling the
retainer's `release()` when clearing a view. The host's outer scope releases everything on shutdown.

Raw `corpus.units` preserves empty and whitespace-only source evidence. Search and query exports
retain their existing visibility filters. Failed current localization reads never use a previous
successful layer as current evidence; missing and malformed inputs keep their distinct states.
Native joined keys use `joined-native-v1`; the production TypeScript backend uses `joined-v18`. Switching
builders rebuilds the joined view while reusing compatible inputs and preserving snapshot format 4.

The core audit requires saved project packages and a configured reader. It does not require a
running editor, Perforce, `UEShedCore`, or any other UE Shed Unreal plugin.

“Locate in Unreal” is an optional host enhancement. Keep it outside the audit Module and expose an
honest unavailable state when the host has no compatible editor-selection capability.

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

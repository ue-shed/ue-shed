# Showcase-first project review — 2026-09-06

UE Shed has substantial useful capability already. The strongest next investment is making project
selection, freshness, recovery, and repeatable workflows consistent across the suite. Several
integration defects currently prevent the recommended showcase journey from demonstrating the
underlying libraries reliably.

This is a broad product and architecture review, with targeted runtime investigations. It is not a
line-by-line audit of every Rust/C++ implementation or a certification of live Unreal behavior.
No production code was changed during the review.

## Implementation follow-up

The accepted first batch is R1–R7 and R9. The changes following this review implement:

- **R1:** Showcase, recording, benchmark, and desktop-test launchers build Workbench's workspace
  dependencies in order. A build-only run passed starting with no package `dist` directories.
- **R2:** The public host resolves authoring repositories, table snapshots, and catalogs for each
  selected project. Tests cover initially absent selection, matching table paths in A→B→A, and
  persisted session recovery in a new host scope.
- **R3:** Explicit feature rescans refresh committed membership first. The project client exposes
  refresh/rebuild; failed refreshes retain the previous committed inventory, and late results from
  another project cannot replace the selected inventory. Tests cover additions, removals, recovery,
  rebuild, and a controlled project-switch race.
- **R4:** Current Config/authoring journeys, isolated Electron profiles, and the focused
  `pnpm test:e2e:showcase` command provide repeatable desktop coverage.
- **R5:** TanStack Virtual bounds the shared actor outliner while preserving grouping, filtering,
  selection, and keyboard access to offscreen actors. The map rendering implementation is unchanged.
  The 4,137-actor fixture renders fewer than 80 list rows in the desktop regression test.
- **R6:** Public, generation-bound aggregate queries count distinct packages across overlapping
  selectors. Memory/SQLite conformance tests cover the same semantics; Workbench home and
  `project-index count` consume the API without collecting candidate headers.
- **R7:** Game Text and Texture Audit retain investigation preferences across route navigation.
  Game Text restores loaded quality rules. Main-process scans reuse pending work and completed
  results for the active project/generation, with guards against publishing superseded results.
- **R9:** Versioned scenario files round-trip through headless file APIs and Workbench save/open
  actions. CLI `scenarios run --document` executes the saved document; the UI exposes its replay
  command only while the draft matches its saved baseline.

Local validation on the current checkout: `pnpm check:precommit`; 244 focused Vitest tests with one
existing environment-dependent test skipped; all nine focused Electron tests; Rust formatting,
Clippy with warnings denied, and all 79 `uasset-io` tests. The CLI aggregate query was also exercised
against the native fixture catalog. Test/build logs remain in `.tmp/review-*.log`.

These checks cover saved-data and offline desktop behavior. Full `pnpm check`, hosted Depot, live
Unreal execution, cross-platform visual baselines, and 20k/100k-actor latency benchmarks were not
run in this implementation pass. The focused desktop command is currently an explicit local lane.

## Second implementation batch: R8, R10, R11, R12

Continued in the `work/showcase-review` worktree after transferring the first implementation batch.

- **R8:** Home now offers sample and own-project actions, links through a saved-data walkthrough,
  and reports explicit failures. Camera feed status no longer implies overall editor readiness;
  failed checks stop loading. Config sample availability depends on its files, independently of the
  selected project. Data Authoring distinguishes saved snapshots, drafts, and committed applies.
- **R10:** Renderer contracts now live under `src/shared`. Browser package entry points avoid Node
  implementations and telemetry exporters. Routes and clients load together on demand; unused
  renderer service registrations were removed. The production Vite build rejects imports of Node
  built-ins or Electron from browser code instead of silently substituting browser shims.
- **R11:** The public selected-target service captures an endpoint for an operation and its children.
  Workbench IPC and live adapters use this selection. Authoring caches include project and endpoint;
  preview and world caches track their endpoint. Target changes stop old observation subscriptions,
  clear caches, remount the active route, and restart footer polling. Active work remains on its
  captured endpoint. Scenario Studio keeps its explicit per-run override and captures that choice
  in its run handle; its default preserves the selected endpoint's host as well as port.
- **R12:** Shared schemas replace the duplicated renderer definitions. The unused private legacy
  Game Text and Texture Audit routes were removed; maintained bounded-query routes remain. The
  renderer runtime no longer registers services that every route already receives explicitly.

The first-batch production renderer was 2,015.97 kB minified (571.26 kB gzip). After this batch, the
entry and its static preload dependencies total approximately 503 kB (156 kB gzip), about 75% less
initial JavaScript. Feature code still exists in deferred chunks; this is not a claim that total
application code shrank by 75%. Three final local launches measured 0.56–0.62 seconds to the home heading
and 0.13–0.30 seconds from navigation to the first saved DataTable, loading two additional JavaScript
chunks totaling 309 kB on first use. These runs overlapped other
checks, are not a controlled benchmark, and do not establish a startup-speed improvement. Home
screenshots were inspected at 1440×960 and 1280×800.

Validation includes the production browser build, `pnpm check:precommit`, Effect architecture,
483 passing service/domain/component tests (20 live-Unreal tests skipped), and all ten showcase
Electron journeys. Coverage includes
changing targets during capability negotiation, nested operation capture, project/endpoint cache
isolation, sample selection from an empty profile, own-project selection, failure status, footer
target changes, route recovery, and virtualized actors. JSDOM fixtures provide viewport dimensions
to the real virtualizer. Logs and screenshots are under `.tmp/batch-two-*` and
`.tmp/showcase-measurements/`. Live Unreal execution and hosted Depot were not run.

## Third implementation batch: R13

Game Text and Texture Audit now export the complete filtered result set as versioned JSON or CSV.
Public query models retain full evidence and use the same matching logic as bounded search.
Exports carry project, catalog generation, saved-file authority, embedded rules, and whole-scan
coverage/diagnostics. File dialogs and writes stay in the trusted host; no full export crosses
renderer IPC. A scan snapshot is captured before the dialog, and stale generations are rejected.

Versioned presets restore filters, the existing domain sort order, the corpus/quality view, and
actual rule documents. Texture scans accept inline rules as well as rule files. The CLI replays
presets against an explicit project and can write JSON/CSV or stdout. Its direct scans use null
catalog generation. Saving a preset enables a PowerShell replay command while current settings
still match; replay rescans current files, while exported artifacts preserve the original evidence.

Shared file handling bounds reads and replaces outputs atomically. CSV contains one metadata row
plus record rows, retaining metadata for empty results. See [Showcase](../showcase.md#take-an-investigation-away)
for the complete format and workflow.

Validation: 110 targeted library, service, component, IPC, and CLI tests; all 12 showcase
Electron journeys; public package and production Workbench builds; precommit checks and Effect
architecture. Tests cover results beyond page limits, full evidence, CSV quoting and empty
metadata, invalid rules/presets, project changes during file dialogs, preset restoration, clipboard
replay, and native-reader CLI execution. Logs are under `.tmp/r13-*`. Live Unreal execution and
hosted Depot were not run.

## Fourth implementation batch: R16

The follow-up analysis narrowed R16 to four reproduced state/lifetime defects. Baseline comparison
(R14) and additional performance investigation (R15) were explicitly skipped.

- Data Authoring captures the active table, authority, session, and selection revision before a
  session operation. A late result refreshes Recent drafts without replacing a newly selected
  table or source. Table selection interrupts pending session acquisition, while mutations retain
  their existing completion and recovery behavior. Tests also cover leaving and reopening the same
  table before the old operation completes.
- Game Text owns rule drafts, the saved document, operation state, and feedback above the editor
  tabs. Accepted reviews update the document and findings together; preview never marks the file
  saved. New edits made during a pending save remain unsaved when that save completes. Navigation
  retains the draft separately from the reviewed rules, including invalid drafts that cannot be
  applied. The former shadow copy of the reviewed document is removed.
- Texture Audit keeps its ready workspace mounted across result updates, preserving input identity,
  focus, and caret. It centralizes selection clearing and cancels detail, live preview, and saved
  preview reads when clearing selection or rescanning. Refresh also invalidates pending searches
  and saved preview cache entries. The redundant search generation counter is removed in favor of
  the shared Effect action's cancellation and stale-completion protection.

Validation: 31 targeted component/Effect-adapter tests; all seven showcase-improvement Electron
journeys; production Workbench build (including Solid and StyleX compilation); precommit checks;
and Effect architecture. Controlled asynchronous tests use Deferred synchronization. Electron
checks exercise real typing, rule-file persistence, reviewed-rule preset export, and navigation.
Logs are under `.tmp/r16-*`. Live Unreal execution, production-project benchmarking, and hosted
Depot were not run.

## Hosted CI follow-up

The first PR run exposed two test-integration omissions: five Content Observatory tests lacked
the measurable JSDOM viewport required by the shared actor virtualizer, and two CLI investigation
replays attempted to start the native UAsset reader in the repository lane that deliberately omits
it. Actor-explorer consumers now share the same test layout helper. Native investigation replays
use the existing executable-availability gate and run explicitly in the UAsset IO lane; changes to
the CLI investigation files also select that lane.

The full component suite passes (145 tests), both CLI investigation replays pass with the real
native reader, and precommit checks pass. These fixes change test setup and CI routing, not product
behavior.

## Scope and evidence

- Read the architecture, engineering/adoption guidance, showcase instructions, active-plan index,
  public package boundaries, CLI workflows, Workbench composition, and relevant extension sources.
- Installed the locked dependencies and built the public TypeScript packages and production
  Workbench. The initial Workbench build failed before the package build; see R1.
- Used Node 26.8.1 and pnpm 11.17.0. The shell initially exposed Node 24 and no pnpm; installed
  versions were discovered and selected without changing global configuration.
- Opened a fresh-profile Workbench and visited all 13 tool routes against the generic fixture,
  inspecting saved-data screens and offline/live setup states. No live capture, Apply, cleanup,
  Perforce history acquisition, or Unreal process launch was performed.
- Rust/Cargo was unavailable in the review shell. Native-backed browsing used the published
  `@ue-shed/uasset-win32-x64@0.5.1` binary in an ignored temporary directory. This binary supports the
  saved-table/index journeys used here but lacks the checkout's newer Blueprint operation. Native
  source conformance and Blueprint decoding remain unverified by this review.
- Six focused Vitest files passed: 27 tests covering project workspace/index usage, showcase,
  Game Text service, project chooser, and editor transport model.
- Five selected Electron tests produced one pass and four failures. Footer accessibility passed;
  Config and authoring smoke failed on obsolete UI locators; the two Blueprint tests failed because
  the fallback binary does not support `blueprint`. Those last two are an environment/version
  limitation, not evidence that the current Rust implementation is broken.
- Full `pnpm check`, hosted Depot status, real Unreal integration, and representative large-project
  performance were not run. Existing native benchmark reports are historical evidence only.

Local review artifacts are under `.tmp/project-review/`: screenshots and DOM snapshots for every
visited route, `browse.mjs`, and `freshness-and-sessions.json`. The latter records a real disposable
project, native indexing, and Electron IPC; only the native directory picker was replaced with a
deterministic selection. Existing E2E failure artifacts are under `test-results/workbench/`.

## Priorities

P1 means a broken core journey or a material correctness problem. P2 means a substantial product,
performance, or maintainability improvement. P3 means cleanup. Effort is relative: S is a contained
change, M crosses a few boundaries, and L needs a dedicated product slice; these are not estimates
of elapsed implementation time.

| ID  | Priority | Improvement                                                     | Effort | Evidence                                 |
| --- | -------- | --------------------------------------------------------------- | ------ | ---------------------------------------- |
| R1  | P1       | Make the documented fresh-clone showcase build work             | S      | Build failure + launcher source          |
| R2  | P1       | Scope authoring sessions to the selected project                | M      | Reproduced through Electron IPC          |
| R3  | P1       | Make Refresh discover changed project membership                | M      | Reproduced with real saved packages      |
| R4  | P1       | Restore meaningful showcase regression coverage                 | S–M    | Existing E2E failures                    |
| R5  | P2       | Virtualize the shared actor outliner                            | M      | Runtime DOM counts + source              |
| R6  | P2       | Query aggregate catalog counts for the home screen              | M      | Complete candidate enumeration in source |
| R7  | P2       | Preserve route context and scope scan jobs explicitly           | M      | Route/service lifecycle inspection       |
| R8  | P2       | Improve onboarding and capability/status truthfulness           | S–M    | Fresh-profile and fixture screens        |
| R9  | P2       | Persist scenario documents and replay the exact document in CLI | M      | UI and CLI contract comparison           |
| R10 | P2       | Separate browser contracts and load routes on demand            | M      | Production build and import graph        |
| R11 | P2       | Unify the selected live target across feature services          | M      | Endpoint ownership inspection            |
| R12 | P3       | Retire duplicate UI paths and consolidate schema ownership      | S–M    | Exports, callers, and contracts          |
| R13 | P2       | Add exportable findings and reproducible investigation inputs   | M      | Existing public query seams              |

## Findings

### R1. The advertised fresh-clone build misses its package prerequisites

After `pnpm install --frozen-lockfile`, the Workbench build failed with 79 unresolved imports,
including `@ue-shed/config-explorer`, `@ue-shed/cameras`, and `@ue-shed/game-text`. Their package
exports point at `dist`, which does not exist in a fresh checkout. Building the TypeScript packages
first made Workbench build successfully.

[`scripts/showcase.ts`](../../scripts/showcase.ts) builds only Workbench after preparing the
environment. [`scripts/native-tools.ts`](../../scripts/native-tools.ts) builds the native reader;
neither supplies the missing TypeScript build. This also permits stale package artifacts during
ordinary iteration after source edits.

Build Workbench's required workspace closure in dependency order from the launcher. Add a fresh
checkout/build-only smoke job that starts without package `dist` directories. The existing repository
gate builds packages first, so it masks this onboarding failure.

### R2. Interactive project selection does not configure authoring sessions

Reproduction: launch with no `UE_SHED_PROJECT_ROOT`, choose a valid project, load its catalog, then
list or begin draft sessions. The project and catalog return `ready`; both session operations return
`authoring_session_failure: UE_SHED_PROJECT_ROOT is not configured`.

[`WorkbenchAuthoringSessionsLive`](../../apps/workbench/src/main/services/authoring.ts) receives
the static startup configuration. [`ShedAuthoringSessionsLive`](../../packages/host/src/authoring.ts)
provides `Layer.empty` if that startup project was absent; `ShedAuthoringLive` captures the optional
session service once. The dynamic catalog adapter cannot change that decision. Restoring a recent
project also happens outside the static configuration path.

When startup explicitly selects project A, the session repository instead remains bound to A while
the catalog can switch to B. That second case follows from the composition and needs a dedicated
cross-project regression test; this review did not mutate or apply sessions across projects.

Make project identity and its session repository one scoped resource, selected through a public
host service. Switching projects should select the appropriate persisted drafts and release old
project work. Validate fresh selection, remembered selection, A→B→A, and restart recovery. Rebuilding
only Solid components is insufficient because the stale authority lives in the main process.

### R3. Refresh can repeatedly return an inventory that omits new assets

In a disposable project containing one saved table, I opened the catalog, copied in a second table,
waited 32 seconds, and requested current project state and catalog refresh again. The UI-facing
responses still reported one package and listed only the original table.

[`currentInventory`](../../apps/workbench/src/main/services/project-workspace.ts) returns
`selectedSummary` indefinitely when its root matches. Consequently, the 30-second `summaryLoads`
TTL does not cause revalidation. Candidate queries recover a _changed catalog generation_, but new
files on disk do not create a generation until someone refreshes the catalog. Feature-level Rescan
can therefore decode the same outdated candidate set successfully.

Expose explicit refresh/rebuild operations in the Workbench project client. Make user-requested
Rescan await catalog refresh, then query its committed generation. Keep passive route opening fast
by displaying the committed snapshot with freshness and background-refresh state. Test additions,
deletions, renames, failed refresh, and recovery without restarting or reselecting the directory.

Also guard background publication by selected project identity: `inventoryFromSummary` writes a
single shared `selectedSummary`, while `savedProject` reads it without checking `selectedRoot`.
A late refresh from the previous project deserves a controlled race test before this lifecycle is
considered complete.

### R4. Showcase tests have drifted from the product

The Config E2E calls `openRoute("Config")`, while navigation now says `Config Explorer` and matches
names exactly. The authoring smoke still expects a `Breadcrumb` navigation that the current screen
does not render. Both fail before proving their intended workflow.

Sources: [`workbench-page.ts`](../../apps/workbench/e2e/pages/workbench-page.ts),
[`config-explorer.e2e.ts`](../../apps/workbench/e2e/config-explorer.e2e.ts), and
[`workbench.smoke.e2e.ts`](../../apps/workbench/e2e/workbench.smoke.e2e.ts).
[`check:repository`](../../package.json) does not execute the Electron E2E command; the explicit
package build and component tests cannot catch these presentation/composition failures.

Repair the journeys around current user-visible behavior. Add a small maintained showcase lane:
fresh profile → choose project → inspect table → create a local draft → switch projects → refresh
new content. Keep the live Unreal lane separate. Add a few reviewed visual baselines at normal and
minimum supported window sizes; screenshots saved on failure alone are not visual regression tests.

### R5. The shared actor outliner renders the entire population

The fixture's saved Camera Load map contains 4,137 actors. The observed Map Review document had
21,031 DOM elements; World Log had 25,117. Most other visited routes had a few hundred to roughly
1,100. These counts are concrete; they are not frame-time or large-project latency benchmarks.

[`ActorExplorer`](../../packages/ui/src/actor-explorer.tsx) groups the complete filtered collection
and renders every expanded row with nested `For` loops. It also retains row element references for
scroll-to-selection. Canvas rendering of the map does not bound the adjacent DOM list.

Virtualize the flattened group/row sequence, preserving selection, class headers, keyboard focus,
and scroll-to-selected behavior. Exercise 4k/20k/100k generic actors and measure filter-to-paint,
selection, scrolling, and DOM size. This one shared change benefits saved maps, live worlds, and
history. Preserve the existing camera/transform backpressure design.

### R6. Home-screen counts materialize full candidate sets

[`Showcase.projectEvidence`](../../apps/workbench/src/main/services/showcase.ts) loads four complete
candidate scans merely to read their array lengths. Each candidate path pages through the native
index, collects records, constructs synthetic header objects, deduplicates, and sorts them in
[`project-workspace.ts`](../../apps/workbench/src/main/services/project-workspace.ts).

Individual pages are bounded, but total work remains proportional to all matching packages. It is
paid again when returning to the home screen. The Blueprint search path similarly materializes a
catalog before returning a bounded list.

Add generation-bound count/facet queries to the public Project Index, then consume them in Workbench
and CLI. Define union/deduplication semantics explicitly so a text package matching multiple criteria
counts once. Do not expose SQLite tables to callers. Profile transport bytes, decoding, and folding
before another storage-engine change: the recent
[SQLite report](sqlite-canonical-2026-09-05.md) already identifies nontrivial large-query cost, and
its historical timings should not be presented as measurements from this review.

### R7. Navigation discards investigation context and can repeat scanning

[`AppShell`](../../apps/workbench/src/renderer/app-shell.tsx) mounts routes through `Switch`, so
navigating away disposes their local state. Game Text initializes its query/selection and calls
refresh on every mount; its main-process service rescans and rebuilds the query model. Texture Audit
has a similar split. Filters, selection, and loaded quality-rule context are easily lost when users
move between tools.

The shared [`createEffectAction`](../../packages/ui/src/effect-solid.tsx) correctly suppresses late
renderer callbacks. However, cancellation of its Promise-backed IPC request does not cancel the
independently scoped main-process invocation in
[`electron-ipc.ts`](../../apps/workbench/src/main/adapters/electron-ipc.ts). A route can disappear
while its scan continues and later publishes retained state. Game Text's retained query model is a
single service-level reference rather than a project/generation-keyed result.

Keep lightweight route state by project, use generation-keyed cached read models, and distinguish
opening a result from requesting a refresh. Give long operations IDs, progress, cancellation, and
publication guards; reuse the existing World Log job pattern where appropriate. Keep mutations
durable and explicit rather than cancelling them merely because navigation changed.

### R8. Onboarding and status labels misrepresent several states

Observed examples:

- The README promises a configured fixture, but interactive `pnpm showcase` now uses remembered
  selection and starts empty on a fresh profile. The main call to action is a question followed by
  13 tools; choosing a project is relegated to the sidebar footer.
- Config Explorer works from its committed sample without a project, while its home card says
  `No project selected`. The general project gate runs before its sample-ready branch.
- Camera Lab stays at `Checking live session…` after a failed status request. Undefined represents
  both loading and failure; the home screen only requests status once.
- The home metric `Live Unreal` is derived from the camera pipe. An authoring-capable editor need
  not be a connected camera producer.
- Opening an untouched saved DataTable displays `Applied`. The expression is
  `session()?.dirty ? "Draft" : "Applied"`, so it also labels the absence of a session as applied.
- Recovery text on some routes still directs users to a header control or environment variable
  even though project selection is available in the footer.

Sources: [`README`](../../README.md), [`showcase.ts`](../../scripts/showcase.ts),
[`app-shell.tsx`](../../apps/workbench/src/renderer/app-shell.tsx),
[`workbench-client.ts`](../../apps/workbench/src/renderer/workbench-client.ts), and
[`authoring-route.tsx`](../../extensions/data-authoring/src/authoring-route.tsx).

Offer prominent **Try the sample project** and **Open your project** actions. Present a short guided
saved-data journey, followed by optional live setup. Model loading, offline, unavailable, ready,
partial, and failed separately, deriving readiness from the capability each tool needs. Use
`Saved snapshot` or `No draft` until an actual session transition justifies `Applied`.

### R9. Scenario Studio cannot carry an edited document into a repeatable workflow

The route initializes an editable document from `movementGymScenario` and keeps edits in local
signals. Its `Unsaved` take has no document save/load/export path. Leaving the route recreates the
fixture document. The displayed headless command passes only an endpoint; the CLI accepts endpoint
and evidence limit, so it cannot replay the user's edited document.

Sources: [`scenario-studio-route.tsx`](../../extensions/scenarios/src/scenario-studio-route.tsx),
[`CLI command`](../../apps/cli/src/commands/scenario.ts), and
[`CLI workflow`](../../apps/cli/src/workflows/scenario.ts).

Add schema-validated document import/export and explicit draft persistence, then a CLI document-file
argument using the same runner input as Workbench. Generate the repeat command from the exported
artifact. Keep the currently supported Movement Gym execution scope clear; broader arbitrary
scenario support is already an active-plan concern. Saving a useful existing draft should precede
adding more timeline affordances.

### R10. Renderer entry points still traverse Node implementations

The production build emitted one 1,987.86 kB minified renderer JavaScript file (562.79 kB gzip),
105.37 kB of StyleX CSS, and 9.13 kB of other CSS. All route components are imported eagerly by the
shell. Vite also warned about browser externalization of Node modules reached through domain
package and telemetry imports.

The shell itself became visible in roughly 0.55–0.72 seconds in these local launches after building;
this is neither fresh-install latency nor a representative startup distribution. Bundle size alone
does not establish that startup is slow, but the import graph is an avoidable coupling problem.

Renderer clients import runtime schemas from
[`main/ipc-contracts.ts`](../../apps/workbench/src/main/ipc-contracts.ts), whose imports include broad
domain roots. Prefer explicit browser-safe contract/query entry points, with a production browser
bundle check that rejects Node dependencies. Lazily load route components and show a small loading
fallback. Measure startup parse/evaluation and first use of the heavy grid/graph routes after the
change; do not simply suppress the chunk-size warning.

### R11. The monitor and feature operations have different live-target authorities

Changing the footer port updates
[`WorkbenchUnrealConnection`](../../apps/workbench/src/main/services/unreal-connection.ts).
Editor-session status and PIE commands read that mutable endpoint. Authoring, asset navigation,
texture previews, map review/capture, and Camera Lab instead read the original
`configuration.remoteControlEndpoint`.

The UI explicitly calls this a _monitor_ setting, so this is not a claim that its narrow label is
false. It is nevertheless a poor integration model: the visible session and its play controls can
refer to a different producer than the adjacent tools.

Use a shared selected connection/session service across tools, with project identity and negotiated
capabilities. Pin each operation to a stable target and handle reconnect or switching deliberately.
If multiple targets are intentional, show them explicitly. Test two generic local endpoints and
project switches before testing against real editors. Do not infer safe mutation targets merely
from a port or asset object path.

### R12. Some migration scaffolding now creates duplicate maintenance

Both Game Text and Texture Audit export legacy full-report routes alongside their bounded query
routes. Source searches found no maintained application consumer of the legacy routes beyond their
export surfaces. Their private extension packages retain substantial duplicate presentation code;
tests and any intentional compatibility consumers must be checked before deletion.

Sources: [`asset-audits/index.ts`](../../extensions/asset-audits/src/index.ts) and
[`game-text/index.ts`](../../extensions/game-text/src/index.ts).

Separately, Workbench duplicates schemas such as Showcase context and camera metrics in the renderer
client while also owning IPC contracts. Derive both boundaries from a single browser-safe schema
module. Keep validation at each process boundary; reduce duplicated definitions, not validation.

Several route files are also large: authoring has about 2,700 nonblank lines, Scenario Studio about
1,950, and the query audit/text routes about 1,700–1,800. Size alone is not a defect. Extract coherent
query/session controllers, inspectors, and workflow panels where that separates tested behavior.
Avoid a universal route framework or runtime plugin loader: static composition still fits the
project well.

### R13. The next easy capabilities should help users take results away

The maintained Game Text and Texture Audit clients already expose bounded queries, selections, and
detail. Add export of the **current filtered result set** with stable identities, project and
generation, authority, coverage gaps, and rule version. Produce versioned JSON for automation and a
flat CSV for people. Export all matching pages deliberately, not just the visible 50 rows.

Next, add saved query presets and a copyable CLI invocation or request document that recreates the
investigation. Use public domain APIs for serialization/query semantics and host adapters for file
selection. This improves daily usefulness and library adoption together.

Follow-on candidates need separate slices: baseline comparison for text/audit regressions, and
package-level referencer/dependency queries to connect texture findings to owners. The audit already
states that reverse usage is not indexed. Saved import references can provide evidence, but should
not be advertised as complete runtime usage or dynamic-loading knowledge. These are M/L projects,
not small UI buttons.

## Architectural direction

Keep the current headless foundation: independent domain packages, public query and execution APIs,
versioned contracts, separately enabled Unreal plugins, bounded native/stream boundaries, and
immutable evidence are valuable choices. The Data Authoring trusted-host seam and Game Text
package-adoption path are useful existing patterns.

The main missing abstraction is a coherent **project/session lifetime** shared by clients. It should
bind selected project identity, current catalog generation, draft repositories, retained query
models, and active jobs without making Workbench their owner. Model the live editor connection as a
separate explicit resource. CLI callers can supply these identities directly; the Workbench project
chooser selects them for interactive use.

Do not reopen the parser/inspection/IO split or SQLite decision simply to reorganize code. First
remove unnecessary whole-result transfers, repeated route work, and unbounded DOM rendering.
Likewise, finish the planned authoring row-identity/conflict work before extending editable joins or
adding more mutation surface.

## Suggested implementation order

1. Repair the clean build, dynamic authoring sessions, and explicit inventory refresh. Cover them
   with fresh-profile and project-switch journeys. These establish a trustworthy showcase.
2. Improve sample onboarding and status labels; repair the stale E2Es and add a small durable
   showcase gate. Make failure recovery actionable from the screen that reports it.
3. Virtualize the actor explorer, add catalog aggregates, retain route context, and isolate browser
   imports. Establish repeatable latency/DOM/transfer measurements for each change.
4. Add findings export and saved investigations, then scenario document persistence and CLI replay.
   Retire duplicate legacy routes as their replacement journeys become the maintained contract.

The near-term goal should be that a fresh user can discover a useful result, trust its scope and
freshness, revisit it, and reproduce it outside Workbench. The project already has enough breadth
to make that a compelling release.

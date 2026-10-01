# Website and illustrated guides

The public site lives in `apps/site`. Its guides describe user workflows; `docs/products` remains
the authority for product contracts. Update the guide when a workflow changes and link to the
contract instead of copying its full specification into the website.

The `/blueprints` page lets visitors inspect a local uncooked Blueprint `.uasset` (up to 64 MiB)
with the same viewer as Workbench. Files are decoded on the visitor's machine and never uploaded.
The optional sample is the repository's `BP_GraphFixture` asset, served as a Vite asset; it is not
a second copy of the binary in the source tree. The homepage and docs navigation link to the page.

The lazy-loaded `/inspect` page accepts any uncooked `.uasset` up to 64 MiB, using the shared
`@ue-shed/extension-asset-inspector` UI. It shows package statistics, typed properties, native
records, specialized tables/curves/skeletons, metadata, and decode errors. Long tables are capped
with visible counts. Three sample choices import the existing `ST_Game`, `DT_Scalars`, and
`BP_GraphFixture` binaries with Vite `?url`; selected user files are never uploaded.
The summary toolbar includes the file opener and related actions. Multi-export packages have a
compact navigator and one selected detail (an export select on mobile); single-export packages
use the full detail width. Search filters both the export list and decoded evidence. Table types
appear in headers, and package disclosures sit below the detail. Samples use three small buttons.

All four viewers use the same worker and Effect client. An inspection request transfers the buffer once,
initializes one WASM runtime, and returns raw `inspect` and `extractBlueprints` outputs in one
round trip. For inspected Level Sequence classes it also runs `extractLevelSequences`; other
classes skip that parse. For inspected DataTable/CompositeDataTable exports it also runs
`extractAuthoringTable` in that round trip. Each operation still parses its own evidence inside
that runtime. The main thread
validates each result through its shared extension adapter. The inspector composes protocol pieces
into a generic v8 schema that retains nullable UE3 versions and table counts/offsets; the narrower
generated IO contract is unchanged. See the extension README for the schema decision.

Related views are host-owned action/note descriptors. Blueprint and Sequencer are available: the Blueprint link
appears in the summary when `adaptWasmBlueprintResult` returns `ready` with at least one graph.
Graphless Blueprints and Control Rig explain why no graph view is offered; non-Blueprints show no
graph-view UI. Sequencer appears only for a ready adapted read with at least one track or binding;
rejected or empty Level Sequences show one quiet inline note. Internal anchors use `history.pushState`
and a pathname signal; `popstate` restores
the route, while modified clicks and new tabs retain native semantics.
The links supply one-shot tab-local decoded reads through each related viewer's `initialRead`.
The last inspection stays in memory for Back. A non-Blueprint drop on `/blueprints` offers
"Inspect this file instead", transferring the same File to `/inspect`. Refresh/new tabs have no
handoff and show the ordinary file picker. Direct `/`, `/docs/*`, `/blueprints`, `/sequencer`,
`/data-tables`, and `/inspect`
loads continue to work.

The lazy `/sequencer` page uses `@ue-shed/extension-sequencer` for a compact coverage/count summary,
grouped timeline, frame ruler, section bars, keys, zoom and selection inspector. It imports the
18,576-byte `LS_SavedDetails` fixture via Vite `?url` for "Try the sample Level Sequence".
User files remain local. Its adapter validates the schema 1 WASM envelope and reuses the protocol
schema 6 `LevelSequenceProjection` record; `LevelSequenceRead` is the adapted single-read shape,
not the foreign envelope. The page offers "Inspect this file instead" for `unsupported_asset`,
passing the same File through the existing handoff. The inspector's Sequencer link hands over
decoded evidence without another pick, read or reload. The timeline scrolls inside its container
and the section inspector stacks below it on narrow screens.

## Browser viewer prerequisites

After `pnpm install`, prepare the built protocol, Blueprint library, and WASM package:

```powershell
rustup target add wasm32-unknown-unknown
# Install wasm-pack 0.14.0 if it is not already available.
pnpm site:prepare
pnpm --filter @ue-shed/site dev
```

`site:prepare` builds `@ue-shed/protocol`, `@ue-shed/blueprints`, and the unchanged
`@ue-shed/uasset-inspection-wasm` package using `scripts/build-uasset-wasm.ts`. It needs Rust and
wasm-pack; Unreal is not required. Rerun it when those packages change. Direct site `build`, `dev`,
and `deploy` commands consume these prepared artifacts. `site:check` prepares them itself so it
works on a clean checkout, and portable CI installs the same pinned toolchain and wasm-pack as
the UAsset jobs. Vite's workspace-root filesystem allowance covers the fixture imports in dev.
The separate worker typecheck uses the WASM package's source declarations (the build copies these
unchanged into dist), so the general repository typecheck does not need a Rust/WASM build.

All four viewer pages are lazy loaded, so the homepage does not load Effect or the WASM runtime. A read
transfers its ArrayBuffer to a module Web Worker. The worker initializes WASM and returns raw
projection evidence; the extension's browser-safe `/wasm` adapter validates it on the main thread
with the authoritative protocol schema before the shared viewer receives it. Validation stays in
the extension so every host uses the same mapping. Each read owns a worker through
`Effect.acquireRelease`: completion, replacement, timeout, and unmount terminate it. Initialization
therefore happens for each file, trading a small startup cost for immediate decode cancellation.

Peculiar Sheets uses Solid's `createStore`, which shares a framework module with the homepage's
signal/component exports. Vite therefore includes Solid's store, reconcile, and projection machinery
in the eager shared chunk (about 26 KB raw / 8 KB gzip). This framework overhead is accepted; the
spreadsheet, charts, viewers, Effect, and WASM remain lazy. The site uses the packages' public exports
without rewriting Solid or adding framework aliases.

The page applies `workbenchDarkTheme`; below 900px the shared viewer wraps its summary and stacks
the inspector under the canvas. The site has no CSP or headers file, so none is introduced.
Cloudflare static assets serve `.wasm` as `application/wasm` by default; no MIME override is needed.
Browser e2e covers local files, samples, inspector tables, both handoff directions, Back, invalid
packages, desktop/mobile overflow, and browser errors. After adding an extension workspace, the
repository owner runs `pnpm install` to create workspace links and update the lockfile, then uses
`site:prepare` and the same site dev command above. These extensions export TypeScript source and
need no separate build.

The lazy `/data-tables` page embeds `DataTableViewer` from the extension's browser-safe
`/viewer` subpath. It reuses the maintained Peculiar Sheets grid (with `peculiar-sheets/styles`)
and Patterns charts from `@tanstack/charts`; the extension resolves its existing dependencies.
Site Vite and TypeScript aliases resolve the new workspace subpaths before the owner's next
`pnpm install`. Only the site package manifest changes; the lockfile is updated by that install.
The homepage keeps its small hand-maintained Authoring mock and imports neither sheets nor charts.

The shell has one compact table/path/type/coverage/count summary, row filtering, Grid/Charts
switching and a cell inspector using name/value metadata. All editing and row operations are
disabled while selection remains active. Parents and row struct stay quiet; row handles display
their saved values with a not-loaded note. The grid scrolls internally at 390px, and the inspector
stacks below 900px. The sample imports the existing `DT_Scalars.uasset` through `?url`.
Unsupported assets offer "Inspect this file instead".

For a ready authoring snapshot the inspector offers "Open in Data Tables", passing validated
decoded evidence through a one-shot tab-local handoff to `initialRead`, without another pick,
parse or reload. Back restores the retained inspection. Adapter/jsdom tests cover boundary and
shell behavior; site e2e covers real selection, Patterns, samples, garbage bytes, unsupported
Blueprints, handoff, Back, console errors and mobile page overflow.

## Refresh the saved-workflow screenshots

From a source checkout with Node.js 26, pnpm 11, and Rust installed:

```powershell
pnpm site:refresh
```

This builds Workbench, runs the `site-saved` Playwright journey against the generic fixture,
exports its asserted chapters, and checks the production website at desktop and mobile widths.
The journey opens Data Authoring, switches to Charts, searches Game Text, compares config
platforms, and inspects the contribution ledger. It uses an isolated Electron profile and does
not launch Unreal. This website journey ignores inherited `UE_SHED_*` project and endpoint
overrides and reserves an offline endpoint so it cannot capture a different configured project.
Texture preview generation remains in the separate `saved-workflows` journey,
because that operation can need an Unreal commandlet.

The homepage and guide pages use the same capture keys in
`apps/site/src/showcase/media.ts`, so one export updates both. PNGs live in
`apps/site/public/media`. The manifest records the source journey, recording ID, commit, dirty
state, capture date, and SHA-256 digest. A source revision identifies provenance; it does not
claim that a screenshot is current merely because it exists.

Review the images before committing the PNGs and generated manifest together. Check that the
asserted state is useful, text is readable, and only generic fixture data appears. Do not publish
studio content, personal paths, or screenshots of unexpected error panels. The exporter never
deploys the website or updates visual baselines automatically.

## Individual operations

```powershell
# Reuse a current Workbench build during iteration.
pnpm showcase:record site-saved --no-build
pnpm site:media --journey site-saved

# Choose a specific reviewed recording. Other journeys stay unchanged.
pnpm site:media --bundle site-saved=<recording-id>

# Verify committed images without requiring local recording bundles.
pnpm site:media --check

# Build, validate, and exercise the website.
pnpm site:check
```

With no journey selection, `site:media` requires a complete recording for every export-plan
journey. A missing chapter, failed latest recording, invalid manifest, escaped path, or invalid
PNG fails before publication files are written. Explicit pins allow choosing an older reviewed
recording. Selecting one journey preserves the other journey's images and original provenance.
Do not hand-edit a capture or its digest to bypass a failed workflow.

Map Review remains an explicit live lane. Follow [the showcase setup](../showcase.md#demo-6-map-review),
record `pnpm showcase:record map-review`, then export `pnpm site:media --journey map-review`.
It requires a rendering fixture editor on the colorful Camera Lab map, `L_CameraLoad`. The
journey creates both Capture Runs itself and verifies switching between them, so an old local
capture cannot silently become the website baseline. The site displays the actual capture date.

## Continuous checks and review artifacts

The portable workflow's website job runs `site:check` on pull requests and `main`. It checks
manifest/image integrity, builds the production site (including StyleX extraction), and uses
Chromium to exercise direct guide URLs, navigation, image decoding, keyboard tabs, and narrow
layouts. It uploads full-page desktop and mobile captures and failure traces under
`website-evidence-<run-id>`. Locally, those artifacts are under `test-results/site`.

These are functional checks and visual review artifacts, not pixel-diff regression baselines.
They do not prove that Workbench screenshots are fresh after arbitrary application changes.
Run `site:refresh` in the same change when the illustrated workflows change, and review the
resulting image diff. Unreal-dependent capture remains a separate local run; ordinary website
CI needs neither Unreal nor a running Workbench.

## Add a workflow

1. Add actions and visible-state assertions to the recorder, then capture the successful state.
2. Add the chapter slug and stable image key to `scripts/site-media-model.ts`.
3. Export a passing recording, then reference that key in `apps/site/src/guides.ts` and, when
   useful, the homepage showcase tabs.
4. Add the guide URL to the browser test in `apps/workbench/e2e/site/site.e2e.ts`.
5. Run `pnpm site:check` and inspect its desktop/mobile captures.

Preview locally with `pnpm --filter @ue-shed/site dev`. Deployment remains the existing explicit
`pnpm --filter @ue-shed/site deploy` operation.

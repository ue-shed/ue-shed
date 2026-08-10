# Showcase

The showcase is the shortest path from a fresh clone to UE Shed's implemented proving slices. It
uses the committed generic fixture as its default project and keeps live Unreal an optional
capability.

Workbench surfaces every proving workflow on one operational home: Data Authoring, Input Atlas,
Game Text, Texture Audit, Map Review, World Log, and Camera Lab. The catalog groups them by what
they actually require: a saved project, Perforce on demand, or a running Unreal session. Each entry
shows evidence from the selected project before it is opened, including indexed candidate-package
and map counts. Saved-package workflows open without Unreal; live texture preview, Live World, and
Camera Lab request a separately enabled editor only when needed.

## Open the Workbench

Requirements are Node.js 22.14 or newer, pnpm 11, and Rust 1.88 or newer. Live actions additionally
require Unreal Engine 5.7 and Visual Studio 2022 with the Unreal Engine C++ workload. The initial
Workbench and saved-package demos do not require Unreal or Visual Studio. From the repository root:

```powershell
pnpm install
pnpm showcase
```

`showcase` incrementally builds the in-repo `uasset` reader and Workbench, configures the fixture
project, offline map, and texture-audit rules, and opens the catalog. It does not build or launch
Unreal up front. Texture Audit, Live World in Map Review, and Camera Load Lab each expose a launch
or connect action when their optional live capability is needed. If an editor is already serving
Remote Control on the usual local ports, `showcase` attaches to it. Otherwise it reserves the next
free HTTP/WebSocket pair so a later in-app fixture launch can claim that endpoint. The monitored
HTTP port is shown beside the editor status in the Workbench header; click it to enter another port.
The change takes effect immediately and is remembered on that device.

The source-checkout flow uses `target/debug/uasset.exe` (`target/debug/uasset` on other platforms).
To exercise another compatible reader build instead, override it before launching:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm showcase
```

The current-project strip reports the selected project, indexed package and map counts, and the
actual live camera-pipe state. Choosing a project is always offline and never starts Unreal. Once a
project is selected, the compact **Launch** menu offers two explicit process actions:

- **With UE Shed** incrementally builds and loads Core, Authoring, Cameras, Observatory, and Asset
  Audits through Unreal's `-PLUGIN` argument. It also enables Remote Control for that process.
- **Normally** opens the selected project without UE Shed plugin injection.

Neither action edits the selected `.uproject`. The disposable build host defaults to
`out/workbench-plugin-host/<engine>`; set `UE_SHED_PLUGIN_HOST_ROOT` when that cache should live on
another drive. A missing live endpoint does not prevent the saved-asset workflows from opening.

## Demo 1: DataTable authoring

The fixture also includes `DT_LargeScalars`, a deterministic 10,000-row table for exercising
catalog, snapshot, search, grid virtualization, and editing performance without using studio data.

Choose **Open table** on the showcase home. Workbench reads the committed scalar table directly from
its saved package, presents its typed rows and fields, and keeps authority and partial-package
diagnostics visible without opening Unreal. Use **Open saved table** to inspect another DataTable
`.uasset`.

The same public capability remains available from a repository shell:

```powershell
pnpm ue-shed authoring inspect fixtures\unreal-project\Content\Fixture\Authoring\DT_Scalars.uasset
```

Run `pnpm ue-shed help` to continue through persistent sessions, typed cell drafts, undo and redo.
Live apply and save use the same session model after the fixture editor is running.

For the cross-table story, open `DT_LeftReferences` from the project index and switch to
**Relationship view**. The two fixture references resolve into `DT_RightReferences` with their
canonical source and target columns kept visibly separate. Use **Isolate** on either table, then
**Show all**, to demonstrate that the view changes presentation without creating another draft.
Return to **Canonical table** and select a `Target` cell to show the typed row-reference picker.

The same relationship model is available headlessly:

```powershell
pnpm ue-shed authoring relationships fixtures\unreal-project
pnpm ue-shed authoring join fixtures\unreal-project /Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences Target
```

## Demo 2: Texture Asset Audit

Choose **Open audit**. The route immediately scans the committed texture corpus using
`FixtureSource/Audits/texture-rules.json`; use **Rescan** to repeat it. It demonstrates whole-corpus
distributions, per-asset serialized evidence, findings, and partial-package diagnostics without
launching Unreal. Selecting a texture requests the optional bounded live preview first. When no
editor is connected, choose **Generate saved previews** to prioritize the selected texture, then
all finding assets in the audit, then the rest of the current page, up to 100 unique textures. Use
**Locate in Unreal** in the selected asset header to synchronize a connected editor's Content
Browser to that texture; offline, missing-plugin, and not-found results remain visible in place.
One hidden `UnrealEditor-Cmd` process writes every cache miss as an individual saved-source PNG and exits;
existing cache entries skip the launch work. Choose **Launch Unreal for preview** only when the live
resource or unsaved editor state is wanted. Saved and live preview authority remain visibly distinct.

## Demo 3: Game Text

Choose **Game Text** from the nav. Workbench searches player-facing language across saved
DataTables, String Tables, and supported asset properties without flattening Unreal identity.
Every result is a dense writing worklist row: source text, Unreal identity, decoded authored
context, primary source authority, character count, and usage count stay visible together. A
single-use identity exposes `Locate` immediately; a shared identity exposes `Show uses`, then a
precise `Locate in Unreal` action for each occurrence. Locate synchronizes the Content Browser to
the owning asset when a capable editor is connected, and reports offline, missing-plugin, and
not-found states without pretending navigation happened. `Copy text` and `Copy ID` remain immediate
row actions. Selecting a line expands every known context while raw Unreal object paths and package
files remain behind technical disclosures. Occurrence evidence and coverage gaps stay inspectable
from the same corpus.

```powershell
pnpm ue-shed text scan fixtures\unreal-project
pnpm ue-shed text search fixtures\unreal-project "Fixture"
```

## Demo 4: Map Review

Map Review does not require fixture content or a pre-authored Review Set. Point Workbench or the CLI
at the project root. In Workbench, choose **Launch → With UE Shed** to load the required plugins for
that editor process without editing the project descriptor. The generic fixture's
[`UEShedFixture.uproject`](../fixtures/unreal-project/UEShedFixture.uproject) remains the reference
for projects that deliberately want persistent plugin entries instead.

Launch the editor with rendering available (not `-NullRHI`), choose its project in Workbench, and
click the `:port` control beside the editor status if Remote Control is not using the displayed
port. Environment configuration remains available for scripted launches:

```powershell
$env:UE_SHED_PROJECT_ROOT = "C:\path\to\Project"
$env:UE_SHED_REMOTE_CONTROL_ENDPOINT = "http://127.0.0.1:30001"
pnpm showcase
```

Open **Map Review**. The fixture preset opens **Saved Map** first. Its map picker includes the small
World Partition sample and the ordinary Camera Load level. The former reads only its matching
external-actor subtree; the latter reads its single `.umap`. Positions, labels, classes, packages,
and attachment-resolved transforms are available with Unreal closed. Saved Map deliberately has no
focus, follow, or authoring actions; switch to **Live World** when a running editor is the source
of truth.

For another project, set both the project root and the map path relative to it:

```powershell
$env:UE_SHED_PROJECT_ROOT = "C:\path\to\Project"
$env:UE_SHED_SAVED_WORLD_MAP = "Content\Maps\Example.umap"
pnpm showcase
```

Set `UE_SHED_SAVED_WORLD_MAPS` to a semicolon-separated list of `.umap` paths when the offline
picker should offer more than one map. It takes precedence over the single-map variable.

With no `UE_SHED_REVIEW_SET`, live Map Review enters first-run authoring. Select an actor, review a
candidate, and keep it; only then does UE Shed write a deterministic map-scoped Review Set under
`.ue-shed/review/sets`. Set `UE_SHED_REVIEW_SET` when you want to work with an explicit existing
set. Use **Review Sets** to reopen any set in the project or create and open an empty sibling that
keeps the active map, Capture Profiles, and Visibility Policies. Switching back restores the saved
Views—and therefore the same approved cameras and angles. **Add selected actor as View** appends without replacing existing observations; choose an
approved View and **Revise selected View** only when the intent is to preserve its ID and advance
its revision. Several Views may share one actor, and Workbench groups them by subject without
changing the flat portable Review Set. Select a preview to expose its per-view distance, elevation,
yaw, FOV, and margin offsets. **View presets + rig** expands the named arc/ring generators that
rebuild the full contact sheet; exact final-pose fields update only the selected preview. Framing
warnings remain visible but do not prevent **Keep View**; a stale subject/session still requires an
explicit reframe. The count sliders show the ordinary 1–24 range; exact larger counts remain valid
and show a preview-cost hint. The headless equivalent is:

```powershell
pnpm ue-shed review authoring bootstrap "C:\path\to\Project" "http://127.0.0.1:30001"
pnpm ue-shed review authoring append "C:\path\to\Project" <review-set.json> "http://127.0.0.1:30001"
pnpm ue-shed review authoring tune "C:\path\to\Project" <session-id> framing-patch.json
pnpm ue-shed review authoring approve "C:\path\to\Project" <session-id> "http://127.0.0.1:30001"
```

Capture Set arms every approved View by default and persists one immutable run result per attempted
View. In **Visual history**, choose a View first, then move across runs to see captured, failed, or
not-in-run states. **Compare previous run** places the selected Natural frame beside the nearest
earlier Natural result for that View. Older revision evidence stays visible and is labeled as older framing; Natural
and Clear remain separately labeled evidence.

See [`products/map-review.md`](products/map-review.md) for the product contract.

### Exercise and record the complete Map Review flow

The dedicated fixture gallery contains compact, tall, wide, asymmetric, compound, translucent, and
occluded subjects. With its editor running, exercise the real-Unreal scenarios—including a durable
seven-View collection, two Views for the compound subject, persistence across a Workbench restart,
two full-set runs around a restored fixture change, and the permissive 37-camera case—with:

```powershell
$env:UE_SHED_FIXTURE_AUTHORING_MAP = "/Game/Fixture/MapReview/L_MapReviewFixture"
$env:UE_SHED_REMOTE_CONTROL_ENDPOINT = "http://127.0.0.1:30001"
pnpm fixture:launch-authoring
pnpm test:flow:map-review
```

On demand, record the same asserted authoring actions rather than a separate demo path:

```powershell
pnpm record:flow:map-review -- --flow authoring-roundtrip
pnpm record:flow:map-review -- --flow high-count-rig
```

Each invocation creates a new bundle under `test-results/map-review-flows` containing the combined
Workbench video across restart, Playwright trace segments, process and renderer logs, checkpoint
screenshots, both Run A/Run B 1280x720 Unreal captures, persisted authoring/Review Set JSON, and a versioned
manifest. The 1–24 slider is an ergonomic hint; `high-count-rig` enters 31 context cameras for 37
total and leaves the requested count intact.

## Demo 5: World Log

World Log is a saved-map history investigation workspace. It runs against Perforce but does not
need Unreal. Start its self-contained fixture with:

```powershell
pnpm showcase:world-log
```

The command builds the reader and Workbench, starts a temporary localhost Perforce server, and
opens Workbench with the World Partition map already selected. Open **World Log**, choose **Map
History World**, and run the scan. Try the changelist lens, choose an actor from the list or the 2D
map, then use the time control to see the actor move, appear, or disappear. The temporary server,
client workspace, credentials, and configuration are removed when Workbench closes.

## Demo 6: Camera Load Lab

Camera Load Lab is the live camera data-plane slice. Open it and choose **Launch Camera Fixture**.
Workbench then discovers Unreal Engine 5.7, incrementally builds the fixture editor target, launches
`/Game/Fixture/Cameras/L_CameraLoad` as a windowed Game world, and waits for the negotiated Remote
Control endpoint.

The lab connects automatically and reports scheduler, render/readback, transport, and presentation
measurements separately. If you already have a process listening on the configured fixture endpoint,
the launcher reuses it rather than starting another Unreal process.

## Using another project

The launcher defaults are only showcase presets. Override them with environment variables:

```powershell
$env:UE_SHED_PROJECT_ROOT = "C:\path\to\Project"
$env:UE_SHED_TEXTURE_AUDIT_RULES = "C:\path\to\texture-rules.json"
$env:UE_SHED_REMOTE_CONTROL_ENDPOINT = "http://127.0.0.1:30001"
pnpm showcase
```

Workbench remains a client of public packages. Deleting it does not remove the CLI or any domain
capability demonstrated here.

## Record a review video

Record the deterministic saved-data journey without launching Unreal:

```powershell
pnpm showcase:record
```

The command builds Workbench, opens it through Playwright, and records Data Authoring, Texture Audit,
and Game Text. Every invocation writes a new timestamped review bundle under
`test-results/showcase`; earlier recordings are never replaced. A successful bundle contains
`demo.webm`, chapter screenshots, `trace.zip`, `workbench.log`, and a versioned `run.json` manifest.
During local iteration, pass `--no-build` to reuse the existing Workbench build:

```powershell
pnpm showcase:record --no-build
```

To showcase Map Review by creating fresh evidence and comparing it with the prior Capture Run:

```powershell
pnpm showcase:record map-review
```

This journey requires one prior successful Capture Run. It launches or reuses the configured Unreal
fixture before recording, then captures the approved Review Set live, verifies the new immutable run
and its 1280x720 image, and demonstrates before-and-after history navigation. Fixture startup stays
out of the review video; a failed live capture fails the recording rather than presenting stale
evidence as a successful showcase.

To record the self-contained World Log history walkthrough:

```powershell
pnpm showcase:record world-log
```

It starts the disposable local Perforce fixture for the recording, scans the World Partition map,
and records actor movement, a label change, removal across time, and unclassified package evidence.
It does not launch Unreal.

## Publish captures to the site

The public site only shows real Workbench media — no mockups. After a journey records a passing
bundle, export its curated chapter frames into `apps/site/public/media` and regenerate the site's
typed media manifest:

```powershell
pnpm site:media
```

The exporter picks the latest passing bundle per journey; pin a specific one with
`pnpm site:media --bundle map-review=<recording-id>`. The site renders only what the manifest
exports, and the showcase tabs fail typecheck if their capture leaves the manifest, so published
media cannot drift from a real recording.

Review exported frames before deploying. Captures show the real Workbench, including whatever
diagnostics it surfaces; withhold a capture in `scripts/site-media.mjs` rather than publish an
embarrassing frame.

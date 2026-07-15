# Showcase

The showcase is the shortest path from a fresh clone to UE Shed's three implemented proving
slices. It uses the committed generic fixture as its default project and keeps live Unreal an
optional capability.

## Open the Workbench

Requirements are Node.js 22.14 or newer, pnpm 10, and Rust 1.85 or newer. Live actions additionally
require Unreal Engine 5.7 and Visual Studio 2022 with the Unreal Engine C++ workload. The initial
Workbench and saved-package audit do not require Unreal or Visual Studio. From the repository root:

```powershell
pnpm install
pnpm showcase
```

`showcase` incrementally builds the in-repo `uasset` reader and Workbench, configures the fixture
project and texture-audit rules, and opens the catalog. It does not build or launch Unreal up front.
Texture Audit and Camera Load Lab each expose a launch action when their optional live capability is
needed. If another process occupies the default Remote Control port, the showcase reserves the next
available port for its fixture.

The source-checkout flow uses `target/debug/uasset.exe` (`target/debug/uasset` on other platforms).
To exercise another compatible reader build instead, override it before launching:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm showcase
```

The readiness strip reports whether the fixture preset, reader, and live Unreal endpoint are
available. A missing live endpoint does not prevent the saved-asset demos from opening.

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

## Demo 2: Texture Asset Audit

Choose **Open audit**. The route immediately scans the committed texture corpus using
`FixtureSource/Audits/texture-rules.json`; use **Rescan** to repeat it. It demonstrates whole-corpus
distributions, per-asset serialized evidence, findings, and partial-package diagnostics without
launching Unreal. Selecting a texture requests an optional bounded live preview. Choose **Launch
Unreal for preview** to build and start the fixture only when that visual evidence is wanted. Preview
authority is labeled separately because an editor can contain unsaved state.

## Demo 3: Camera Load Lab

Camera Load Lab is the live slice. Open it and choose **Launch Camera Fixture**. Workbench then
discovers Unreal Engine 5.7, incrementally builds the fixture editor target, launches
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

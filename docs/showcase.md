# Showcase

The showcase is the shortest path from a fresh clone to UE Shed's three implemented proving
slices. It uses the committed generic fixture as its default project and keeps live Unreal an
optional capability.

## Open the Workbench

Requirements are Node.js 22.14 or newer and pnpm 10. From the repository root:

```powershell
pnpm install
pnpm showcase
```

`showcase` builds Workbench, configures its fixture project and texture-audit rules, and opens the
showcase catalog. It does not rebuild or launch Unreal Engine.

Saved-package inspection also needs the independently distributed `uasset` reader. Either make its
executable available on `PATH` or configure it before launching:

```powershell
$env:UE_SHED_UASSET_EXECUTABLE = "C:\path\to\uasset.exe"
pnpm showcase
```

The readiness strip reports whether the fixture preset, explicit reader, and live Unreal endpoint
are available. A missing live endpoint does not prevent the saved-asset demos from opening.

## Demo 1: DataTable authoring

Use **Copy CLI demo** on the showcase home, then run the copied command from a repository shell. The
first command inspects the committed scalar table without opening Unreal:

```powershell
pnpm ue-shed authoring inspect fixtures\unreal-project\Content\Fixture\Authoring\DT_Scalars.uasset
```

Run `pnpm ue-shed help` to continue through persistent sessions, typed cell drafts, undo and redo.
Live apply and save use the same session model after the fixture editor is running.

## Demo 2: Texture Asset Audit

Choose **Open audit**. The route immediately scans the committed texture corpus using
`FixtureSource/Audits/texture-rules.json`; use **Rescan** to repeat it. It demonstrates whole-corpus
distributions, per-asset serialized evidence, findings, and partial-package diagnostics without
launching Unreal.

## Demo 3: Camera Load Lab

Camera Load Lab is the live slice. It needs Unreal Engine 5.7 and the fixture project running the
camera map:

1. Run `pnpm fixture:build` once.
2. Open `fixtures/unreal-project/UEShedFixture.uproject` in Unreal Editor.
3. Open `/Game/Fixture/Cameras/L_CameraLoad` and start Play In Editor.
4. Keep stock Remote Control enabled on loopback port `30001`.
5. Open **Camera Lab** from Workbench.

The lab connects automatically and reports scheduler, render/readback, transport, and presentation
measurements separately. If Remote Control is unavailable, the rest of the showcase remains usable.

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

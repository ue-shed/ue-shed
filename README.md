# UE Shed

**External tools for Unreal Engine development.**

UE Shed is a headless-first toolset for working with Unreal Engine content. It reads useful saved
package data without starting the editor, adds live-editor capabilities only where live state is
actually needed, and presents both through a desktop Workbench built on the same public APIs as the
CLI and libraries.

The project is for the everyday work around an Unreal project: inspecting and editing DataTables,
auditing assets, searching game text, reviewing maps and captures, and understanding what a live
world is doing. The Workbench is the reference application for those workflows, not a privileged
architecture layer. You can use the command-line tools on their own, embed a maintained extension,
or build another host on the same contracts.

[Showcase walkthrough](docs/showcase.md) · [Documentation](docs/README.md) ·
[Project site source](apps/site)

## Built with Codex

UE Shed was built mostly with Codex and GPT-5.6. The checked-in contracts, fixtures, and tests keep
the resulting behavior reviewable and reproducible.

## What is in the app

Workbench brings together saved-content workflows that work from a source checkout and live
workflows that connect to a separately enabled Unreal editor when you ask for them.

| Workflow                | What it is for                                                                              | Needs Unreal running?                            |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Data Authoring**      | Inspect typed DataTables, then stage safe live edits with drafts, undo/redo, and review.    | No for inspection; yes for editing and apply.    |
| **Texture Asset Audit** | Scan texture content against rules and inspect serialized evidence and diagnostics.         | No; live previews are optional.                  |
| **Game Text**           | Search player-facing text across DataTables, String Tables, and supported asset properties. | No.                                              |
| **Map Review**          | Author a review set, capture cameras, and compare immutable before/after runs.              | Yes for capture and editor actions.              |
| **World Scout**         | Browse a live actor catalog, filter it, and follow or frame actors on a world map.          | Yes; enabled through the Observatory capability. |
| **Camera Load Lab**     | Measure camera capture, readback, transport, and presentation as distinct stages.           | Yes.                                             |

The saved-package paths use the in-repository Rust `uasset` reader, so they remain useful in CI and
on machines without Unreal. The most useful showcase workflows, however, need a local Unreal Engine
5.7 installation: live DataTable editing, Map Review, World Scout, and Camera Load Lab all work
against a running editor. Live paths are deliberately capability-driven: the small `UEShed*` plugins
and stock Remote Control advertise what is available, and clients keep authority, freshness, and
missing-capability diagnostics visible rather than guessing.

## Try the Workbench

The committed generic fixture is the fastest way to see the product. For the full showcase, install
Unreal Engine 5.7 and Visual Studio 2022 with the Unreal Engine C++ workload, alongside Node.js
22.14 or newer, pnpm 10, and Rust 1.85 or newer.

```powershell
pnpm install
pnpm showcase
```

`pnpm showcase` builds the local package reader and Workbench, configures the fixture project and
audit rules, then opens the catalog. It does not launch Unreal up front; the live routes offer a
launch or connect action when you need it. Install Unreal before running the showcase if you want to
use the primary editing, world-review, and camera workflows rather than only the saved-package demos.

The showcase can launch the fixture on demand, or you can point it at your own project and Remote
Control endpoint. The [showcase walkthrough](docs/showcase.md) has the complete setup, project
overrides, and repeatable demo steps.

## Use the tools without the app

Everything the Workbench does is intended to have a headless boundary. Start with the CLI:

```powershell
pnpm install
pnpm ue-shed --help
pnpm ue-shed authoring inspect fixtures\unreal-project\Content\Fixture\Authoring\DT_Scalars.uasset
```

From a source checkout, the CLI incrementally builds and uses the in-repository Rust reader. Set
`UE_SHED_UASSET_EXECUTABLE` only when you deliberately want to test a different compatible reader
build.

To add a maintained Data Authoring interface to a Solid/Vite host, follow the
[adoption guide](extensions/data-authoring/ADOPTING.md) and its
[machine-readable manifest](extensions/data-authoring/adoption.manifest.json). To build a trusted
non-Electron host, start from the [headless authoring example](examples/authoring-headless/README.md).
The browser or desktop transport is an embedding decision; the domain client contract remains the
same.

## How the pieces fit

- [`crates/`](crates/) contains the Rust saved-package reader.
- [`packages/`](packages/) contains reusable TypeScript domains, contracts, and clients.
- [`extensions/`](extensions/) contains the maintained product UI slices used by Workbench.
- [`unreal/`](unreal/) contains the separately enabled Unreal companion plugins.
- [`apps/workbench/`](apps/workbench/) is the Electron showcase and dogfood client.
- [`fixtures/`](fixtures/) is the reproducible generic Unreal project used for demos and
  conformance checks.
- [`docs/`](docs/README.md) is the source of truth for architecture, engineering guidance, product
  contracts, decisions, and walkthroughs.

The important boundary is intentional: deleting Workbench does not remove the CLI, packages, or
Unreal capabilities. It simply removes one client of them.

## Developing UE Shed

Run the complete repository check before sending a change for review:

```powershell
pnpm check
```

The fixture commands build, generate, and verify the generic Unreal project when you are changing
the live integration:

```powershell
pnpm fixture:build
pnpm fixture:generate
pnpm fixture:verify
```

For architecture, product boundaries, and the current status of individual workflows, begin at the
[documentation index](docs/README.md). The [public project site source](apps/site) is kept alongside
the application and is a good visual overview; the documentation holds the detailed setup and
contract material.

## License

UE Shed is available under the [MIT License](LICENSE). Third-party dependencies and Unreal Engine
retain their own licenses. The Data Authoring grid uses the formula-free MIT
`peculiar-sheets@0.11.0` core; UE Shed does not distribute HyperFormula or an optional formula-engine
adapter.

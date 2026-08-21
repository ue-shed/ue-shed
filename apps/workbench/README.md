# UE Shed Workbench

The optional Electron showcase and dogfood client. It will demonstrate what can be built with public
UE Shed libraries, but it must never own domain behavior or receive privileged engine access.

The renderer uses SolidJS and composes shared StyleX themes/primitives with independently owned
product-extension styles. Workbench may select a theme but must not repair extensions through global
CSS overrides.

Workbench opens on a showcase catalog for the implemented proving slices: DataTable authoring,
Texture Asset Audit, Game Text, Map Review, Niagara Preview, Camera Load Lab, and the Perforce-first
**World Log**.
The catalog exposes each slice's runtime mode and readiness instead of assuming Unreal is running.
Camera Load Lab can drive and observe up to 32 camera sources while presenting eight tiles at once
behind an independent display-byte budget. The editor status in the header shows the Remote Control
port Workbench is monitoring; its adjacent port control changes that target immediately and saves
the choice on the device.

Niagara Preview is available at `#/niagara-preview`. It runs the public `@ue-shed/niagara` service
against the selected project and returns only validated run metadata and manifest-owned PNG bytes to
the renderer. The separately enabled `UEShedNiagara` Editor plugin remains the Unreal capability
boundary.

World Log is a map-scoped historical view. It requires `UE_SHED_PROJECT_ROOT` and normal Perforce
configuration only when the user starts a bounded history query. Opening Workbench, opening the
route, and checking its configured state do not run a Perforce command or alter workspace have-state.
Its renderer receives only validated status/start/cancel operations; Perforce and temporary-file
authority stay in the main process.

From the repository root, launch the fixture-configured showcase with:

```text
pnpm showcase
```

See [`docs/showcase.md`](../../docs/showcase.md) for the saved-asset reader, fixture, and live Unreal
instructions. Direct Workbench build and start commands remain available for host development.

## End-to-end tests

From the repository root, build and test the real Electron app against the committed fixture:

```text
pnpm test:e2e:workbench
```

Use `pnpm test:e2e:workbench --no-build` while iterating on tests against an existing build, or
`pnpm test:e2e:workbench:ui` to open Playwright's interactive runner. New journeys should use the
shared launch fixture and `WorkbenchPage` under `e2e/`; failed runs retain a screenshot and trace in
the root `test-results/workbench` directory.

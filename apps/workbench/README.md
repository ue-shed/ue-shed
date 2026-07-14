# UE Shed Workbench

The optional Electron showcase and dogfood client. It will demonstrate what can be built with public
UE Shed libraries, but it must never own domain behavior or receive privileged engine access.

The renderer uses SolidJS and composes shared StyleX themes/primitives with independently owned
product-extension styles. Workbench may select a theme but must not repair extensions through global
CSS overrides.

Workbench opens on a showcase catalog for the three implemented proving slices: DataTable authoring,
Texture Asset Audit, and Camera Load Lab. The catalog exposes each slice's runtime mode and readiness
instead of assuming Unreal is running. Camera Load Lab can drive and observe up to 32 camera sources
while presenting eight tiles at once behind an independent display-byte budget.

From the repository root, launch the fixture-configured showcase with:

```text
pnpm showcase
```

See [`docs/showcase.md`](../../docs/showcase.md) for the saved-asset reader, fixture, and live Unreal
instructions. Direct Workbench build and start commands remain available for host development.

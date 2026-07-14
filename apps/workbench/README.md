# UE Shed Workbench

The optional Electron showcase and dogfood client. It will demonstrate what can be built with public
UE Shed libraries, but it must never own domain behavior or receive privileged engine access.

The renderer uses SolidJS and composes shared StyleX themes/primitives with independently owned
product-extension styles. Workbench may select a theme but must not repair extensions through global
CSS overrides.

The first implemented extension is Camera Load Lab: a SolidJS/StyleX wall backed only by
`@ue-shed/cameras`. It can drive and observe up to 32 camera sources while presenting eight tiles at
once behind an independent display-byte budget. Producer, transport, process-memory, and
presentation measurements remain separate, and engine schedule controls use the public Remote
Control adapter.

Build and launch it with:

```text
pnpm --filter @ue-shed/workbench build
pnpm --filter @ue-shed/workbench start
```

The fixture game must be running with `/Game/Fixture/Cameras/L_CameraLoad` and Remote Control enabled.

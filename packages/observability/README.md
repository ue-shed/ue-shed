# `@ue-shed/observability`

Shared, headless OpenTelemetry composition, bounded runtime metrics, and schema-owned health for UE
Shed hosts. Applications provide `runtimeObservabilityLayer` once at their root. Local use does not
require an exporter; set `UE_SHED_TELEMETRY_MODE=console` to emit local traces, metrics, and logs.

```sh
npm install @ue-shed/observability@0.1.0-rc.3
```

`RuntimeHealthService` is the diagnostic authority for CLI and UI clients. Consumers report typed
capability, connection, reader, stream, and telemetry state rather than parsing logs.

Node.js 22.14 or newer is required. This is a headless Node-host package; it does not depend on
Workbench, Electron, or any Unreal plugin.

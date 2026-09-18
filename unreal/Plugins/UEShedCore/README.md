# UEShedCore

The separately enabled editor capability for producer identity, health, and capability discovery.
It exposes a small reflected JSON manifest that stock Remote Control clients can query without
knowing authoring implementation object paths.

The editor-only `UEShedCoreEditor` companion advertises `editor.play-session.v1` and
`editor.world-control.v1`. It observes and controls one local Play In Editor or Simulate In Editor
session, and it can open one explicit `/Game/` map without player input. World control never saves or
discards: it rejects an active play session or any dirty world package before switching maps. The
runtime module remains free of editor dependencies.

`editor.window-activation.v1` exposes `ActivateEditorWindow` for explicit handoffs from external
tools. It targets this process's main editor window or active modal, restores a minimized window,
and verifies foreground ownership on Windows. The caller supplies the manifest's process ID;
stale identities and blocked activation remain explicit results. The shared
[`@ue-shed/engine` service](../../../packages/engine/README.md) also handles local foreground
permission. Wire clients can use the
[window activation contract](../../../packages/protocol/contracts/core/v1/WINDOW-ACTIVATION.md)
directly.

The capability manifest optionally includes engine/process/session identity and loaded UE Shed plugin descriptor versions. `ue-shed doctor --endpoint <url>` exposes this evidence; capabilities remain authoritative for compatibility.

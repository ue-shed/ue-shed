# UEShedCore

The separately enabled editor capability for producer identity, health, and capability discovery.
It exposes a small reflected JSON manifest that stock Remote Control clients can query without
knowing authoring implementation object paths.

The editor-only `UEShedCoreEditor` companion advertises `editor.play-session.v1` and
`editor.world-control.v1`. It observes and controls one local Play In Editor or Simulate In Editor
session, and it can open one explicit `/Game/` map without player input. World control never saves or
discards: it rejects an active play session or any dirty world package before switching maps. The
runtime module remains free of editor dependencies.

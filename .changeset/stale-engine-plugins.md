---
"@ue-shed/engine": patch
---

Expose a structured engine_plugins_stale launch failure when Remote Control dependencies have
outdated module identities on a buildable Windows source engine. Missing binaries and installed
engines retain plugin_unavailable, allowing hosts to offer a targeted rebuild only when appropriate.

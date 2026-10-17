---
---

UEShedObservatory's Remote Control functions no longer assert that the stream service exists. A call that arrives while the module shuts down now returns `status: "failed"` with `code: "service_unavailable"` and `retrySafe: true`. The camera authoring bridge keeps its game-thread assert and documents why input cannot reach it. Plugin-only; no package changes.

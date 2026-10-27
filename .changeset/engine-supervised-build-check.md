---
"@ue-shed/engine": minor
---

A supervised editor session now checks the project's build ID and the engine's Remote Control build before it starts the editor, as the plain launcher does. A project compiled for another engine fails at once with `build_mismatch` (stage `validation`, next step `fix_input`) instead of a readiness timeout. `SupervisedEditorSessionError` gains the codes `build_mismatch`, `invalid_module_manifest`, `plugin_unavailable` and `engine_plugins_stale`; the launcher's error is kept as the cause.

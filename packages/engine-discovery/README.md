# `@ue-shed/engine-discovery`

Discovers supported Unreal installations, projects, editor processes, and reachable sessions without
hardcoded machine paths. Discovery results must include provenance and actionable diagnostics.

The first implemented session boundary is `EditorPlaySession`. It negotiates the separately
advertised Unreal editor capability and exposes typed status, start, simulate, pause, resume, and
stop operations without depending on Workbench.

---
"@ue-shed/engine": minor
---

`ProcessSupervisorExecutable` and `processSupervisorExecutableLayer(path)` let a host run the
Windows process supervisor from its own location, such as an Electron app's resources, instead of
resolving it from the installed `@ue-shed/engine-win32-x64` package. Editor launches and foreground
permission both use it.

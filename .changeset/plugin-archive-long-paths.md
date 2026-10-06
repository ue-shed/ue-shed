---
"@ue-shed/plugin-distribution": patch
"@ue-shed/engine": patch
---

Compiled plugin archives accept paths longer than 100 bytes. The ustar writer split them at a slash
before the 101st byte from the end, which always left a name over 100 bytes, so packaging any
plugin with a long source path (such as the camera-authoring panel) failed with "Archive path is
too long". It now splits at the first slash that fits, measured in bytes.

Engine discovery also finds engines the Epic Games Launcher installed outside Program Files, by
reading the Launcher's `LauncherInstalled.dat`.

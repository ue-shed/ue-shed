---
"@ue-shed/engine": minor
"@ue-shed/niagara": patch
---

Editor launches take per-run options, on both `UnrealProjectLauncher` and supervised sessions:

- `startupMap` opens a map directly (`/Game/Maps/Arena`) instead of loading the default map first. A `/Game` map or a launched plugin's map that does not exist fails with `startup_map_missing` before spawning, because the editor would otherwise open the default map without a word.
- `logPath` writes the run's editor log to an absolute path; the launch result, session handle and early-exit error name it.
- `sourceControl: "disabled"` starts the editor without connecting to source control for that run.
- `additionalArguments` passes other editor switches. Switches the launcher owns, or that would break the session or the user's project (plugins, Remote Control, `-NullRHI`, `-run=`, `-game`, crash-recovery switches and others), are refused with `invalid_request`; `reservedUnrealEditorArgument` gives the reason.
- With plugins, `remoteControlAllowedFunctions` allows single engine or project functions on UE 5.8, and `remoteControlWebSocketPort` sets the WebSocket port, so a host no longer rewrites the launcher's arguments.
- Supervised sessions add `unattended` (no dialogs; refused with `recovery_pending` while the project has unsaved work to recover, because the editor would delete it) and `window: "offscreen"` (UE 5 only).

Live Coding is now really off in plugin sessions: `-NoLiveCoding` is a build-tool switch the editor ignores, so the launcher sets the Live Coding setting for the run instead. Niagara preview and other commandlets pass `-SCCProvider=None` in place of `-nop4`, which only AutomationTool reads.

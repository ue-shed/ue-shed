# UE Shed Automation

An optional runtime plugin for explicit local-player discovery, one-shot Enhanced Input injection,
and CSV captures owned by UE Shed. It runs in PIE and development game builds. Enable it with
`UEShedCore` and `EnhancedInput`; there is no Workbench dependency.

Call `/Script/UEShedAutomation.Default__UEShedAutomationLibrary` through your trusted Unreal
transport. `ListPlayers`, `InjectInput`, and `CsvProfiler` each accept `RequestJson` and return
`ResultJson`. Their authoritative version 1.0 contracts are in `packages/protocol/contracts/automation`.
Requests are limited to 16 KiB of UTF-8 JSON and must execute on the game thread. Invalid inputs
return a rejected result and an error code, including wrong nested JSON types and unsupported versions.

Select an already-loaded game world explicitly. Player discovery enumerates that world's game
instance local players. Injection additionally selects the controller and an already-loaded Input
Action by object path. The controller must belong to the chosen world and local player, and the
typed boolean/axis value must match the action exactly. Injection applies once at the next Enhanced
Input evaluation; clients must reinject on later frames to sustain a value.

CSV commands select `status`, `start`, or `stop`. Output remains under the project's profiling
directory in `CSV/UEShed`; clients cannot supply paths. Queued starts report `starting` and no output
file. Stops report `stopping` until the engine's asynchronous completion settles. Starts and stops
are idempotent. An outside capture cannot be claimed or stopped. A unique engine output filename
proves ownership even when a competing queued start causes Unreal to ignore ours. Disabled
`CSV_PROFILER` builds return typed unavailability and omit the profiling capability from discovery.

Module shutdown requests completion only for its owned active capture. Unreal has no public
cancellation API for queued starts; process-exit cleanup remains engine-owned, and dynamic module
unloading is disabled. The module never ends a capture belonging to another caller.

Run `pnpm test:unreal-plugins` with `UE_SHED_UNREAL_ENGINE_ROOT` set separately to UE 5.7 and UE 5.8.
The isolated compatibility project executes `UEShed.Automation.Input` and
`UEShed.Automation.Profiling`, including real one-shot evaluation, queued stop completion, ownership,
and shutdown. Profiling tests refuse to run against an ordinary user project or an active capture.

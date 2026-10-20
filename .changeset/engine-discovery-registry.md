---
"@ue-shed/engine": patch
---

Engine discovery also reads the Launcher's `HKLM\SOFTWARE\EpicGames\Unreal Engine` keys, so it finds
Launcher engines when `LauncherInstalled.dat` does not list them. The newly exported
`installedEngineRoots` lists the candidate engine folders (Launcher install list, those registry
keys and `Program Files\Epic Games`) for hosts that choose an engine by version, and
`registeredBuildRoot` resolves a custom engine association. `makeEngineInstallationDiscoveryLayer`
builds the discovery layer with a supplied registry query, so tests see only the engines they
create.

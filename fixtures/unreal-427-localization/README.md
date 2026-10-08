# Unreal 4.27 localization format fixture

This project has no compiled module. Its `.ini` text input is gathered by the stock 4.27
`GatherTextFromSource` commandlet. The authored `Config/Localization/Fixture427.ini` is a single
commandlet recipe input; it is not a Dashboard-generated per-operation config. The 5.x fixture
separately exercises Dashboard settings and Unreal-generated per-operation configs.

Set `UE_SHED_UNREAL_ENGINE_ROOT` to a discovered 4.27 installation and run
`pnpm fixture:generate-localization-427`. The runner uses `UE4Editor-Cmd.exe`, with no build,
`-Preview`, `-GatherType`, or source-control switch. It resets only this target's output directory.

Commit the Unreal-generated `Content/Localization/Fixture427` files after generation. Manifest,
archives, PO, locres, locmeta, CSV and conflicts report must never be written by hand. Native text
and empty foreign archives suffice here: this fixture proves output formats, while the 5.x fixture
proves translation states. A failed 4.27 commandlet run is an explicit verification gap; shipped
engine localization files remain the fallback format reference.

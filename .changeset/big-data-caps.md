---
"@ue-shed/game-text": minor
"@ue-shed/plugin-distribution": minor
"@ue-shed/uasset-inspection-wasm": minor
---

Baselines, large packages, plugin installs and authoring Apply no longer fail on caps a host couldn't raise.

- Game Text baselines: `GameTextWorkspaceHost.baselineLimits` sets `maxEntries` (default 100,000)
  and `maxFileBytes` (default 64 MiB, raised from 16 MiB). Saving used to fail at about 50,000
  entries with only "The file operation failed.", because the 16 MiB file cap came before the entry
  cap. Over either limit, the message now gives the sizes and names the option. `LocalizationBaseline`
  no longer bounds `entries` in the schema; `createLocalizationBaseline`,
  `indexedLocalizationBaseline` and `decodeLocalizationBaselineJson` take an optional
  `LocalizationBaselineLimits` instead.
- WASM inspection: `maxInputBytes` and `maxOutputBytes` can now be raised up to 512 MiB
  (`LIMIT_CEILING_BYTES`); they could only be lowered from 64 MiB, so large `.umap` files threw
  `WasmInputLimitError`. Defaults are unchanged, and the limit errors name the option.
- Plugin cache: publish, lease and prune wait up to `pluginStoreLayer({ lockWait })` (default
  10 minutes) for another live process holding the same variant's lock. They used to give up after
  about 10 seconds while the other process was still extracting a release of up to 2 GiB, failing
  with `PluginStorageFailure`. The timeout message names `lockWait`.
- Authoring Apply limits (1,024 commands, 1 MiB, 16 tables) are read from `[UEShed.Authoring]`
  `MaxCommands`, `MaxPayloadBytes` and `MaxTables` in the project's editor config, by both the
  capability manifest and Apply. They were literals typed separately in two plugins, so no project
  could raise them. A refused Apply names the setting.

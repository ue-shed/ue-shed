---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": minor
---

Decode more saved Blueprint, Sequencer and Niagara data. On UE 4.27: editable node pin suffixes,
soft object path structs, Blueprint class records, property GUID maps, numeric channels, Level
Sequence binding maps, data table row handles saved without default fields, and Niagara variable
records. On UE5: graph pins from saved revisions 1000 to 1018 (so `readSavedBlueprint` accepts
them too), Blueprint class records, DynamicCast nodes, splines, Niagara variable records, field
paths and newer numeric channel framing.
Keep every coverage gap while distinguishing text-free data from data that may hide text.
uasset-io 1.18 adds `textGapCounts` to package text records and `may_contain_text` to gaps;
older negotiated clients omit these fields. Native and WASM text status use the same evidence.
Game Text package text shards move to `package-text-v9`, so existing indexes re-extract packages
once.

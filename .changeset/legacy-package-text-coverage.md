---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/uasset-inspection-wasm": patch
"@ue-shed/game-text": minor
---

Decode more UE 4.27 saved Blueprint and Sequencer data, including editable node pin suffixes,
soft object path structs, Blueprint class records, property GUID maps and numeric channels.
Keep every coverage gap while distinguishing text-free data from data that may hide text.
uasset-io 1.18 adds `textGapCounts` to package text records and `may_contain_text` to gaps;
older negotiated clients omit these fields. Native and WASM text status use the same evidence.
Game Text package text shards move to `package-text-v9`, so existing indexes re-extract packages
once.

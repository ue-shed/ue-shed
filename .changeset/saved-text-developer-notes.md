---
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/game-text": minor
"@ue-shed/uasset-inspection-wasm": minor
"@ue-shed/uasset-win32-x64": minor
---

Keep saved FText translator notes. Keyed text and StringTable entries saved by UE 5.8 expose
`dev_notes` in `readSavedAsset` inspection output and compact text extraction, and Game Text
exposes them on each `TextOccurrence.devNotes`, separate from the source string and localization
identity. Older packages and empty notes produce `""`. `readSavedTable` text cells are unchanged.

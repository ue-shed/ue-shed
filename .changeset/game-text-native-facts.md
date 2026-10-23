---
"@ue-shed/game-text": patch
"@ue-shed/unreal-assets": patch
"@ue-shed/protocol": patch
---

Correct Game Text's native source, String Table, compiled-copy, collapsed-PO and deleted-package
facts. Missing String Table entries now report `string_table_entry_missing`. Retire the unused
inline localization actions; maintained callers continue through the export and detail APIs.

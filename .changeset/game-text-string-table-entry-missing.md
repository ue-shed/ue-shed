---
"@ue-shed/game-text": minor
---

Game Text quality gains a `string_table_entry_missing` check: text that references an entry a
known String Table does not have is reported with the table and key, so the missing entry can be
added or the reference pointed at an entry that exists. References to a table outside the scan
stay unreported, as they may resolve in engine or plugin content.

Unreal saves a String Table reference without source text, so a reference to a missing entry used
to be hidden from the Text tab and Quality. Its line and places now stay visible. The joined index
moves to `joined-native-v10`, so each target rebuilds its joined index once.

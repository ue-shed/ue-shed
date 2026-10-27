---
"@ue-shed/game-text": minor
---

Game Text quality gains a `string_table_entry_missing` check: text that references an entry a
known String Table does not have is reported with the table and key, so the missing entry can be
added or the reference pointed at an entry that exists. References to a table outside the scan
stay unreported, as they may resolve in engine or plugin content.

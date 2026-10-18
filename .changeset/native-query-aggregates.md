---
"@ue-shed/game-text": patch
"@ue-shed/uasset": patch
---

Reuse bounded native search aggregates within each immutable reader and select cursor pages from
ordered row IDs without copying every match. Keep namespace groups and filters consistent with
unresolved saved text whose localization key is empty.

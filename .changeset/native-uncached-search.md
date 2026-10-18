---
"@ue-shed/game-text": patch
"@ue-shed/uasset": patch
---

Accelerate uncached native Game Text searches over unique folded sources and localization counts.
Prepare the persisted source arena before the query reader is ready, with explicit stage timing,
while preserving substring, Unicode, translation search and incremental snapshot behavior.

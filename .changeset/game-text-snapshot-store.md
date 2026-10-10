---
"@ue-shed/game-text": minor
---

Add a compact Game Text snapshot format and a Node snapshot store. Sections are checksummed,
compressed and loaded only when first used, and publishing is atomic under one writer lock.
Nothing reads the store yet.

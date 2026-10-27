---
"@ue-shed/game-text": patch
---

A Scan that finds the project's text unchanged keeps the open Game Text index with its source and localization quality, instead of checking everything again. A rules document equal to the published one (a host's copy, or the same file reloaded) reuses the quality already computed for it.

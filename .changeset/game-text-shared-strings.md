---
"@ue-shed/game-text": minor
---

Store every Game Text index layer on one shared, append-only string store per project and
target, with compaction once unused strings pass a threshold. Layers hold compact ID columns.

---
"@ue-shed/game-text": minor
---

Filter Game Text by where text comes from. Search requests accept `where` with origin kinds
(String Table, DataTable, asset, C++, other gathered source) and a path prefix, applied to saved
units and gathered-only localization lines alike. Search counts add `origins`, which excludes the
origin filter itself. `text-origin.ts` exports the pure classifiers.

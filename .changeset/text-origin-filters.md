---
"@ue-shed/game-text": minor
---

Filter Game Text by where text comes from. Search requests accept `where` with origin kinds
(String Table, DataTable, asset, C++, other gathered source) and a path prefix, applied to saved
units and gathered-only localization lines alike. Search counts add `origins`, which excludes the
origin filter itself. `where.files` keeps the text a changed-file list touches, and the page's
`fileScope` summarizes the list. `text-origin.ts` exports the pure classifiers and file helpers.

Pair localization keys that changed with the key Unreal still lists: by the same saved place, the
same text in the same asset, or text unique in the project, strictly one to one. Lines carry
`keyChange`, selections accept `keyChanged`, and pages count new keys.

Baselines record each line's manifest path, and baseline comparison reports `keyChanged` pairs
instead of counting them as added and removed. `localizationKeyChangesAcross` pairs keys across
a gather.

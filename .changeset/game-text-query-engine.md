---
"@ue-shed/game-text": minor
---

Game Text searches run on cached row sets in the native engine, and a line's translator notes
include its manifest entries' notes. `LocalizationFocusRequest` takes the list's `culture` or
`cultures`, and `LocalizationFocus` returns the line's `problems` in that scope.
`TextCorpusSearchRequest` gains `openGroups` and `firstRows`, and the workspace and native query
gain `searchRows`, which returns a `TextCorpusRowsPage` (rows, or each open group's first rows)
without computing counts, facets or groups. Read further pages and open groups with it.

---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

Findings are rows of the engine's `query`: `selection.rows: "findings"` lists a findings layer's
findings, filtered by a `where` over finding fields (`rule`, `severity`, `culture`, `subject`,
`fixable`, `change`, `id`) and, through `row`, by the Text tab's filter on each finding's line or
unit. Facets count by any field, finding or text. The `findings_query` action is gone.

Quality's request (`WorkspaceQualityRequest`) takes `where` and `facets` in place of `severities`
and `fixable`; its page answers the requested `facets`. `@ue-shed/game-text/query` exports the
`QueryExpr` schema and the converter from pills to `where` (`textWhere`, `qualityWhere`,
`rowWhere`).

The Text tab's request (`TextCorpusSearchRequest`) takes the same `where` in place of `filter`,
`capability`, `withoutNotes`, the location `where` and the localization lens (`state`, `review`,
`keyChanged`, now `LocalizationLens`); a changed-file list is `fileScope`. `textWhere` builds the
`where` from those controls.

Investigation presets are version 3: they save the `where` and `fileScope` the list runs, Quality's
search and `where` (`workspaceNarrowing`), and the host's own `controls` (JSON UE Shed keeps but
never reads, so a host can show its controls again on open). Presets from earlier versions are
refused. `investigationControls` and `presetNarrowingRequest` are gone.

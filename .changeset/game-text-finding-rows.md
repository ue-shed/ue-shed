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
`rowWhere`). Saved investigation presets are unchanged and replay as before.

---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

Filter the Quality list with the Text tab's filter pills and count findings by folder, asset, asset type, origin and audience. `WorkspaceQualityRequest` takes `lineFilter`, a `TextFilter` over each finding's line; a source finding has no line, so no pill keeps it. Search, export, suggested fixes and export presets apply it like the rest of the narrowing; without an index, a request with pills fails rather than listing every finding. `facets` asks a page to count findings per folder (under a path), asset, asset type, origin and audience, each over every filter but its own pills, as the Text tab's facets count lines; the page answers `facets` in the Text tab's shape. The engine's `findings_query` takes `facets` beside `counts`, timed as its `facets` stage, and now times opening the findings layer as its `layer` stage.

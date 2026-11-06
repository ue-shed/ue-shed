---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

Search and narrow the Quality list. `WorkspaceQualityRequest` takes `query`, `severities` and `fixable` beside its check filter. `query` searches as the Text tab does, through the same native matcher: each word in the line's source or the finding's culture's translation, ignoring case. A source finding matches on its own source text. Search, export, suggested fixes and export presets (`workspaceNarrowing` on a quality preset query) all apply the same narrowing, and a report records it. The engine's `findings_query` takes `lines: { text, where }`, timed as its `lines` stage.

Counts now follow every filter except their own. A check's count follows the narrowing. A severity's count follows the check and the narrowing, leaving out the chosen severities. Before, `severityCounts` counted every check.

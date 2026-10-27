---
"@ue-shed/game-text": minor
---

Breaking: `GameTextWorkspaceProgress` is now an Effect Schema, exported from `@ue-shed/game-text/schema`, and carries raw phase codes instead of English text. Its `phase` is a `GameTextWorkspacePhase`: `idle`, `scanning`, `project_enumerating` or `project_scanning` while the host's project scan runs, or the running Game Text index phase (`localization`, `packages`, `source_quality` and so on). `stage` and `detail` are gone; word the phase with the new `GAME_TEXT_WORKSPACE_PHASE_LABELS`, or an index phase with `GAME_TEXT_INDEX_PHASE_LABELS`, both from `@ue-shed/game-text/labels`, which keep the wording `detail` had. During a quality scan, progress also carries `findings`, the findings so far.

Breaking: the host's `project.progress()` now returns a `GameTextWorkspaceProjectProgress` (`phase`, `completed`, `total`); any other fields a host's progress carries are ignored rather than passed through.

`GameTextIndexPhase` names the index's phase codes, from `./schema` and `./index`. The index's quality reads now name their first argument `ruleDocument` throughout, and their docs agree on how progress is counted: in rules evaluated, with the findings on the last event.

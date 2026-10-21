---
"@ue-shed/game-text": minor
---

Game Text classifies problems from one table. `TEXT_PROBLEM_RULES` says which localization states,
facts, unknown reasons and review signals raise each problem; `textProblems` reads it and the
native engine compiles a table generated from it, so filters, groups, aggregates and counts agree
with the labels. A parity test runs both over the same lines, with and without finding clauses.

- New problem `unchecked` ("Couldn't check"), after the findings and before up to date: a culture
  in scope whose state the evidence cannot prove. Up to date now means every culture in scope was
  confirmed. `TextProblemCounts` gains `unchecked`.
- "Not found in the project" counts as `changed_since_gather` rather than up to date.
- Findings follow the request: by default `shared`, `duplicate_source` and `unresolved` make a
  finding, not `long`. A `finding is` clause or lens that names a signal counts it as a finding for
  every problem in that request. Search rows (units and localization lines) carry `problems` and
  `countedFindings`, what put the row in its problems; `countedFindings()` and
  `textCountedFindings()` give the same in TypeScript.
- The localization gate still reports changed text from the `changed_since_gather` state, so not
  found lines stay `removed`.

---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

Browse's findings are the project's rules. A workspace evaluates the published rules and sets a
search's, focus's and line detail's `findings` layer; the page's `findings.status` says whether
they are `none`, `pending` or `ready`. With a target every rule runs, with the target review's
acceptance; without one, only source rules.

- `finding` clauses name rule IDs, and the new `fact` field takes the four facts (`unresolved`,
  `conflicting`, `evidence_only`, `compiled_copy_differs`). `facets.findings` lists every rule with
  its rows, `facets.facts` counts each fact, and `group: "finding"` groups by rule.
- The `finding` problem comes from rules whose `counts` is not `false`; `unresolved` no longer
  raises it. Rows, focus and detail list `findings` and `findingsOmitted`.
- The corpus export lists each unit's rules, and `gameTextCsv` adds a Findings column.
- Aggregates: the `finding` dimension is the layer's rules, and `review_signal` the facts.
- Removed: the search `lens`, the `shared`, `duplicate_source` and `long` signals and counts
  (also the summary's `review.shared`, `review.duplicateSource` and `review.long`),
  `countedFindings()`, `TEXT_FINDING_SIGNALS` and `TextCountedFinding`. A saved investigation's
  lens reads as the clause it now is (`investigationRequest`). `TextFinding`, `TextReviewLens`,
  `textFindings`, `textCountedFindings` and rows' `countedFindings` stay, deprecated.

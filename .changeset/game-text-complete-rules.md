---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

A rules file can hold complete rules: entries with `kind: "rule"` written in the engine's rule
language, with `when`, `actual`, `expectation` and `finding` references to other rules. Their
findings are custom findings with `check: "rule"`, listed under `custom.<id>` with the rule's
label. The engine's new `rules_check` request compiles a program and names the rule at fault;
a workspace and `loc check` report `invalid_expression` and `rule_cycle` as
`GameTextRuleDocumentError`s with the rule's `ruleId`. `customRulesOf`, `completeRulesOf` and
`ruleProblemError` are new; `LocalizationCustomFinding` is now a union with the `rule` variant.
The rule editor lists complete rules and says to edit them in the file.

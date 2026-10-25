---
"@ue-shed/game-text": minor
---

Source and localization rules take an optional `label`, which their findings carry in place of the
rule ID. `ruleLabelsOf(document)` names every rule a file lists by the rule ID its findings record.
The rule editor has a Label field; Quality's rules overview and Browse's findings show the label. A
line's findings now sit in the banner at the top of its page.

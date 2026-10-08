---
"@ue-shed/game-text": minor
---

Saved investigations can name a localization target. `GameTextInvestigationQuery` gains an
optional `localization` selection, and `exportGameTextInvestigation` takes the target's query, so
problem and translation filters export the lines the list shows; a preset that names a target
whose files are not supplied fails with guidance instead of throwing. Key changes pair by text
alone only when no other line on either side has that text, and baseline comparison follows the
same rule.

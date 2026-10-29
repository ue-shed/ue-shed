---
"@ue-shed/game-text": minor
"@ue-shed/map-history": minor
---

Game Text reads a target's C++ and config text (`@ue-shed/code`) and compares two points natively: `comparePoints` lists the lines a change adds, removes, rekeys or edits, and `localizationGateComparison` judges the change against the target's localization as the change found it, so only what the change introduces counts. The gate result gains an optional `change` describing what a changelist check read. Map History reads revisions at a changelist, the depot's head or the workspace's, classifies Perforce failures by cause, and refuses a changelist whose status is not the one asked for.

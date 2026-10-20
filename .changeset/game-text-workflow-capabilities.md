---
"@ue-shed/game-text": patch
"@ue-shed/localization": minor
"@ue-shed/protocol": minor
---

Route simple DataTable ID repairs through native Game Text when Authoring is absent. Use native
Game Text for cell-key regeneration even when Authoring is present, since Authoring's cell commands
cannot generate new keys. Admit the narrow key-repair capability independently of full localization
authoring. String-table migration
project checks use Core's projectRoot fact or an explicit host callback without editor-world
control. Preserve receipts, expected-value checks, session binding and saved-file verification.

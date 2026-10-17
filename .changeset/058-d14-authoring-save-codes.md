---
"@ue-shed/protocol": minor
---

Authoring Save 1.2 names why a package failed. UEShedAuthoring's Save per-package failures were prose only. They now add `code`: `table_not_found` when the DataTable could not be loaded, or `save_failed` when Unreal could not save the package. The save contract minor is now 2, and the plugin bundle advertises `unreal-authoring-save` 1.2. `AuthoringSaveResult` and `contracts/authoring/v1/save-result.schema.json` accept the optional `code`. Save 1.1 results still decode. Apply's command-level causes (`command_failed`) are unchanged.

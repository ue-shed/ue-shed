---
"@ue-shed/protocol": minor
---

Authoring Apply 1.3 names why a command failed. UEShedAuthoring reported every rejected command as `command_failed` plus prose. Each of its 48 command error sites now sets a stable `cause` beside the message, for example `stale_cell`, `stale_row`, `unknown_row`, `unknown_field`, `row_exists`, `rename_conflict`, `expected_enum`, `unknown_enum_value`, `string_table_entry_missing`, `generated_text_read_only` or `table_outside_plan`.

`code` stays `command_failed` so existing hosts behave the same. The apply contract minor is now 3, and the plugin bundle advertises `unreal-authoring-apply` 1.3. `AuthoringOperationError` and `contracts/authoring/v1/apply-result.schema.json` accept the optional `cause` (lower snake case, at most 64 characters). Apply 1.2 errors still decode.

---
"@ue-shed/cameras": patch
"@ue-shed/project-custodian": patch
"@ue-shed/unreal-assets": patch
---

Preserve unresolved authoring sessions and cleanup receipts, keep approved camera sessions
unchanged by later previews or world changes, and replace native reader workers that exit idle.
Game Text now retains pending translation writes when copying file lists and preserves ID-repair
ownership and receipts when the focused text is refreshed.

Camera setup hosts must now call `poll(bridge, projectName, { projectRoot, endpoint })`.
The required stable context argument scopes saved-set listings and acknowledgement outcomes to
one project and editor, including when bridge adapters are recreated between polls.

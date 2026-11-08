---
"@ue-shed/cameras": patch
"@ue-shed/game-text": patch
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

Keep Game Text rule saves, scan publication, localization selection, review batches and retries
owned by their originating operation and context. Preserve recoverable native query failures,
clear abandoned scan progress, and serialize duplicate thumbnail generation.
Workbench now serializes editor target changes, refreshes command status without stale polls,
retains current history jobs during cancellation, shares pending launches, and safely retires
camera sessions and preview bindings across failures and world changes.

Keep carried ID-repair translations attached to the target submitted with Apply. Retain refreshes
of the selected project while another project is opening, preserve newer rules selections when
an older save completes, scope scan progress to the logical scan, and clear recovered rules-file
errors without dismissing newer unrelated failures.

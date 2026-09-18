---
"@ue-shed/engine": minor
"@ue-shed/protocol": minor
---

Add capability-negotiated asynchronous editor map opens with operation identities, bounded retained
results and read-only completion polling. Lost acknowledgements never replay the map-open command;
long loads remain pending and expired waits report an indeterminate outcome. Expose current editor
map state separately, retaining compatibility with older synchronous companions.

Workbench confirms cross-map Review Set opens, offers saved-review-only browsing, reports editor/map
differences, and lets users explicitly follow the editor or switch it to their chosen map. Clarify
that browsing saved camera sets only reveals drafts; selecting a draft opens it for editing.

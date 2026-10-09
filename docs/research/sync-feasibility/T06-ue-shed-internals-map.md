# T06 — UE Shed internals map

Question: Which current domain mechanisms would a shared client/authority split replace or retain?

Why it matters for the sync layer: Prevents mistaking Workbench policy or camera-owned document authority for a generic live Unreal authority.

Method: Read requested files, rg exports/state/dispatch/persistence and client call sites; `evidence.py read repo PATH START END`. Line counts are physical lines including comments/blanks, measured at base commit; [CSV](evidence/T06-line-counts.csv). No engine-specific execution: same repository code targets both 5.7 and 5.8, runtime behavior UNVERIFIED here. One guessed `authoring-mutations.ts` filename absent; command union found in `authoring.ts`. Windows wildcard rg retried by directory/-g where needed.

Results:

Data Authoring lifecycle: `packages/authoring/src/session-service.ts:66-79` document contains draft, project, open/closed lifecycle and idle/apply/save pending operation. Repository `:416-447` persists to `<project>/.ue-shed/authoring/sessions/<id>.json` unless storage root configured, exclusive temporary file + fsync + rename. Load validates/migrates/quarantines bad documents (`:616-656`); update serializes through service-local semaphore (`:658-689`). Create/open/review/list/append/typed intents/undo/redo/discard live in `:838-1103`. Prepare Apply persists request before dispatch; failures/interruption become indeterminate; lookup reconciles same operation (`:1107-1164`). Save has separate pending receipt/recovery (`:1165-1218`).

Draft state: `draft.ts:79-105` holds base snapshots, fingerprints, command log/group IDs, undoPointer, apply/save receipts, awaitingSave. Pure folds (`:173-249`), append truncates redo branch (`:251-265`), group undo/redo (`:268-282`), workingTable = base + active commands (`:285-288`). Live Apply sends active commands once (`live.ts:63-123`), verifies exact result table set/fingerprints, replaces bases, clears commands/undo pointer and adds awaitingSave (`:144-213`). Offline draft undo is not Unreal undo. No reverse observation port (`live.ts:12-16`).

Clients: CLI `apps/cli/src/workflows/authoring.ts:331-338,465-488` acquires public AuthoringSessions and live adapter. Host `packages/host/src/authoring.ts:85-98` and on-demand repository path compose same services; public SDK `packages/authoring-sdk/src/index.ts:231-283` supplies begin/list/open/edit/review/undo/redo/apply/reconcile/save operations. Workbench composes ShedAuthoringLive (`apps/workbench/src/main/workbench-live.ts`, rg reference) and maintained extension uses the SDK. Two clients can open the same ID/file; no exclusive open ownership token. Within one shared service updates serialize. Separate processes/services can race load+persist: no repository CAS or interprocess writer guard in this session repository. Cross-process concurrent correctness is NOT established by temp+rename. Opening is reusable, simultaneous safe mutation needs additional coordination.

Every AuthoringCommand (`packages/protocol/src/authoring.ts:462-491`):

| Kind         | Payload / transaction fit                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------ |
| set_cell     | rowId, fieldName, oldValue/newValue; one gesture or grouped cell edits fit one Apply transaction |
| add_row      | atIndex, row snapshot; fits one transaction                                                      |
| remove_row   | atIndex, row snapshot; fits one transaction                                                      |
| rename_row   | row identity/name preconditions; fits one transaction                                            |
| reorder_rows | old/new row ID order; fits one transaction                                                       |

All five are native table mutations handled by existing Apply, including groups spanning tables. Session create/open/review/offline undo, approval and Save are not AuthoringCommand kinds; do not collapse them into that union. Transaction runtime effectiveness/order is T08/T10.

Camera mechanisms (classification relative to current authority; range line counts are inclusive, not a partition of whole-file LOC):

| Mechanism                                                                                           | Side                                      | File/range                                                      |               Lines |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | ------------------: |
| Durable document + revision/outcome checks, atomic file writes and process lock                     | Authority (Node document today)           | camera-authoring-store.ts `:121-249,306-473`                    | 129 + 168; file 512 |
| Approval projection intent + lost-export recovery                                                   | Authority (Node persistence)              | same `:318-348,393-473`                                         |             31 + 81 |
| Schema/HTTP transport + scope/producer/revision/sequence checks                                     | Client of native bridge                   | camera-authoring-bridge.ts `:58-190,213-308`                    |  133 + 96; file 505 |
| Native pending edits reconciliation, operation IDs, predecessor-chain guard, native acknowledgement | Client coordinator, writes Node authority | same `:349-505`                                                 |                 157 |
| Panel Ref/proposal, stale event guard/outcome dedup                                                 | Client coordinator                        | camera-authoring-panel.ts `:96-141`                             |        46; file 481 |
| Inspect/load/reconcile/apply/panel refresh tick                                                     | Client coordinator                        | same `:375-481`                                                 |                 107 |
| 250 ms scoped polling, serialized with semaphore; preview invalidation                              | Workbench client/host adapter             | apps/workbench/src/main/services/camera-workspace.ts `:112-155` |        44; file 442 |
| Compare actual transient actor poses/FOV/membership, increment sequence                             | Native resource authority/observer        | UEShedCameraAuthoringBridge.cpp `:228-300`                      |       73; file 1019 |
| Recovery file for pending native changes, cleanup/release                                           | Native authority                          | same `:476-513`                                                 |                  38 |
| World/PIE/expiry validity, pending edit sampling                                                    | Native authority                          | same `:515-565`                                                 |                  51 |
| Attach lease 30s, renew on request; revision/sequence fence, acknowledge installed state            | Native authority                          | same `:615-664,915-952`                                         |             50 + 38 |

C++ path is `unreal/Plugins/UEShedCameraAuthoringBridge/Source/UEShedCameraAuthoringBridge/Private/UEShedCameraAuthoringBridge.cpp`, separate from UEShedCameras rendering. Proxy actors/components RF_Transient|RF_Transactional (`:191,401-412`). Observe uses value comparison (`:253-263`), not a general transaction reverse stream. Camera Node store is currently document authority; this differs from revised native-resource editor authority. No generic optimistic mutation overlay was identified in these files: panel proposal/pending native edits are specific lifecycle states, not evidence the target client model already exists.

Localization staging: browser extension `extensions/game-text/src/game-text-translation-edits.tsx:72-78` owns Solid signal ReadonlyMap of staged edits; stage/unstage (`:84-105`) and write-result removal (`:145`) are client state. Main service `apps/workbench/src/main/services/game-text-localization.ts:85-120` retains evidence/caches/revision; `:569-624` accepts edit list, constructs change set, reviews or calls PO writer, reloads target after write. It does NOT own a durable pending-edit collection. `packages/game-text/src/localization-edits.ts:15-37,49-74,77-103` defines bounded edit/request/outcome schemas (500 edits, 64KiB translation), source from manifest, previousTranslation precondition; pure conversion only. Pending edits do not survive renderer restart or become shared CLI state through these files. Written PO changes do persist and are independently CLI-readable.

Evidence: [Line counts](evidence/T06-line-counts.csv), listed repository source at base `3d027eb84f6b282a5fb171ac21819957980cb8c8`. No live measurements in this task.

Confidence: high for lifecycle/storage/call boundaries; medium for exhaustive concurrency assessment (static read, no two-client run).

Surprises / risks found: Session shared open differs from safe cross-process writes; camera polling/reconciliation combines client plumbing and domain policy; staged translations currently remain UI memory; camera document authority differs from desired editor authority.

Open follow-ups: Preserve offline session mode while adding native authority adapter; use one relay/service owner for concurrent clients; move staging into public domain service if durable shared localization intent is desired; avoid migrating camera approval/recipe policy into generic sync.

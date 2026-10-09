# T02 — Remote Control push and transaction support
Question: Can stock RC push changes and make undoable writes, and what are its dispatch/lifecycle limits?
Why it matters for the sync layer: Determines transport reuse versus a new observation channel, and whether requests correspond to edit transactions.
Method: `python research/sync-probe/evidence.py query T02 VERSION Engine/Plugins/VirtualProduction/RemoteControl 'preset.register|PresetFieldsChanged|WRITE_TRANSACTION_ACCESS|WebSocketServerPort|GameThread|IsInGameThread|IsSaving|IsGarbageCollecting|GIsEditor|IsInPIE'`; `compare T02` for module, request, WebSocket handler/server and HTTP server; read indexed regions. References below use `R = Engine/Plugins/VirtualProduction/RemoteControl/Source/`. No editor/probe yet.
Results:

| Question | 5.7 | 5.8 |
| --- | --- | --- |
| Push exists | `preset.register` subscribes preset exposed fields, plus actor registration for create/delete/rename | Same; request header byte-identical |
| Event payload | PresetFieldsChanged: Type, PresetName, PresetId, SequenceNumber string, ChangedFields array; each field contains PropertyLabel, Id, ObjectPath, PropertyValue | Same schema |
| Timing/scope | Batches every 5 frames by default; exposed property and preset actor property hooks; not a general arbitrary DataTable row stream | Same; handler line offsets +9 after function-call validation addition |
| Ports | Stock HTTP 30010 (settings); WS 30020; configurable | Same defaults; WS settings line offset +3 |
| Property write access | READ_ACCESS, WRITE_ACCESS, WRITE_TRANSACTION_ACCESS, WRITE_MANUAL_TRANSACTION_ACCESS | Same |
| Undo transaction | WRITE_TRANSACTION_ACCESS starts GEditor transaction and Modify; default ongoing-change optimization groups same object/property writes and delays finalization | Same, +2 module line offsets |
| Nontransactional write | PreEditChange still called; PostEditChange emitted after ongoing-change finalization. Do not equate nontransactional with no notifications | Same |
| Interactive/final | Ongoing updates SnapshotTransactionBuffer + Interactive; idle/forced finalization ValueSet and EndTransaction | Same |
| Thread | HTTP tick drives listeners/router synchronously; WS tick drives server/received route; reflection utility checks IsInGameThread | Same architecture; actual runtime thread UNVERIFIED until T08 |
| Save / GC | Object/call resolution refuses during GIsSavingPackage / IsGarbageCollecting | Uses UE::IsSavingPackage / IsGarbageCollecting |
| PIE | Property access policies distinguish PKG_PlayInEditor and game/editor objects | Same |
| Map load | PreLoadMap forces finalization of ongoing RC change | Same |
| Modal dialog | UNVERIFIED: no modal-specific promise found in inspected RC route paths; ticker progress needs live test | UNVERIFIED |

Source: `R/WebRemoteControl/Private/WebSocketMessageHandler.cpp:28-31,71-107,188-200,301-307,320-373,477-520,1379-1390` (5.8 end-frame `:1388-1399`); exposed-field subscription and IgnoreRemoteChanges at `:444-472,505,515`; this origin-client filter is RC preset-specific, not UE Shed Apply provenance. Actor subscription `:340-349` covers lifecycle, not every actor property.

Transaction implementation: `R/RemoteControl/Private/RemoteControlModule.cpp:65` default optimization=1; `:1603-1653` StartPropertyTransaction; `:1658-1718` SnapshotOrEnd; `:1842-1850,1911` mutation notification flags; `:3088-3159` finalization; `:3169-3189` map and timer handling (5.8 +2). Request access inference in `R/WebRemoteControl/Private/RemoteControlRequest.h:150-170` uses GenerateTransaction only when Access is unspecified; explicit WRITE_ACCESS stays WRITE_ACCESS. HTTP route `WebRemoteControl.cpp:617`; function calls have separate GenerateTransaction default false (`RemoteControlRequest.h:123-126`). Use UE Shed Apply's internal transaction rather than an outer RC-generated transaction.

Dispatch: `Engine/Source/Runtime/Online/HTTPServer/Private/HttpServerModule.cpp:182-194` ticks listeners; `HttpRouter.cpp:14-29` executes route delegate. WS server `R/WebRemoteControl/Private/RemoteControlWebSocketServer.cpp:222-236` tick and raw-packet callback; reflection utility `RemoteControlReflectionUtils.cpp:66` game-thread assertion. These support game-thread expectation, not a guarantee all callers of RC C++ APIs are game-thread bound. Blocking/modal/loading runtime response behavior remains UNVERIFIED.

UE Shed today: `packages/unreal-connection/src/remote-control-client.ts:88-126` creates scoped HTTP UnrealRC client for each request, retry false, transaction false; `src/index.ts:332-392` maps transport and producer refusals; `packages/authoring/src/live.ts:12-16,67-123,144-213` exposes apply/lookup/save, builds bounded fingerprinted plans and accepts snapshots (no observe subscription). `scripts/workbench-tools.ts:88-106` enables RC and feature plugins, HTTP chosen port, WS=HTTP+1, autostart and permissions; fixture default 30001 means WS 30002, NOT stock WS 30020. No push interface was found in this connection wrapper.

Evidence: [Compared files](evidence/T02-source-comparison.txt); raw `out/sync-research/T02-{5.7,5.8}-source.txt`, `T02-*.diff`. Runtime evidence in T08/T11 if available.
Confidence: high for route/access/payload source; medium for dispatch inference; low for modal/PIE/map live availability.
Surprises / risks found: RC transaction grouping is timer-based by default, so one HTTP request need not be one finalized undo entry. Push cadence is frame-based and depends on editor progress. Preset subscription does not solve DataTable custom row storage. 5.8 adds function validation to WS calls.
Open follow-ups: Live thread/event timing; modal and PIE scenario; expose transient observed presets versus custom bridge; compare polling snapshot cost with push invalidation plus refresh.

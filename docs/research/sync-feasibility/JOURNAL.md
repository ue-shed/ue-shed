# Running journal (append-only)

- 2026-10-09T09:24:36.002404+07:00 Context: created authorized isolated worktree; read AGENTS.md, docs map, architecture/engineering/adoption and product introductions, revised design; discovered six engine roots. No assets saved, no processes started.

- 2026-10-09T09:26:57.093154+07:00 T01 complete: Concert source read for 5.7.4 and 5.8.3; public capture API, opaque serialization, end-frame snapshots, cancellation compensation and lifecycle hooks documented. rg Windows filename wildcard error corrected with -g. apply_patch replacement attempt rejected before mutation; wrote task via PowerShell. No editor yet. Next T02.

- 2026-10-09T09:28:56.522606+07:00 T02 complete: stock RC preset WS push, 5-frame batching, property transaction modes and timer grouping documented per engine. UE Shed HTTP adapter uses transaction=false; internal Apply owns undo. Modal and runtime dispatch remain unverified. Next T03.

- 2026-10-09T09:30:58.399518+07:00 T03 source complete: no DataTable row payload; modified hook coalesces per frame; cancel discards history without restoring; dirty fences track save. Transaction ID stable, operation ID changes for undo/redo. Guessed Transactor path failed and was corrected by file discovery. Next T04.

- 2026-10-09T09:31:54.250138+07:00 T04 complete: signature survey on 4.27, 5.3, 5.7, 5.8. 5.5/5.6 registry entries stale, roots do not exist; FileNotFoundError recorded and survey fixed to continue with UNVERIFIED rows. Next T05.

- 2026-10-09T09:32:21.664477+07:00 Housekeeping: Python import generated a pyc inadvertently staged in T04. Removed it, added probe-local __pycache__ ignore, and amended that research commit so no binary remains in branch history.

- 2026-10-09T09:33:46.710828+07:00 T05 complete source-only: in-memory translation display/resource update APIs present in both engines; persistence/compile separate. String Table native editor transaction observed in source, local refresh does not emit property event. Automatic checkout in private TranslationDataManager is unsuitable for UE Shed policy. Next T06.

- 2026-10-09T09:36:07.046277+07:00 T06 complete: source lifecycle map, five AuthoringCommand variants, shared-open versus unsafe cross-process updates, camera mechanism classification/LOC, UI-memory localization staging documented. Phase A complete; next throwaway probe build T07.

- 2026-10-09T09:43:25.867790+07:00 T07 prepared disposable 5.7 fixture: D:\git\ue-shed-sync-research\out\sync-research\5.7\fixture\UEShedFixture.uproject; source fixture untouched

- 2026-10-09T09:43:26.048068+07:00 T07 prepared disposable 5.8 fixture: D:\git\ue-shed-sync-research\out\sync-research\5.8\fixture\UEShedFixture.uproject; source fixture untouched

- 2026-10-09T09:43:26.118260+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513806.log

- 2026-10-09T09:44:26.484021+07:00 T07 build 5.7 exit=6; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513806.log

- 2026-10-09T09:44:35.300034+07:00 T07 first 5.7 compile failed: C1083 Settings/EditorPerformanceSettings.h missing. Located actual Editor/EditorPerformanceSettings.h and corrected throwaway probe. No product changes.

- 2026-10-09T09:44:35.358505+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513875.log

- 2026-10-09T09:44:41.484366+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513875.log

- 2026-10-09T09:44:50.457799+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791513890.log

- 2026-10-09T09:45:00.652113+07:00 T07 launched 5.7 UnrealEditor PID=29468; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-command.json

- 2026-10-09T09:45:55.890166+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791513890.log

- 2026-10-09T09:46:04.413834+07:00 Cleanup 5.7 PID=29468: SUCCESS: The process with PID 43708 (child process of PID 35128) has been terminated.
SUCCESS: The process with PID 35128 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 43568 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 33548 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 29844 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 41092 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 41700 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 20816 (child process of PID 29468) has been terminated.
SUCCESS: The process with PID 29468 (child process of PID 36692) has been terminated. 

- 2026-10-09T09:46:04.484050+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513964.log

- 2026-10-09T09:46:10.773760+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791513964.log

- 2026-10-09T09:46:15.336777+07:00 T07 launched 5.7 UnrealEditor PID=41876; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-command.json

- 2026-10-09T09:46:21.557905+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791513981.log

- 2026-10-09T09:46:36.174642+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791513981.log

- 2026-10-09T09:47:06.966993+07:00 T07 final probe builds succeeded on UE 5.7 and UE 5.8. 5.7 smoke reports 12 watched DataTables, game-thread RC call, empty undo queue, background throttle false. First smoke editor PID29468 and child tree closed; final 5.7 editor PID41876 now running.

- 2026-10-09T09:50:10.115672+07:00 matrix 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\matrix-summary.json; 19 records

- 2026-10-09T09:50:23.892269+07:00 Cleanup 5.7 PID=41876: SUCCESS: The process with PID 31224 (child process of PID 40604) has been terminated.
SUCCESS: The process with PID 40604 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 3576 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 24324 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 31008 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 33236 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 21616 (child process of PID 41876) has been terminated.
SUCCESS: The process with PID 41876 (child process of PID 20840) has been terminated. 

- 2026-10-09T09:50:23.972614+07:00 T07 launched 5.8 UnrealEditor PID=45744; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-command.json

- 2026-10-09T09:50:24.041625+07:00 T08 UE5.7 matrix ran all scripted rows. Saved only out/sync-research/5.7/fixture/Content/Fixture/Authoring/DT_Scalars.uasset; tracked fixtures remain untouched. Copy will be restored from tracked original after editor closure. UE5.8 launched for matching matrix.

- 2026-10-09T09:51:13.164723+07:00 matrix 5.8 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.8\matrix-summary.json; 19 records

- 2026-10-09T09:52:01.792255+07:00 T08 both engines complete: matching hook counts, Apply no DataTableChanged or PropertyChanged, transaction events expose coarse row-struct field names but no row IDs. Saved only disposable 5.7/5.8 DT_Scalars.uasset copies. Actual UI/modal/PIE and dirty reload remain NEEDS HUMAN. Task docs and CSV/sample evidence committed.

- 2026-10-09T09:52:42.788210+07:00 T09 completed using both T08 runs: stable transaction ID across undo/redo, new operation IDs; current Apply context empty and no request operationId in events. Collision-safe suppression remains unverified; scoped authority provenance is a proposed workaround, not a tested result.

- 2026-10-09T09:52:43.143008+07:00 Cleanup 5.8 PID=45744: SUCCESS: The process with PID 44696 (child process of PID 39368) has been terminated.
SUCCESS: The process with PID 39368 (child process of PID 45744) has been terminated.
SUCCESS: The process with PID 45744 (child process of PID 43456) has been terminated. 

- 2026-10-09T09:53:03.724942+07:00 Restored saved disposable asset D:\git\ue-shed-sync-research\out\sync-research\5.7\fixture\Content\Fixture\Authoring\DT_Scalars.uasset from unchanged tracked fixture; no tracked asset saves occurred

- 2026-10-09T09:53:03.780317+07:00 Restored saved disposable asset D:\git\ue-shed-sync-research\out\sync-research\5.8\fixture\Content\Fixture\Authoring\DT_Scalars.uasset from unchanged tracked fixture; no tracked asset saves occurred

- 2026-10-09T09:53:03.837050+07:00 T07 launched 5.7 UnrealEditor PID=35276; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-command.json

- 2026-10-09T09:53:30.798846+07:00 undo 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\undo-summary.json; 8 records

- 2026-10-09T09:54:02.253716+07:00 Native window 5.7 minimize: {'editorPid': 35276, 'editorWindows': [{'handle': 131073982, 'pid': 35276, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T09:54:02.568840+07:00 Cleanup 5.7 PID=35276: SUCCESS: The process with PID 12876 (child process of PID 22160) has been terminated.
SUCCESS: The process with PID 22160 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 30664 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 31680 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 30760 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 44124 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 42360 (child process of PID 35276) has been terminated.
SUCCESS: The process with PID 35276 (child process of PID 3768) has been terminated. 

- 2026-10-09T09:54:02.633819+07:00 Restored saved disposable asset D:\git\ue-shed-sync-research\out\sync-research\5.7\fixture\Content\Fixture\Authoring\DT_Scalars.uasset from unchanged tracked fixture; no tracked asset saves occurred

- 2026-10-09T09:54:02.698129+07:00 T07 launched 5.8 UnrealEditor PID=40340; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-command.json

- 2026-10-09T09:54:31.420451+07:00 Native window 5.8 minimize: {'editorPid': 40340, 'editorWindows': [{'handle': 6621280, 'pid': 40340, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T09:54:32.610229+07:00 undo 5.8 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.8\undo-summary.json; 8 records

- 2026-10-09T09:54:55.741615+07:00 Cleanup 5.8 PID=40340: SUCCESS: The process with PID 38828 (child process of PID 41268) has been terminated.
SUCCESS: The process with PID 41268 (child process of PID 40340) has been terminated.
SUCCESS: The process with PID 40340 (child process of PID 34972) has been terminated. 

- 2026-10-09T09:54:55.817229+07:00 Restored saved disposable asset D:\git\ue-shed-sync-research\out\sync-research\5.8\fixture\Content\Fixture\Authoring\DT_Scalars.uasset from unchanged tracked fixture; no tracked asset saves occurred

- 2026-10-09T09:54:55.893438+07:00 T07 launched 5.7 UnrealEditor PID=32716; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-command.json

- 2026-10-09T09:54:55.981759+07:00 T10 both engines: five-table Apply creates queueLength1; one Undo restores all five fingerprints and clears initial dirty flags; after Save the same Undo leaves saved scalar package dirty. Cancel leaves Count55 with no new undo entry. Initial 5.7 unfocused Undo returned false because no undo entry remained; Redo true. 5.8 minimized Undo/Redo true. Will establish 5.7 minimized Undo with a fresh entry.

- 2026-10-09T09:55:45.619929+07:00 Native window 5.7 minimize: {'editorPid': 32716, 'editorWindows': [{'handle': 52300870, 'pid': 32716, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T09:55:45.959834+07:00 T10 fresh UE5.7 minimized Apply committed, Undo true, Redo true; both engines verified focus-independent Undo. Completed compact proof and task report.

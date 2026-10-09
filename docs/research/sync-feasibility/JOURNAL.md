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

- 2026-10-09T09:56:06.091630+07:00 T10 report generation wrote artifacts successfully but console printing hit cp1252 UnicodeEncodeError on an arrow. Corrected console output to JSON; artifact contents unaffected.

- 2026-10-09T09:56:06.181758+07:00 Native window 5.7 focus: {'editorPid': 32716, 'editorWindows': [{'handle': 52300870, 'pid': 32716, 'title': 'UEShedFixture - Unreal Editor', 'minimized': False, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T09:58:20.625763+07:00 T11 focus request failed native foreground verification (foreground remains Search). Focused performance UNVERIFIED; attempted-focused run is actual unfocused visible. Large response logging revised to hash/byte summary for later runs to avoid retaining repeated entire tables; first run raw RPC log retains full payloads. Instrumentation/log overhead excluded only after urllib read timing stops, engine logging remains enabled.

- 2026-10-09T09:58:27.177503+07:00 perf 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\perf-summary.json; 1 records

- 2026-10-09T09:58:35.284118+07:00 Native window 5.7 minimize: {'editorPid': 32716, 'editorWindows': [{'handle': 52300870, 'pid': 32716, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T10:00:08.810825+07:00 T01 extended using T08 payload: DataTable native row fields named but HasNonPropertyChanges=false. Concert resolves names on UObject class (both util.cpp492-519); potential omitted capture inferred, not tested Multi-User behavior. Distinguish prior-art patterns from reusable DataTable serializer.

- 2026-10-09T10:00:49.979003+07:00 perf 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\perf-summary.json; 1 records

- 2026-10-09T10:03:32.856095+07:00 perf 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\perf-summary.json; 1 records

- 2026-10-09T10:04:59.124012+07:00 Cleanup 5.7 PID=32716: SUCCESS: The process with PID 24384 (child process of PID 24524) has been terminated.
SUCCESS: The process with PID 24524 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 14900 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 35400 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 42660 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 26592 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 43732 (child process of PID 32716) has been terminated.
SUCCESS: The process with PID 32716 (child process of PID 35392) has been terminated. 

- 2026-10-09T10:04:59.189251+07:00 T07 launched 5.8 UnrealEditor PID=43452; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-command.json

- 2026-10-09T10:04:59.248769+07:00 T11 UE5.7 three modes complete. Actual focused state unavailable (native activation failed). Source throttle conditions additionally reviewed; no ShaderCompileWorker process present during enabled-setting run. Next UE5.8 performance.

- 2026-10-09T10:05:25.374889+07:00 Native window 5.8 focus: {'editorPid': 43452, 'editorWindows': [{'handle': 10027398, 'pid': 43452, 'title': 'UEShedFixture - Unreal Editor', 'minimized': False, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T10:06:15.596924+07:00 Prepared T12 throwaway probe extension to inspect cached Slate DataTable cell text and report actual engine focus/throttle policy. Source APIs checked on both engines. Not rebuilt into running T11 editor; no performance code or authority mutations changed during measurements.

- 2026-10-09T10:07:39.014989+07:00 perf 5.8 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.8\perf-summary.json; 1 records

- 2026-10-09T10:09:47.217074+07:00 Cleanup 5.8 PID=43452: SUCCESS: The process with PID 23828 (child process of PID 44696) has been terminated.
SUCCESS: The process with PID 44696 (child process of PID 43452) has been terminated.
SUCCESS: The process with PID 43452 (child process of PID 17928) has been terminated. 

- 2026-10-09T10:09:47.294532+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791515387.log

- 2026-10-09T10:09:57.295211+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791515387.log

- 2026-10-09T10:10:59.873487+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791515459.log

- 2026-10-09T10:11:12.324463+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791515459.log

- 2026-10-09T10:12:51.834919+07:00 T11 source cause verified both engines: EditorEngine.cpp5.7:5014-5023 /5.8:5305-5314 returns false when FApp::IsUnattended. All existing performance runs passed -unattended. Short normal-editor policy runs added. Probe extension builds succeeded; deprecated reload bool changed to exact equivalent AssumeNegative, plus explicit disposable dirty-revert AssumePositive for supplemental coverage. Previous T11 editor logs archived; subsequent launches use unique log/command files.

- 2026-10-09T10:12:51.895867+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791515571.log

- 2026-10-09T10:12:58.183697+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791515571.log

- 2026-10-09T10:12:58.254928+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791515578.log

- 2026-10-09T10:13:05.408833+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791515578.log

- 2026-10-09T10:13:29.073944+07:00 T07 launched 5.7 UnrealEditor PID=38332; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-1791515609.json

- 2026-10-09T10:14:50.355852+07:00 T11 non-unattended 5.7 policy visible-off: {'noop': {'n': 40, 'p50': 15.862200001720339, 'p95': 26.45870001288131, 'max': 33.53469999274239}, 'one': {'n': 40, 'p50': 11.593999981414527, 'p95': 34.44890002720058, 'max': 36.466200021095574}}; effective=False; raw=D:\git\ue-shed-sync-research\out\sync-research\5.7\policy-visible-off.json

- 2026-10-09T10:15:18.174899+07:00 T11 non-unattended 5.7 policy visible-on: {'noop': {'n': 40, 'p50': 330.68110002204776, 'p95': 331.3739000004716, 'max': 332.6602999586612}, 'one': {'n': 40, 'p50': 335.199500026647, 'p95': 336.2201999989338, 'max': 336.36079996358603}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.7\policy-visible-on.json

- 2026-10-09T10:15:18.297755+07:00 Native window 5.7 minimize: {'editorPid': 38332, 'editorWindows': [{'handle': 1114254, 'pid': 38332, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T10:15:46.508112+07:00 T11 non-unattended 5.7 policy minimized-off: {'noop': {'n': 40, 'p50': 330.5687000392936, 'p95': 331.4503000001423, 'max': 332.16340001672506}, 'one': {'n': 40, 'p50': 335.2533000288531, 'p95': 335.7199000311084, 'max': 337.43800001684576}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.7\policy-minimized-off.json

- 2026-10-09T10:16:14.839811+07:00 T11 non-unattended 5.7 policy minimized-on: {'noop': {'n': 40, 'p50': 330.65380004700273, 'p95': 331.0742999892682, 'max': 332.50399999087676}, 'one': {'n': 40, 'p50': 335.26440005516633, 'p95': 335.81260003848, 'max': 338.7555000372231}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.7\policy-minimized-on.json

- 2026-10-09T10:16:47.488375+07:00 Cleanup 5.7 PID=38332: SUCCESS: The process with PID 34368 (child process of PID 38956) has been terminated.
SUCCESS: The process with PID 38956 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 28520 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 10016 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 7716 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 29036 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 31072 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 30964 (child process of PID 38332) has been terminated.
SUCCESS: The process with PID 38332 (child process of PID 32764) has been terminated. 

- 2026-10-09T10:16:47.559584+07:00 T07 launched 5.8 UnrealEditor PID=33320; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-1791515807.json

- 2026-10-09T10:16:47.625272+07:00 T11 normal UE5.7 confirmed source policy: visible/off Apply p95 34.45ms; visible/on 336.22ms; minimized/off 335.72ms, effectiveShouldThrottle true despite checkbox false. -unattended bypass and all-windows-minimized branch are material feasibility findings. Repeating normal modes on 5.8.

- 2026-10-09T10:18:01.300244+07:00 T11 non-unattended 5.8 policy visible-off: {'noop': {'n': 40, 'p50': 8.40499997138977, 'p95': 32.2112999856472, 'max': 34.66220002155751}, 'one': {'n': 40, 'p50': 10.903600021265447, 'p95': 28.55050005018711, 'max': 30.591499991714954}}; effective=False; raw=D:\git\ue-shed-sync-research\out\sync-research\5.8\policy-visible-off.json

- 2026-10-09T10:18:29.126321+07:00 T11 non-unattended 5.8 policy visible-on: {'noop': {'n': 40, 'p50': 330.5444000288844, 'p95': 331.656499998644, 'max': 335.40000003995374}, 'one': {'n': 40, 'p50': 335.45829996000975, 'p95': 340.50599997863173, 'max': 344.0337000065483}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.8\policy-visible-on.json

- 2026-10-09T10:18:29.255441+07:00 Native window 5.8 minimize: {'editorPid': 33320, 'editorWindows': [{'handle': 2754692, 'pid': 33320, 'title': 'UEShedFixture - Unreal Editor', 'minimized': True, 'visible': True}], 'foreground': {'handle': 131698, 'pid': 18488, 'title': 'Search', 'minimized': False, 'visible': True}, 'editorForeground': False}

- 2026-10-09T10:18:57.456820+07:00 T11 non-unattended 5.8 policy minimized-off: {'noop': {'n': 40, 'p50': 330.6686999858357, 'p95': 331.337200012058, 'max': 332.0155999972485}, 'one': {'n': 40, 'p50': 335.2771000354551, 'p95': 336.407299968414, 'max': 337.40179997403175}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.8\policy-minimized-off.json

- 2026-10-09T10:19:25.789400+07:00 T11 non-unattended 5.8 policy minimized-on: {'noop': {'n': 40, 'p50': 330.40139998774976, 'p95': 331.008400011342, 'max': 332.67189998878166}, 'one': {'n': 40, 'p50': 335.37330001126975, 'p95': 335.9307000064291, 'max': 336.94670000113547}}; effective=True; raw=D:\git\ue-shed-sync-research\out\sync-research\5.8\policy-minimized-on.json

- 2026-10-09T10:20:08.784102+07:00 T11 complete both engines. Normal visible/off one-cell p95 34.45/28.55ms; normal visible/on 336.22/340.51ms; minimized/off 335.72/336.41ms. 10k-row unattended large Apply p95 2049.10/2101.83ms. Actual focused performance unavailable; full profiling/peak allocations unverified. Added normal effective-policy evidence and clarified untested modes. T08 zero-event thread cells corrected to no thread rather than vacuous all(true).

- 2026-10-09T10:20:09.186632+07:00 Cleanup 5.8 PID=33320: SUCCESS: The process with PID 40372 (child process of PID 43324) has been terminated.
SUCCESS: The process with PID 43324 (child process of PID 33320) has been terminated.
SUCCESS: The process with PID 32636 (child process of PID 33320) has been terminated.
SUCCESS: The process with PID 33320 (child process of PID 3848) has been terminated. 

- 2026-10-09T10:21:28.633574+07:00 T12 supplementary String Table/FText observation probes added after checking both engines public headers. Initial guessed Engine/Classes/Engine/StringTable.h path absent; found actual Engine/Public/Internationalization/StringTable.h. Core SetSourceString raw writes and editor-style scoped Modify wrapper will be distinguished. Builds required before running.

- 2026-10-09T10:21:28.692992+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516088.log

- 2026-10-09T10:21:35.189841+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516088.log

- 2026-10-09T10:21:35.257802+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516095.log

- 2026-10-09T10:21:37.975227+07:00 T07 build 5.8 exit=6; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516095.log

- 2026-10-09T10:21:46.057064+07:00 T07 launched 5.7 UnrealEditor PID=28976; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-1791516106.json

- 2026-10-09T10:22:14.153607+07:00 T12 supplemental 5.8 compile failed C2660 FStringTable::SetSourceString does not take 2 arguments (build-1791516095.log). Header145-149 is conditional WITH_EDITORONLY_DATA, not simultaneous overloads. Corrected earlier T05 source table and added version-aware editor dev-notes argument. Running already-built5.7 T12 now; corrected code will be rebuilt on both after its editor closes.

- 2026-10-09T10:22:21.107364+07:00 concurrent 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\concurrent-summary.json; 19 records

- 2026-10-09T10:24:07.948230+07:00 T12 UE5.7 initial run: editorFound true, Apply commits, stale fingerprint rejected, dirty revert restores baseline, String Table wrapper undo/redo confirmed. Initial Slate filter returned no cells at all; that run does NOT prove refresh or stale UI. Broadened text read to all visible windows (including child editor windows) and all text blocks; one correction, then matching engine runs. Original initial raw RPC/events retained before rerun.

- 2026-10-09T10:24:08.226850+07:00 Cleanup 5.7 PID=28976: SUCCESS: The process with PID 41768 (child process of PID 30956) has been terminated.
SUCCESS: The process with PID 30956 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 43252 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 29464 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 24380 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 38904 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 31996 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 8508 (child process of PID 28976) has been terminated.
SUCCESS: The process with PID 28976 (child process of PID 45372) has been terminated. 

- 2026-10-09T10:24:08.298845+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516248.log

- 2026-10-09T10:24:15.189802+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516248.log

- 2026-10-09T10:24:15.258567+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516255.log

- 2026-10-09T10:24:23.277834+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516255.log

- 2026-10-09T10:24:23.349114+07:00 T07 launched 5.7 UnrealEditor PID=37660; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-1791516263.json

- 2026-10-09T10:26:17.881662+07:00 concurrent 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\concurrent-summary.json; 19 records

- 2026-10-09T10:26:30.389546+07:00 Cleanup 5.7 PID=37660: SUCCESS: The process with PID 39300 (child process of PID 15600) has been terminated.
SUCCESS: The process with PID 15600 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 25420 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 15956 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 21668 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 38940 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 41508 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 41152 (child process of PID 37660) has been terminated.
SUCCESS: The process with PID 37660 (child process of PID 43940) has been terminated. 

- 2026-10-09T10:26:30.462484+07:00 T07 launched 5.8 UnrealEditor PID=39416; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-1791516390.json

- 2026-10-09T10:26:30.523870+07:00 T12 final corrected5.7 run retains complete Slate text bindings (initial empty-filter attempt preserved separately). Stale fingerprint rejected, dirty revert baseline restored, tagged-context undo/redo, String Table/FText cases all succeed. Both corrected probe builds now pass. Final5.8 matching run next.

- 2026-10-09T10:28:01.356102+07:00 T12 cached row cell proven stale on5.7: UI Count7 before, remains7 after Apply confirmation Count8, then becomes33 after editor-style row change. Added isolated public FDataTableEditorUtils pre/post notification (no mutation) to see whether it refreshes UI to8. This is throwaway probe behavior only. One additional controlled case, then move to baseline gates.

- 2026-10-09T10:28:01.628669+07:00 Cleanup 5.8 PID=39416: SUCCESS: The process with PID 35548 (child process of PID 35820) has been terminated.
SUCCESS: The process with PID 35820 (child process of PID 39416) has been terminated.
SUCCESS: The process with PID 22112 (child process of PID 39416) has been terminated.
SUCCESS: The process with PID 39416 (child process of PID 43572) has been terminated. 

- 2026-10-09T10:28:01.700078+07:00 T07 build 5.7: ['D:\\ue5\\UE_5.7\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.7\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516481.log

- 2026-10-09T10:28:08.578371+07:00 T07 build 5.7 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.7\build-1791516481.log

- 2026-10-09T10:28:08.645509+07:00 T07 build 5.8: ['D:\\ue5\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat', 'UEShedFixtureEditor', 'Win64', 'Development', 'D:\\git\\ue-shed-sync-research\\out\\sync-research\\5.8\\fixture\\UEShedFixture.uproject', '-NoUBTMakefiles', '-WaitMutex', '-NoHotReloadFromIDE']; raw log D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516488.log

- 2026-10-09T10:28:16.414408+07:00 T07 build 5.8 exit=0; log=D:\git\ue-shed-sync-research\out\sync-research\5.8\build-1791516488.log

- 2026-10-09T10:28:16.481821+07:00 T07 launched 5.7 UnrealEditor PID=4812; command=D:\git\ue-shed-sync-research\out\sync-research\5.7\launch-1791516496.json

- 2026-10-09T10:29:21.388413+07:00 concurrent 5.7 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.7\concurrent-summary.json; 21 records

- 2026-10-09T10:29:21.742624+07:00 Cleanup 5.7 PID=4812: SUCCESS: The process with PID 43640 (child process of PID 33404) has been terminated.
SUCCESS: The process with PID 33404 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 3232 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 33616 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 2788 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 24808 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 34000 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 35688 (child process of PID 4812) has been terminated.
SUCCESS: The process with PID 4812 (child process of PID 42036) has been terminated. 

- 2026-10-09T10:29:21.818677+07:00 T07 launched 5.8 UnrealEditor PID=21020; command=D:\git\ue-shed-sync-research\out\sync-research\5.8\launch-1791516561.json

- 2026-10-09T10:31:11.201847+07:00 concurrent 5.8 finished; raw D:\git\ue-shed-sync-research\out\sync-research\5.8\concurrent-summary.json; 21 records

- 2026-10-09T10:31:11.493081+07:00 Cleanup 5.8 PID=21020: SUCCESS: The process with PID 19364 (child process of PID 2320) has been terminated.
SUCCESS: The process with PID 2320 (child process of PID 21020) has been terminated.
SUCCESS: The process with PID 24208 (child process of PID 21020) has been terminated.
SUCCESS: The process with PID 21020 (child process of PID 37932) has been terminated. 

- 2026-10-09T10:31:11.555900+07:00 T12 both final runs: UI cached Count7 after memory Apply8, public notification-only refresh to8, editor-style write UI33; stale fingerprint rejected. Dirty revert baseline restored, tagged context survives undo/redo, Text property observed, String Table Modify wrapper undoable but raw setter invisible. Both final probes built. No assets saved in T12.

"""Isolated research fixtures. Engine roots come from evidence.py's manifest/env.

python research/sync-probe/fixture.py prepare|build|launch|stop VERSION
Build/launch logs are uncommitted under out/sync-research/VERSION.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from evidence import ROOT, OUT, engine, journal

action, version = sys.argv[1:3]
base = OUT / version
fixture = base / "fixture"
project = fixture / "UEShedFixture.uproject"
base.mkdir(parents=True, exist_ok=True)
ignored = shutil.ignore_patterns("Binaries", "Intermediate", "Saved", "DerivedDataCache", ".vs")

if action == "prepare":
    if fixture.exists():
        raise SystemExit("Fixture exists; refusing to overwrite possible live evidence")
    shutil.copytree(ROOT / "fixtures/unreal-project", fixture, ignore=ignored)
    for name in ["UEShedCore", "UEShedAuthoring", "UEShedSyncProbe"]:
        source = ROOT / "unreal/Plugins" / name if name != "UEShedSyncProbe" else Path(__file__).parent / name
        shutil.copytree(source, fixture / "Plugins" / name, ignore=ignored)
    data = json.loads(project.read_text(encoding="utf-8-sig"))
    data["EngineAssociation"] = version
    data["Plugins"].extend({"Name": name, "Enabled": True} for name in ["UEShedCore", "UEShedAuthoring", "UEShedSyncProbe"])
    project.write_text(json.dumps(data, indent=2), encoding="utf-8")
    journal(f"T07 prepared disposable {version} fixture: {project}; source fixture untouched")
elif action == "build":
    # Refresh only throwaway probe source after a compiler correction.
    shutil.copytree(Path(__file__).parent / "UEShedSyncProbe", fixture / "Plugins/UEShedSyncProbe", dirs_exist_ok=True, ignore=ignored)
    command = [str(engine(version) / "Engine/Build/BatchFiles/Build.bat"), "UEShedFixtureEditor", "Win64", "Development", str(project), "-NoUBTMakefiles", "-WaitMutex", "-NoHotReloadFromIDE"]
    log = base / f"build-{int(time.time())}.log"
    journal(f"T07 build {version}: {command!r}; raw log {log}")
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    journal(f"T07 build {version} exit={result.returncode}; log={log}")
    print(f"exit={result.returncode} log={log}")
    raise SystemExit(result.returncode)
elif action == "launch":
    stamp = int(time.time())
    editor_log = base / f"editor-{stamp}.log"
    command = [str(engine(version) / "Engine/Binaries/Win64/UnrealEditor.exe"), str(project), "/Game/Fixture/Cameras/L_CameraLoad", "-unattended", "-nop4", "-nosplash", "-NoLiveCoding", "-RCWebControlEnable", "-RCWebInterfaceEnable", "-RemoteControlIsHeadless", "-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=30001", "-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlWebSocketServerPort=30002", "-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:bAutoStartWebServer=True", "-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False", f"-abslog={base / 'editor.log'}"]
    command[-1] = f"-abslog={editor_log}"
    if os.environ.get("UE_SHED_RESEARCH_EDITOR_UNATTENDED", "1") == "0": command.remove("-unattended")
    for remote_class in ["UEShedAuthoring.UEShedAuthoringLibrary", "UEShedSyncProbe.UEShedSyncProbeLibrary"]:
        command.append(f"-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:+CustomAllowedRemoteFunctionCalls=(ClassPath=/Script/{remote_class},bAllowChildClasses=False)")
    log = (base / f"launch-{stamp}.json")
    log.write_text(json.dumps(command, indent=2), encoding="utf-8")
    process = subprocess.Popen(command, creationflags=subprocess.CREATE_NO_WINDOW)
    (base / "editor.pid").write_text(str(process.pid))
    (base / "current-launch.json").write_text(json.dumps({"pid": process.pid, "log": str(editor_log), "command": str(log)}), encoding="utf-8")
    journal(f"T07 launched {version} UnrealEditor PID={process.pid}; command={log}")
    print(f"PID={process.pid}")
elif action == "stop":
    pid = int((base / "editor.pid").read_text())
    # Only the exact process started by this script (and its child process tree).
    result = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, text=True)
    metadata = base / "current-launch.json"
    if metadata.exists():
        source = Path(json.loads(metadata.read_text())["log"])
        if source.exists(): shutil.copy2(source, base / "editor.log")
    journal(f"Cleanup {version} PID={pid}: {result.stdout.strip()} {result.stderr.strip()}")
    print(result.stdout, result.stderr)
elif action == "restore-assets":
    relative = Path("Content/Fixture/Authoring/DT_Scalars.uasset")
    shutil.copy2(ROOT / "fixtures/unreal-project" / relative, fixture / relative)
    journal(f"Restored saved disposable asset {fixture / relative} from unchanged tracked fixture; no tracked asset saves occurred")
    print(f"restored {fixture / relative}")
else:
    raise SystemExit("unknown action")

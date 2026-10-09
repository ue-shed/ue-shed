"""Run requested baseline commands, retain output and observe owned Unreal PIDs.

python gates.py authoring VERSION | localization
No product edits. Existing gates may regenerate tracked fixtures; restore them later.
"""
import ctypes
from ctypes import wintypes
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from evidence import ROOT, OUT, engine, journal

class Entry(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("pid", wintypes.DWORD), ("heap", ctypes.c_size_t), ("module", wintypes.DWORD), ("threads", wintypes.DWORD), ("parent", wintypes.DWORD), ("priority", wintypes.LONG), ("flags", wintypes.DWORD), ("exe", wintypes.WCHAR * 260)]
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]

def creation_ticks(pid):
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle: return None
    created, exited, system, user = [wintypes.FILETIME() for _ in range(4)]
    valid = kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user))
    kernel.CloseHandle(handle)
    return (created.dwHighDateTime << 32) | created.dwLowDateTime if valid else None

def processes():
    handle = kernel.CreateToolhelp32Snapshot(2, 0)
    entry = Entry(); entry.dwSize = ctypes.sizeof(Entry)
    items = {}
    more = kernel.Process32FirstW(handle, ctypes.byref(entry))
    while more:
        items[entry.pid] = {"pid": entry.pid, "parent": entry.parent, "exe": entry.exe, "creationTicks": creation_ticks(entry.pid)}
        more = kernel.Process32NextW(handle, ctypes.byref(entry))
    kernel.CloseHandle(handle)
    return items

mode = sys.argv[1]
env = dict(os.environ)
node = env.get("UE_SHED_RESEARCH_NODE_EXECUTABLE")
if node: env["PATH"] = str(Path(node).parent) + os.pathsep + env["PATH"]
pnpm = shutil.which("pnpm")
if not pnpm: raise SystemExit("pnpm executable is unavailable on PATH")
temporary = OUT / "temp"
temporary.mkdir(parents=True, exist_ok=True)
for variable in ["TEMP", "TMP", "TMPDIR"]: env[variable] = str(temporary)
if mode == "authoring":
    version = sys.argv[2]
    env["UE_SHED_UNREAL_ENGINE_ROOT"] = str(engine(version))
    command = [pnpm, "test:unreal-authoring"]
    label = "authoring-" + version
elif mode == "prerequisites":
    command = [pnpm, "run", "build:typescript-packages"]
    label = "prerequisites"
elif mode == "localization":
    for version, variable in [("5.7", "UE_SHED_UNREAL_57_ROOT"), ("5.8", "UE_SHED_UNREAL_58_ROOT"), ("4.27", "UE_SHED_UNREAL_427_ROOT")]: env[variable] = str(engine(version))
    command = [pnpm, "test:localization-processes"]
    label = "localization"
else: raise SystemExit("unknown mode")
log = OUT / f"T13-{label}.log"
started = time.time()
observed = {}
with log.open("w", encoding="utf-8") as output:
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
    owned = {process.pid: creation_ticks(process.pid)}
    journal(f"T13 {label} started root PID={process.pid}; command={command}; log={log}; configured engines from manifest")
    timeout = False
    while process.poll() is None:
        current = processes()
        # Remove expired identities before following ancestry; Windows can reuse PIDs.
        owned = {pid: born for pid, born in owned.items() if pid in current and born is not None and current[pid]["creationTicks"] == born}
        for _ in range(8):
            for pid, item in current.items():
                if item["parent"] in owned and item["creationTicks"] is not None and item["creationTicks"] >= owned[item["parent"]]: owned[pid] = item["creationTicks"]
        for pid in owned:
            item = current.get(pid)
            if item and pid not in observed and ("unreal" in item["exe"].lower() or item["exe"].lower() in ["ue4editor-cmd.exe", "shadercompileworker.exe", "crashreportclient.exe"]):
                observed[pid] = {**item, "seen": time.time()}
                journal(f"T13 {label} owned engine/tool process observed {observed[pid]}")
        if time.time() - started > 1800:
            timeout = True
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], stdout=output, stderr=subprocess.STDOUT)
            break
        time.sleep(0.25)
    code = process.wait()
result = {"label": label, "command": command, "exit": code, "timedOut": timeout, "elapsedSeconds": time.time() - started, "log": str(log), "observed": list(observed.values()), "remainingOwned": [item for pid,item in processes().items() if pid in owned and item["creationTicks"] == owned[pid]]}
(OUT / f"T13-{label}-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
journal(f"T13 {label} finished exit={code}, seconds={result['elapsedSeconds']:.2f}, timedOut={timeout}, remainingOwned={result['remainingOwned']}")
print(json.dumps(result, indent=2))
raise SystemExit(code)

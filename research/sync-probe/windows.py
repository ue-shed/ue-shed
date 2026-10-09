"""Native editor window state evidence; no browser automation."""
import ctypes
from ctypes import wintypes
import json
import sys
from evidence import OUT, journal

user = ctypes.WinDLL("user32", use_last_error=True)
user.GetForegroundWindow.restype = wintypes.HWND
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user.SetForegroundWindow.argtypes = [wintypes.HWND]
user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.IsIconic.argtypes = [wintypes.HWND]
user.IsWindowVisible.argtypes = [wintypes.HWND]
CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user.EnumWindows.argtypes = [CALLBACK, wintypes.LPARAM]

def description(handle):
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    title = ctypes.create_unicode_buffer(2048)
    user.GetWindowTextW(handle, title, len(title))
    return {"handle": int(handle or 0), "pid": pid.value, "title": title.value, "minimized": bool(user.IsIconic(handle)), "visible": bool(user.IsWindowVisible(handle))}

def state(version):
    pid = int((OUT / version / "editor.pid").read_text())
    windows = []
    @CALLBACK
    def collect(handle, unused):
        item = description(handle)
        if item["pid"] == pid and item["visible"] and item["title"]: windows.append(item)
        return True
    user.EnumWindows(collect, 0)
    foreground = description(user.GetForegroundWindow())
    return {"editorPid": pid, "editorWindows": windows, "foreground": foreground, "editorForeground": foreground["pid"] == pid}

if __name__ == "__main__":
    version, action = sys.argv[1:3]
    before = state(version)
    if action != "state":
        window = next((item for item in before["editorWindows"] if "Unreal Editor" in item["title"]), before["editorWindows"][0])
        if action == "minimize": user.ShowWindow(window["handle"], 6)
        elif action == "focus":
            user.ShowWindow(window["handle"], 9)
            user.SetForegroundWindow(window["handle"])
        else: raise SystemExit("unknown action")
    result = {"action": action, "before": before, "after": state(version)}
    with (OUT / version / "window-state.jsonl").open("a", encoding="utf-8") as handle: handle.write(json.dumps(result) + "\n")
    journal(f"Native window {version} {action}: {result['after']}")
    print(json.dumps(result, indent=2))

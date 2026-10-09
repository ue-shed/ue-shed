"""T15: foreground PID + expiring lease throttle override, research fixture only.

Uses the existing foreground process as a clearly labeled UE Shed stand-in.
No Workbench integration, focus stealing, asset Save or engine setting persistence.
"""
import json
import math
import os
import sys
import time
import uuid
from evidence import OUT, DOCS, journal
from rc import Client, PROBE, AUTHORING
from windows import state, user

version = sys.argv[1]
client = Client(version, "T15")
client.probe("Mark", Label="T15:focus-conditional-throttle")
client.scenario("throttle", value=True)
foreground_pid = state(version)["foreground"]["pid"]
if not foreground_pid or foreground_pid == os.getpid(): raise SystemExit("No distinct foreground process available for controlled match/mismatch")
path = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"
snapshot = client.snapshot(path)
result = {"engine": version, "standInForegroundProcess": state(version)["foreground"], "clientPID": os.getpid(), "cases": []}

def counts(): return client.probe("GetCounts")
def lease(pid, ttl=10): return client.scenario("focus-lease", pid=pid, ttl=ttl)
def quantiles(values):
    values = sorted(values)
    return {"n": len(values), "p50": values[math.ceil(len(values)*.50)-1], "p95": values[math.ceil(len(values)*.95)-1], "max": values[-1]}

def sample(label, pid, n=40):
    global snapshot
    client.probe("Mark", Label="T15:" + label)
    lease_result = lease(pid)
    before = counts()
    if before["unattended"] or before["nativeForeground"] or before["appHasFocus"]: raise RuntimeError("Requires normal unfocused Unreal editor")
    expected_active = pid == foreground_pid
    assert before["focusLeaseDisablesThrottle"] == expected_active
    assert before["effectiveShouldThrottle"] != expected_active
    timings = {"noop": [], "one": []}
    checkpoints = []
    for index in range(n):
        if index % 10 == 0 and pid:
            lease(pid)
            observed = counts()
            assert observed["focusLeaseDisablesThrottle"] == expected_active
            checkpoints.append(observed)
        _, ms = client.call(PROBE, "Scenario", RequestJson='{"action":"noop"}')
        timings["noop"].append(ms)
        row = snapshot["table"]["rows"][0]
        field = row["fields"][0]
        request = {"contract": {"name": "unreal-authoring-apply", "version": {"major": 1, "minor": 2}}, "operationId": str(uuid.uuid4()), "tables": [{"objectPath": path, "expectedFingerprint": snapshot["fingerprint"]["value"]}], "commands": [{"id": str(uuid.uuid4()), "tableObjectPath": path, "body": {"kind": "set_cell", "rowId": row["id"], "fieldName": field["name"], "oldValue": field["value"], "newValue": {"kind": "bool", "value": not field["value"]["value"]}}}]}
        applied, ms = client.call(AUTHORING, "Apply", RequestJson=json.dumps(request))
        assert applied["status"] == "committed", applied
        snapshot = applied["snapshots"][0]
        timings["one"].append(ms)
        if index % 10 == 9: print(f"{version} {label}: {index+1}/{n}", flush=True)
    after = counts()
    assert after["focusLeaseDisablesThrottle"] == expected_active
    item = {"label": label, "leaseResult": lease_result, "before": before, "after": after, "native": state(version), "checkpoints": checkpoints, "stats": {name: quantiles(values) for name,values in timings.items()}, "samples": timings}
    result["cases"].append(item)
    print(json.dumps({"label": label, "stats": item["stats"]}), flush=True)

try:
    # A real OS foreground-owner match, but not a UE Shed window.
    sample("visible-match", foreground_pid)
    for window in state(version)["editorWindows"]: user.ShowWindow(window["handle"], 6)
    assert all(window["minimized"] for window in state(version)["editorWindows"])
    sample("minimized-no-lease", 0)
    sample("minimized-match", foreground_pid)
    lease(os.getpid())
    mismatch = counts()
    assert mismatch["focusProcessHandleValid"] and not mismatch["focusLeaseDisablesThrottle"] and mismatch["effectiveShouldThrottle"]
    result["mismatchedForeground"] = mismatch
    lease(foreground_pid, ttl=0.75)
    live = counts()
    assert live["focusLeaseDisablesThrottle"] and not live["effectiveShouldThrottle"]
    time.sleep(1.1)
    expired = counts()
    assert not expired["focusLeaseDisablesThrottle"] and expired["effectiveShouldThrottle"]
    result["expiry"] = {"live": live, "after": expired}
    sample("minimized-release", 0)
    # Remove only our delegate. Other engine/plugin overrides must remain intact.
    client.scenario("focus-override-remove")
    removed = counts()
    assert not removed["focusOverrideRegistered"] and removed["effectiveShouldThrottle"]
    result["removed"] = removed
finally:
    lease(0)
    raw = OUT / version / "T15-focus-policy.json"
    raw.write_text(json.dumps(result, indent=2), encoding="utf-8")
    compact = dict(result)
    compact["cases"] = [{key: value for key,value in item.items() if key not in ["samples", "checkpoints"]} for item in result["cases"]]
    (DOCS / f"evidence/T15-{version}-focus-policy.json").write_text(json.dumps(compact, indent=2), encoding="utf-8")
    journal(f"T15 {version} runtime completed {len(result['cases'])} measured cases; raw={raw}; native foreground stand-in (not Workbench)={result['standInForegroundProcess']}")
print(json.dumps({"engine": version, "cases": [{"label": item["label"], "stats": item["stats"]} for item in result["cases"]]}, indent=2))

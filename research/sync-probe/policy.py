"""Short effective-throttle measurements without -unattended. No asset saves."""
import json
import math
import sys
import uuid
from evidence import OUT, journal
from rc import Client, PROBE, AUTHORING
from windows import state

version, mode = sys.argv[1:3]
client = Client(version, "T11-policy")
client.probe("Mark", Label="policy:" + mode)
client.scenario("throttle", value=mode.endswith("on"))
start = client.probe("GetCounts")
native_start = state(version)
path = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"
snapshot = client.snapshot(path)
timings = {"noop": [], "one": []}
for index in range(40):
    _, ms = client.call(PROBE, "Scenario", RequestJson='{"action":"noop"}')
    timings["noop"].append(ms)
    row = snapshot["table"]["rows"][0]
    field = row["fields"][0]
    request = {"contract": {"name": "unreal-authoring-apply", "version": {"major": 1, "minor": 2}}, "operationId": str(uuid.uuid4()), "tables": [{"objectPath": path, "expectedFingerprint": snapshot["fingerprint"]["value"]}], "commands": [{"id": str(uuid.uuid4()), "tableObjectPath": path, "body": {"kind": "set_cell", "rowId": row["id"], "fieldName": field["name"], "oldValue": field["value"], "newValue": {"kind": "bool", "value": not field["value"]["value"]}}}]}
    result, ms = client.call(AUTHORING, "Apply", RequestJson=json.dumps(request))
    if result["status"] != "committed": raise RuntimeError(result)
    snapshot = result["snapshots"][0]
    timings["one"].append(ms)
    if index % 10 == 9: print(f"{version} {mode}: {index+1}/40", flush=True)
def stats(values):
    values = sorted(values)
    return {"n": len(values), "p50": values[19], "p95": values[37], "max": values[-1]}
result = {"mode": mode, "before": start, "after": client.probe("GetCounts"), "nativeStart": native_start, "nativeEnd": state(version), "samples": timings, "stats": {k:stats(v) for k,v in timings.items()}}
target = OUT / version / f"policy-{mode}.json"
target.write_text(json.dumps(result, indent=2), encoding="utf-8")
journal(f"T11 non-unattended {version} policy {mode}: {result['stats']}; effective={start['effectiveShouldThrottle']}; raw={target}")
print(json.dumps(result["stats"]))

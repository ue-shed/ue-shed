"""Ordered runtime tasks: python live.py VERSION matrix|undo|perf|concurrent.
Only run against disposable research fixtures. Raw exchanges/timings are retained.
"""
import copy
import json
import math
import sys
import time
import uuid
from evidence import OUT, journal
from rc import Client, AUTHORING, PROBE

version, task = sys.argv[1:3]
client = Client(version, {"matrix": "T08", "undo": "T10", "perf": "T11", "concurrent": "T12"}[task])
base = OUT / version
scalar = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars"
five = [scalar] + [f"/Game/Fixture/Authoring/{name}.{name}" for name in ["DT_ScalarsOverride", "DT_Structs", "DT_RightReferences", "DT_Text"]]
large = "/Game/Fixture/Authoring/DT_LargeScalars.DT_LargeScalars"
results = []

def mark(label):
    client.probe("Mark", Label=f"{task}:{label}")

def record(label, function):
    mark(label)
    try:
        value = function()
        results.append({"label": label, "result": value})
        print(label, json.dumps(value)[:400], flush=True)
        return value
    except Exception as error:
        results.append({"label": label, "error": str(error)})
        print(label, "ERROR", error, flush=True)
        return None

def change(snapshot, serial=1):
    row = snapshot["table"]["rows"][0]
    field = next(f for f in row["fields"] if f["value"]["kind"] in ["int", "bool", "string", "text"])
    old = field["value"]
    new = copy.deepcopy(old)
    kind = old["kind"]
    if kind == "bool": new["value"] = not old["value"]
    elif kind == "int": new["value"] = str((int(old["value"]) + 1) % 100)
    elif kind == "string": new["value"] = f"SyncProbe {serial}"
    elif kind == "text": new = {"kind": "text", "value": f"SyncProbe {serial}", "identity": {"kind": "culture_invariant"}}
    return {"id": str(uuid.uuid4()), "tableObjectPath": snapshot["table"]["objectPath"], "body": {"kind": "set_cell", "rowId": row["id"], "fieldName": field["name"], "oldValue": old, "newValue": new}}

def apply(snapshots, serial=1):
    request = {"contract": {"name": "unreal-authoring-apply", "version": {"major": 1, "minor": 2}}, "operationId": str(uuid.uuid4()), "tables": [{"objectPath": s["table"]["objectPath"], "expectedFingerprint": s["fingerprint"]["value"]} for s in snapshots], "commands": [change(s, serial) for s in snapshots]}
    response, elapsed = client.call(AUTHORING, "Apply", RequestJson=json.dumps(request))
    if response["status"] != "committed": raise RuntimeError(json.dumps(response))
    return response, elapsed

def save_summary():
    (base / f"{task}-summary.json").write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    source = base / "fixture/Saved/SyncProbe/events.jsonl"
    if source.exists(): (base / f"{task}-events.jsonl").write_bytes(source.read_bytes())
    journal(f"{task} {version} finished; raw {base / (task + '-summary.json')}; {len(results)} records")

client.probe("Clear")
if task == "matrix":
    record("apply-one", lambda: {"status": apply([client.snapshot(scalar)])[0]["status"]})
    record("apply-five", lambda: {"status": apply([client.snapshot(p) for p in five])[0]["status"]})
    record("undo-five", lambda: client.probe("Undo"))
    record("redo-five", lambda: client.probe("Redo"))
    obj = record("dataasset-property", lambda: client.scenario("property"))
    record("actor-property", lambda: client.scenario("actor"))
    if obj:
        for access, value in [("WRITE_ACCESS", 10), ("WRITE_TRANSACTION_ACCESS", 20)]:
            def write(access=access, value=value):
                response = client.request("/remote/object/property", {"objectPath": obj["object"], "propertyName": "Value", "access": access, "propertyValue": {"Value": value}})[0]
                time.sleep(1.5)  # Isolate delayed ongoing-change finalization.
                return {"response": response, "counts": client.probe("GetCounts")}
            record("rc-" + access, write)
    for action, extra in [("cell", {"row": "Scalar_Alpha", "field": "Count", "value": 11}), ("row-add", {"row": "Probe_New"}), ("row-rename", {"row": "Probe_New", "newRow": "Probe_Renamed"}), ("row-reorder", {"row": "Scalar_Alpha"}), ("row-remove", {"row": "Probe_Renamed"}), ("cancel", {"row": "Scalar_Alpha", "field": "Count", "value": 12}), ("raw-cell", {"row": "Scalar_Alpha", "field": "Count", "value": 13})]:
        record(action, lambda action=action, extra=extra: client.scenario(action, table=scalar, **extra))
    record("interactive", lambda: client.scenario("interactive"))
    record("save", lambda: client.scenario("save", table=scalar))
    record("reload", lambda: client.scenario("reload", table=scalar))
    record("counts", lambda: client.probe("GetCounts"))
elif task == "undo":
    before = [client.snapshot(p) for p in five]
    counts0 = client.probe("GetCounts")
    result = record("apply-five", lambda: apply(before)[0])
    counts1 = client.probe("GetCounts")
    record("undo", lambda: client.probe("Undo"))
    after_undo = [client.snapshot(p) for p in five]
    counts2 = client.probe("GetCounts")
    record("redo", lambda: client.probe("Redo"))
    after_redo = [client.snapshot(p) for p in five]
    counts3 = client.probe("GetCounts")
    record("save-scalar", lambda: client.scenario("save", table=scalar))
    counts4 = client.probe("GetCounts")
    record("undo-after-save", lambda: client.probe("Undo"))
    after_save_undo = [client.snapshot(p) for p in five]
    results.append({"label": "proof", "counts": [counts0, counts1, counts2, counts3, counts4, client.probe("GetCounts")], "before": [s["fingerprint"]["value"] for s in before], "undo": [s["fingerprint"]["value"] for s in after_undo], "redo": [s["fingerprint"]["value"] for s in after_redo], "saveUndo": [s["fingerprint"]["value"] for s in after_save_undo]})
    cancel_before = client.snapshot(scalar)
    cancel_counts = client.probe("GetCounts")
    record("cancel", lambda: client.scenario("cancel", table=scalar, row="Scalar_Alpha", field="Count", value=55))
    results.append({"label": "cancel-proof", "beforeFingerprint": cancel_before["fingerprint"]["value"], "afterSnapshot": client.snapshot(scalar), "countsBefore": cancel_counts, "countsAfter": client.probe("GetCounts")})
elif task == "concurrent":
    record("open", lambda: client.scenario("open", table=scalar))
    stale = client.snapshot(scalar)
    record("apply-with-editor-open", lambda: apply([stale])[0]["status"])
    stale = client.snapshot(scalar)
    record("editor-cell", lambda: client.scenario("cell", table=scalar, row="Scalar_Alpha", field="Count", value=33))
    record("stale-apply", lambda: apply([stale])[0])
elif task == "perf":
    from windows import state
    window_start = state(version)
    mode = sys.argv[3] if len(sys.argv) > 3 else "unfocused"
    samples = {"noop": [], "one": [], "five": [], "large-snapshot": [], "large-apply": []}
    mark(mode)
    for _ in range(10): client.call(PROBE, "Scenario", RequestJson='{"action":"noop"}')
    one_state = [client.snapshot(scalar)]
    five_state = [client.snapshot(p) for p in five]
    large_state = [client.snapshot(large)]
    for index in range(40):
        _, elapsed = client.call(PROBE, "Scenario", RequestJson='{"action":"noop"}'); samples["noop"].append(elapsed)
        response, elapsed = apply(one_state, index + 100); samples["one"].append(elapsed); one_state = response["snapshots"]
        five_state[0] = one_state[0]
        response, elapsed = apply(five_state, index + 200); samples["five"].append(elapsed); five_state = response["snapshots"]; one_state = [five_state[0]]
        response, elapsed = client.call(AUTHORING, "GetTableSnapshot", TableObjectPath=large); samples["large-snapshot"].append(elapsed); large_state = [response]
        response, elapsed = apply(large_state, index + 300); samples["large-apply"].append(elapsed); large_state = response["snapshots"]
    start = client.probe("GetCounts")
    sequential = []
    for index in range(200):
        response, elapsed = apply(one_state, index + 1000); sequential.append(elapsed); one_state = response["snapshots"]
    end = client.probe("GetCounts")
    def stats(values):
        values = sorted(values)
        return {"n": len(values), "p50": values[math.ceil(len(values)*.5)-1], "p95": values[math.ceil(len(values)*.95)-1], "max": values[-1]}
    results.append({"label": mode, "windowStart": window_start, "windowEnd": state(version), "stats": {k: stats(v) for k, v in samples.items()}, "sequential": stats(sequential), "before": start, "after": end, "largeRows": len(large_state[0]["table"]["rows"]), "samples": samples, "sequentialSamples": sequential})
    (base / f"perf-{mode}-summary.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
else:
    raise SystemExit("unknown task")
save_summary()

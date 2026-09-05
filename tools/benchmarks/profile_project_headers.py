"""Run one fresh native scan and aggregate isolated header-profile instrumentation."""
import argparse
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--project", type=Path, required=True)
parser.add_argument("--reader", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 1}},
           "requestId": "header-profile", "limits": {"maximumOutputBytes": 33554432, "timeoutMs": 300000},
           "operation": {"kind": "project_index_refresh", "cacheRoot": str(out / "cache"), "projectRoot": str(args.project.resolve())}}
started = time.perf_counter()
process = subprocess.run([str(args.reader.resolve()), "protocol"], input=json.dumps(request).encode(), capture_output=True, timeout=330, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
elapsed = (time.perf_counter() - started) * 1000
events = [json.loads(line) for line in process.stdout.splitlines()]
assert events[-1]["kind"] == "completed", "refresh failed"
summary = next(e["result"]["summary"] for e in events if e["kind"] == "result" and e["result"]["kind"] == "project_index_summary")
stages = {}
for line in process.stderr.decode().splitlines():
    if not line.startswith("HEADER_PROFILE "):
        continue
    _, label, ns, count = line.split()
    stage = stages.setdefault(label, {"worker_elapsed_ms": 0, "calls": 0})
    stage["worker_elapsed_ms"] += int(ns) / 1_000_000
    stage["calls"] += int(count)
result = {"elapsed_ms": elapsed, "summary": {k: summary[k] for k in ["changedPackages", "completeness", "generation", "mapCount", "packageCount", "removedPackages"]}, "diagnosticCount": len(summary["diagnostics"]), "stages": stages}
(out / "profile.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result, indent=2))

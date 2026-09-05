"""Force one metadata mismatch in a marked disposable research cache, then refresh.

Project files are never modified. Requires caches from compare_project_catalogs.py.
This is an exploratory cache-repair measurement, not an authored project mutation.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--project", type=Path, required=True)
parser.add_argument("--reader", type=Path, required=True)
parser.add_argument("--cache", type=Path, required=True)
parser.add_argument("--engine", choices=["duckdb", "sqlite"], required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
assert not args.output.exists(), "refusing to replace prior results"
cache = args.cache.resolve()
assert (cache / ".catalog-research-cache").is_file(), "cache lacks research ownership marker"
manifests = list(cache.rglob("manifest.json"))
assert len(manifests) == 1
manifest_path = manifests[0]
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
snapshot = (manifest_path.parent / manifest["physical_snapshot"]).resolve()
assert snapshot.is_relative_to(cache), "snapshot leaves the disposable cache"
if args.engine == "duckdb":
    import duckdb
    connection = duckdb.connect(str(snapshot))
else:
    connection = sqlite3.connect(snapshot)
row = connection.execute("SELECT relative_path,modified_nanos FROM entry WHERE kind=0 AND failure_code IS NULL AND modified_nanos>0 ORDER BY relative_path LIMIT 1").fetchone()
assert row is not None
timestamp = row[1]
replacement = (int.from_bytes(timestamp, "big") - 1).to_bytes(8, "big") if isinstance(timestamp, bytes) else timestamp - 1
connection.execute("UPDATE entry SET modified_nanos=? WHERE relative_path=?", [replacement, row[0]])
connection.commit()
connection.close()


def call(operation):
    request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 1}},
               "requestId": "catalog-repair", "limits": {"maximumOutputBytes": 33554432, "timeoutMs": 300000}, "operation": operation}
    started = time.perf_counter()
    process = subprocess.run([str(args.reader.resolve()), "protocol"], input=json.dumps(request).encode(), capture_output=True, timeout=330, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    elapsed = (time.perf_counter() - started) * 1000
    events = [json.loads(line) for line in process.stdout.splitlines()]
    assert events[-1]["kind"] == "completed", "native operation failed"
    return elapsed, events


elapsed, events = call({"kind": "project_index_refresh", "cacheRoot": str(cache), "projectRoot": str(args.project.resolve())})
summary = next(e["result"]["summary"] for e in events if e["kind"] == "result" and e["result"]["kind"] == "project_index_summary")
assert summary["changedPackages"] == 1
assert summary["removedPackages"] == 0
assert summary["packageCount"] == manifest["summary"]["package_count"]
aggregate = next(e["message"] for e in events if e["kind"] == "diagnostic" and "evidence_write_ms=" in e["message"])
timings = {key: int(value) for key, value in re.findall(r"(\w+)=(\d+)", aggregate)}
result = {"elapsed_ms": elapsed, "aggregate": timings, "queries": {}}
for value in ["TextProperty", "__UE_SHED_ABSENT_NAME_PROBE__", "None"]:
    samples = []
    for _ in range(3):
        duration, output = call({"kind": "project_index_query", "cacheRoot": str(cache), "query": {
            "projectId": summary["projectId"], "expectedGeneration": summary["generation"], "kind": "serialized_names", "values": [value], "limit": 1024}})
        page = next(e["result"]["page"] for e in output if e["kind"] == "result" and e["result"]["kind"] == "project_index_page")
        samples.append({"milliseconds": duration, "items": len(page["items"]), "has_more": page.get("nextCursor") is not None})
    result["queries"][value] = samples
args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result))

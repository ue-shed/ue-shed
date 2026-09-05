"""Compare bounded name queries after each native reader has opened its Catalog.

Reads marked comparison caches only. Keeps setup timing separate and verifies identical pages.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("--reader", action="append", required=True, help="label=executable")
parser.add_argument("--cache", action="append", required=True, help="label=marked-cache")
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
assert not args.output.exists(), "refusing to replace prior results"
caches = dict(spec.split("=", 1) for spec in args.cache)
results = {}
reference = {}
for spec in args.reader:
    label, executable = spec.split("=", 1)
    cache = Path(caches[label]).resolve()
    assert (cache / ".catalog-research-cache").is_file()
    manifests = list(cache.rglob("manifest.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    setup_started = time.perf_counter()
    child = subprocess.Popen([str(Path(executable).resolve()), "protocol-session"], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    watchdog = threading.Timer(60, child.kill)
    watchdog.start()

    def call(kind, values=None, limit=1024):
        query = {"kind": kind, "projectId": manifest["project_id"],
                 "expectedGeneration": manifest["summary"]["generation"], "limit": limit}
        if values is not None:
            query["values"] = values
        request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 1}},
                   "requestId": "query-session", "limits": {"maximumOutputBytes": 33554432, "timeoutMs": 30000},
                   "operation": {"kind": "project_index_query", "cacheRoot": str(cache), "query": query}}
        started = time.perf_counter()
        child.stdin.write(json.dumps(request).encode() + b"\n")
        child.stdin.flush()
        page = None
        while True:
            line = child.stdout.readline()
            assert line, "native session ended before completion"
            event = json.loads(line)
            if event["kind"] == "result":
                page = event["result"]["page"]
            if event["kind"] in ["failed", "completed"]:
                assert event["kind"] == "completed" and page is not None, "query failed"
                break
        elapsed = (time.perf_counter() - started) * 1000
        # Project identity and generation are deliberately excluded from evidence.
        stable = {"items": page["items"], "nextCursor": page.get("nextCursor")}
        digest = hashlib.sha256(json.dumps(stable, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        return {"milliseconds": elapsed, "items": len(page["items"]), "has_more": page.get("nextCursor") is not None, "sha256": digest}

    try:
        call("maps", limit=1)
        result = {"setup_ms": (time.perf_counter() - setup_started) * 1000, "queries": {}}
        for value in ["TextProperty", "__UE_SHED_ABSENT_NAME_PROBE__", "None"]:
            samples = [call("serialized_names", [value]) for _ in range(5)]
            fingerprints = {sample["sha256"] for sample in samples}
            assert len(fingerprints) == 1, "unstable results within one session"
            digest = samples[0]["sha256"]
            assert reference.setdefault(value, digest) == digest, "engines returned different pages"
            result["queries"][value] = samples
        results[label] = result
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        watchdog.cancel()
    assert child.returncode == 0
args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results))

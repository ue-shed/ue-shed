"""Compare complete ordered showcase query output across native Catalog readers.

Uses disposable caches under a fresh output directory. Reads project content without modifying it.
Outputs aggregate counts and SHA-256 digests, never project identities or asset contents.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--project", type=Path, required=True)
parser.add_argument("--reader", action="append", required=True, help="label=executable")
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
queries = [
    {"kind": "maps"},
    {"kind": "exact_classes", "values": ["/Script/Engine.DataTable", "/Script/Engine.CompositeDataTable", "/Script/Engine.StringTable", "/Script/Engine.Texture2D"]},
    {"kind": "class_prefixes", "values": ["/Script/EnhancedInput."]},
    {"kind": "class_name_suffixes", "values": ["InputAction", "InputMappingContext"]},
    {"kind": "serialized_names", "values": ["TextProperty"]},
]


def call(reader, operation):
    request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 1}},
               "requestId": "catalog-parity", "limits": {"maximumOutputBytes": 33554432, "timeoutMs": 300000}, "operation": operation}
    process = subprocess.run([str(reader), "protocol"], input=json.dumps(request).encode(), capture_output=True, timeout=330, check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    events = [json.loads(line) for line in process.stdout.splitlines()]
    assert events[-1]["kind"] == "completed", "native request did not complete"
    return [event["result"] for event in events if event["kind"] == "result"]


results = {}
for spec in args.reader:
    label, executable = spec.split("=", 1)
    assert label and all(c.isalnum() or c in "-_" for c in label), "invalid reader label"
    reader = Path(executable).resolve()
    cache = (args.output / label).resolve()
    cache.mkdir()
    (cache / ".catalog-research-cache").write_text("Disposable Catalog experiment\n", encoding="utf-8")
    refresh = call(reader, {"kind": "project_index_refresh", "cacheRoot": str(cache), "projectRoot": str(args.project.resolve())})
    summary = next(r["summary"] for r in refresh if r["kind"] == "project_index_summary")
    output = {"packages": summary["packageCount"], "maps": summary["mapCount"], "completeness": summary["completeness"], "queries": []}
    for query in queries:
        cursor = None
        digest = hashlib.sha256()
        count = pages = 0
        while True:
            request = {**query, "projectId": summary["projectId"], "expectedGeneration": summary["generation"], "limit": 1024}
            if cursor is not None:
                request["cursor"] = cursor
            result = call(reader, {"kind": "project_index_query", "cacheRoot": str(cache), "query": request})
            page = next(r["page"] for r in result if r["kind"] == "project_index_page")
            pages += 1
            count += len(page["items"])
            for item in page["items"]:
                digest.update(json.dumps(item, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode() + b"\n")
            cursor = page.get("nextCursor")
            if cursor is None:
                break
        output["queries"].append({"kind": query["kind"], "items": count, "pages": pages, "sha256": digest.hexdigest()})
    results[label] = output
    (args.output / "comparison.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(label, output, flush=True)
assert all(value == next(iter(results.values())) for value in results.values()), "Catalog query outputs differ"
print("All ordered showcase query outputs match.")

"""Assemble and exercise the current Windows npm native package in a disposable consumer.

Never publishes. Requires a new output directory and a release reader matching the suite version.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--reader", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
assert os.name == "nt", "the current npm native artifact supports Windows only"
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
node = shutil.which("node")
assert node
def run(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=120, **kwargs)

archives = []
for name in ["uasset-win32-x64", "uasset"]:
    package = out / name
    shutil.copytree(root / "packages" / name, package, ignore=shutil.ignore_patterns("node_modules", "bin" if name.endswith("x64") else "__pycache__"))
    manifest_path = package / "package.json"
    manifest = json.loads(manifest_path.read_text())
    for key, value in manifest.get("optionalDependencies", {}).items():
        manifest["optionalDependencies"][key] = value.removeprefix("workspace:")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    if name.endswith("x64"):
        run([node, str(root / "packages/uasset-win32-x64/scripts/assemble.mts"), "--source", str(args.reader.resolve()), "--destination", str(package / "bin/uasset.exe")])
    packed = run(["cmd", "/d", "/c", "npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(out)], cwd=package)
    archives.append(out / json.loads(packed.stdout)[0]["filename"])

consumer = out / "consumer"
consumer.mkdir()
(consumer / "package.json").write_text('{"name":"catalog-artifact-probe","private":true}\n')
run(["cmd", "/d", "/c", "npm", "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", *map(str, archives)], cwd=consumer)
launcher = consumer / "node_modules/@ue-shed/uasset/bin/uasset.js"
environment = os.environ.copy()
environment["PATH"] = ""
version = run([node, str(launcher), "--version"], env=environment).stdout.decode().strip()
def call(operation):
    request = {"contract": {"name": "uasset-io", "version": {"major": 1, "minor": 1}},
        "requestId": "packed-catalog-probe", "limits": {"maximumOutputBytes": 33554432, "timeoutMs": 30000}, "operation": operation}
    events = [json.loads(line) for line in run([node, str(launcher), "protocol"], input=json.dumps(request).encode(), env=environment).stdout.splitlines()]
    assert events[-1]["kind"] == "completed", "packed native operation failed"
    return [e["result"] for e in events if e["kind"] == "result"]

cache = out / "cache"
operation = {"kind": "project_index_refresh", "cacheRoot": str(cache), "projectRoot": str(root / "fixtures/unreal-project")}
fresh = call(operation)
warm = call(operation)
manifests = list(cache.rglob("manifest.json"))
assert len(manifests) == 1
manifest = json.loads(manifests[0].read_text())
pages = call({"kind": "project_index_query", "cacheRoot": str(cache), "query": {
    "kind": "maps", "projectId": manifest["project_id"], "expectedGeneration": manifest["summary"]["generation"], "limit": 1024}})
assert manifest["summary"]["package_count"] > 0
assert manifest["summary"]["changed_packages"] == 0
assert len(pages[0]["page"]["items"]) == manifest["summary"]["map_count"] > 0
result = {"version": version, "packages": manifest["summary"]["package_count"], "maps": manifest["summary"]["map_count"],
    "warmChangedPackages": manifest["summary"]["changed_packages"], "emptyPathEnvironment": True,
    "archives": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in archives}}
(out / "results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))

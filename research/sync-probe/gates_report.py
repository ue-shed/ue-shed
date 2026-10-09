"""Extract small baseline evidence and asset-save inventory from retained logs."""
import csv
import json
import re
from pathlib import Path
import subprocess
from evidence import ROOT, OUT, DOCS, journal

retained = Path(__import__("sys").argv[1]).resolve()
summary = {"runtime": "Node 26.9.0", "retainedLocalizationRoot": str(retained), "gates": {}, "localizationReceipts": []}
for label in ["prerequisites", "authoring-5.7", "authoring-5.8", "localization"]:
    value = json.loads((OUT / f"T13-{label}-result.json").read_text())
    summary["gates"][label] = {key: value[key] for key in ["exit", "timedOut", "elapsedSeconds", "log"]}
for version in ["5.7", "5.8", "4.27"]:
    for receipt in sorted((retained / version).glob("*.receipt.json")):
        value = json.loads(receipt.read_text())
        summary["localizationReceipts"].append({"engine": version, "operation": value["operation"], "status": value["status"], "durationMs": value["durationMs"], "pid": value.get("pid"), "receipt": str(receipt.relative_to(ROOT))})
summary["pidWatcherLimitation"] = "PID-only ancestry is a candidate ownership list: PID reuse can produce false attribution. Final Win32 process inventory found no Unreal/UE4Editor/ShaderCompile/Zen/crashpad processes; do not kill a process solely because its numeric PID is listed."
(DOCS / "evidence/T13-baseline.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
log_roots = [ROOT / "fixtures/unreal-project/Saved/Logs"] + [retained / version / "p/Saved/Logs" for version in ["5.7", "5.8", "4.27"]]
rows = {}
for log_root in log_roots:
    for log in log_root.glob("*.log"):
        for number, line in enumerate(log.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            match = re.search(r"LogSavePackage: Moving output files for package: (/Game/\S+)", line)
            if match:
                package = match[1]
                project = log_root.parent.parent
                asset = project / "Content" / (package.removeprefix("/Game/") + ".uasset")
                # Map assets are listed as packages too; record their actual extension.
                if not asset.exists(): asset = asset.with_suffix(".umap")
                key = str(asset.relative_to(ROOT))
                rows[key] = {"asset": key, "package": package, "evidence": f"{log.relative_to(ROOT)}:{number}", "restore": "git checkout -- fixtures/unreal-project/Content" if project == ROOT / "fixtures/unreal-project" else "disposable copy; no tracked asset counterpart changed by this lane"}
changed = subprocess.check_output(["git", "diff", "--name-only", "--", "fixtures/unreal-project/Content"], cwd=ROOT, text=True).splitlines()
for path in changed:
    normalized = str(Path(path))
    rows.setdefault(normalized, {"asset": normalized, "package": "", "evidence": "git diff --name-only before restore (byte change proves write, not specific save call)", "restore": "git checkout -- fixtures/unreal-project/Content"})
for version in ["5.7", "5.8"]:
    path = f"out/sync-research/{version}/fixture/Content/Fixture/Authoring/DT_Scalars.uasset"
    rows[path] = {"asset": path, "package": "/Game/Fixture/Authoring/DT_Scalars", "evidence": f"out/sync-research/{version}/T10-rpc.jsonl; save scenario", "restore": "already restored by fixture.py restore-assets from original tracked bytes after T10"}
with (DOCS / "evidence/asset-saves.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=["asset", "package", "evidence", "restore"])
    writer.writeheader(); writer.writerows(rows[key] for key in sorted(rows))
journal(f"T13 summary extracted from retained receipts: {summary['localizationReceipts']}; saved asset inventory {len(rows)} distinct paths, tracked byte changes {len(changed)}. PID ancestry caveat recorded; final live process inventory found none of the engine/service processes.")
print(json.dumps(summary, indent=2))

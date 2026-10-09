"""Restore saved disposable packages from already git-restored tracked counterparts.

Run git checkout -- fixtures/unreal-project/Content first. No recursive deletion.
The copies under ignored out/ have no git history and cannot themselves be checked out.
"""
import csv
import shutil
from evidence import ROOT, DOCS, journal

inventory = DOCS / "evidence/asset-saves.csv"
with inventory.open(encoding="utf-8", newline="") as handle:
    rows = list(csv.DictReader(handle))
for row in rows:
    asset = row["asset"].replace("\\", "/")
    if not asset.startswith("out/") or "/Content/" not in asset: continue
    target = (ROOT / asset).resolve()
    source = (ROOT / "fixtures/unreal-project/Content" / asset.split("/Content/", 1)[1]).resolve()
    assert target.is_relative_to((ROOT / "out").resolve())
    assert source.is_relative_to((ROOT / "fixtures/unreal-project/Content").resolve())
    if source.exists():
        shutil.copy2(source, target)
        row["restore"] = "restored from git-checkout tracked fixture bytes by research/sync-probe/restore.py; out copy has no git history"
        journal(f"Cleanup restored saved disposable package {target} from git-restored {source}; retained receipts/logs unaffected")
    else:
        journal(f"Cleanup UNVERIFIED original restore for generated disposable package {target}: no tracked counterpart; retained as ignored evidence")
with inventory.open("w", encoding="utf-8", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=["asset", "package", "evidence", "restore"])
    writer.writeheader(); writer.writerows(rows)

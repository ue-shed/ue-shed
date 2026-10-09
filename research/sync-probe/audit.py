"""Validate research artifacts without running product or engine mutations."""
import ast
import json
import os
from pathlib import Path
import re
from evidence import ROOT, DOCS, OUT

errors = []
counts = {}
for path in DOCS.glob("T[0-9][0-9]-*.md"):
    text = path.read_text(encoding="utf-8")
    for field in ["Question", "Why it matters for the sync layer", "Method", "Results", "Evidence", "Confidence", "Surprises / risks found", "Open follow-ups"]:
        if len(re.findall(r"^" + re.escape(field) + ":", text, re.M)) != 1: errors.append(f"{path.name}: missing/duplicated {field}")
    if "Pending investigation" in text: errors.append(f"{path.name}: placeholder remains")
counts["tasks"] = len(list(DOCS.glob("T[0-9][0-9]-*.md")))
for path in DOCS.rglob("*.json"):
    try: json.loads(path.read_text(encoding="utf-8"))
    except Exception as error: errors.append(f"{path}: {error}")
for path in DOCS.rglob("*.jsonl"):
    lines = path.read_text(encoding="utf-8").splitlines()
    if len(lines) > 200: errors.append(f"{path}: {len(lines)} lines exceeds 200")
    for number, line in enumerate(lines, 1):
        try: json.loads(line)
        except Exception as error: errors.append(f"{path}:{number}: {error}")
    counts[path.name] = len(lines)
for path in DOCS.glob("*.md"):
    for match in re.finditer(r"\]\(([^\s)]+)\)", path.read_text(encoding="utf-8")):
        link = match[1]
        if link.startswith(("http:", "https:", "#")): continue
        target = path.parent / link.split("#")[0]
        if not target.exists(): errors.append(f"{path.name}: absent local link {link}")
for path in (ROOT / "research/sync-probe").glob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
# Exercise Win32 process identities only. Stop before the harness's command dispatch.
source = (ROOT / "research/sync-probe/gates.py").read_text(encoding="utf-8")
prefix = source[:source.index("mode = sys.argv[1]")]
namespace = {}
exec(compile(prefix, "gates-process-inspection", "exec"), namespace)
created = namespace["creation_ticks"](os.getpid())
assert created and namespace["processes"]()[os.getpid()]["creationTicks"] == created
counts["creationTimeInspection"] = "passed for current Python process"
result = {"errors": errors, "counts": counts, "status": "passed" if not errors else "failed"}
(OUT / "final-artifact-audit.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
print(json.dumps(result, indent=2))
raise SystemExit(bool(errors))

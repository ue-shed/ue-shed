"""Throwaway source-evidence utility. Engine paths are supplied by a JSON manifest.

Usage: python research/sync-probe/evidence.py query TASK VERSION SUBTREE REGEX
       python research/sync-probe/evidence.py read VERSION RELATIVE_PATH START END
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "out/sync-research"
DOCS = ROOT / "docs/research/sync-feasibility"


def journal(message):
    with (DOCS / "JOURNAL.md").open("a", encoding="utf-8") as handle:
        handle.write(f"\n- {datetime.datetime.now().astimezone().isoformat()} {message}\n")


def engine(version):
    manifest = Path(os.environ.get("UE_SHED_RESEARCH_ENGINES", OUT / "engines.json"))
    return Path(json.loads(manifest.read_text(encoding="utf-8-sig"))[version])


if __name__ == "__main__":
    mode, *args = sys.argv[1:]
    if mode == "query":
        task, version, subtree, pattern = args
        base = engine(version)
        command = ["rg", "-n", "--no-heading", pattern, str(base / subtree)]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        output = result.stdout.replace(str(base) + "\\", "")
        destination = OUT / f"{task}-{version}-source.txt"
        destination.write_text(output + result.stderr, encoding="utf-8")
        print(f"exit={result.returncode} lines={len(output.splitlines())} raw={destination}")
        print("\n".join(output.splitlines()[:150]))
    elif mode == "read":
        version, relative, start, end = args
        path = engine(version) / relative if version != "repo" else ROOT / relative
        lines = path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
        print(f"{version}: {relative}")
        for number in range(int(start), min(int(end), len(lines)) + 1):
            print(f"{number}: {lines[number - 1]}")
    elif mode == "journal":
        journal(" ".join(args))

#!/usr/bin/env python3
"""Require existing decoded property evidence to survive raw-to-typed improvements unchanged."""

import argparse
import json
from pathlib import Path


def identity(row):
    return row["package"], row["export"], row["path"]


def compare_ordered(before, after):
    """Compare preorder JSON lines, retaining only one witness from each input."""
    after = iter(after)
    current_line = next(after, None)
    checked = 0
    previous_package = None
    package_marker = None
    improved = {}
    for old_line in before:
        old = None
        if package_marker is None or package_marker not in old_line:
            old = json.loads(old_line)
            if old["package"] != previous_package:
                checked += 1
                previous_package = old["package"]
            package_marker = '"package":' + json.dumps(previous_package, ensure_ascii=False) + ','
        # Exact serialized equality proves both identity and value equality. Most
        # evidence is unchanged, so avoid decoding tens of gigabytes of identical JSON.
        if old_line == current_line:
            current_line = next(after, None)
            continue
        old = old if old is not None else json.loads(old_line)
        current = json.loads(current_line) if current_line is not None else None
        if current is None or identity(current) != identity(old):
            raise ValueError(f"existing value removed, reordered, or unrelated value added: {identity(old)}")
        changed = (old["kind"], old["digest"]) != (current["kind"], current["digest"])
        if changed and (old["kind"] != "raw" or current["kind"] == "raw"):
            raise ValueError(f"existing decoded value or raw reason changed: {identity(old)}")
        current_line = next(after, None)
        if changed:
            improved[old["package"]] = improved.get(old["package"], 0) + 1
            # A formerly raw node had no descendants. Only its new descendants may
            # precede the next unchanged witness; neighboring fields stay checked.
            while current_line is not None:
                current = json.loads(current_line)
                if (current["package"] != old["package"] or current["export"] != old["export"]
                        or not current["path"].startswith(old["path"] + "/")):
                    break
                current_line = next(after, None)
    if current_line is not None:
        raise ValueError(f"unrelated value added: {identity(json.loads(current_line))}")
    return checked, improved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--output", type=Path, help="optional JSON report including improved package paths")
    args = parser.parse_args()
    with (args.before / "values.jsonl").open(encoding="utf8") as before, \
            (args.after / "values.jsonl").open(encoding="utf8") as after:
        checked, improved = compare_ordered(before, after)
    if (args.before / "errors.jsonl").read_bytes() != (args.after / "errors.jsonl").read_bytes():
        raise ValueError("parse/export failures changed; investigate before proceeding")
    summary = {"packages_with_property_evidence": checked,
                      "packages_improved": len(improved),
                      "raw_values_decoded": sum(improved.values()),
                      "existing_values_unchanged": True}
    if args.output:
        args.output.write_text(json.dumps({**summary, "improved_packages": improved}, indent=2), encoding="utf8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

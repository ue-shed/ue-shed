#!/usr/bin/env python3
"""Require existing decoded property evidence to survive raw-to-typed improvements unchanged."""

import argparse
import itertools
import json
from pathlib import Path


def packages(path):
    with path.open(encoding="utf8") as stream:
        rows = (json.loads(line) for line in stream)
        for package, group in itertools.groupby(rows, key=lambda row: row["package"]):
            values = {}
            for row in group:
                key = (row["export"], row["path"])
                if key in values:
                    raise ValueError(f"duplicate evidence: {package} {key}")
                values[key] = (row["kind"], row["digest"])
            yield package, values


def compare(old, new):
    replacements = []
    for key, value in old.items():
        if key not in new:
            raise ValueError(f"existing value removed: {key}")
        if new[key] != value:
            if value[0] != "raw" or new[key][0] == "raw":
                raise ValueError(f"existing decoded value or raw reason changed: {key}")
            replacements.append(key)
    for export, path in new.keys() - old.keys():
        if not any(export == parent_export and path.startswith(parent + "/")
                   for parent_export, parent in replacements):
            raise ValueError(f"unrelated value added: {(export, path)}")
    return len(replacements)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--output", type=Path, help="optional JSON report including improved package paths")
    args = parser.parse_args()
    checked = replacements = changed_packages = 0
    improved = {}
    for before, after in itertools.zip_longest(packages(args.before / "values.jsonl"),
                                              packages(args.after / "values.jsonl")):
        if before is None or after is None or before[0] != after[0]:
            raise ValueError("package evidence order or membership changed")
        try:
            changed = compare(before[1], after[1])
        except ValueError as error:
            raise ValueError(f"{before[0]}: {error}") from error
        checked += 1
        replacements += changed
        changed_packages += bool(changed)
        if changed:
            improved[before[0]] = changed
    if (args.before / "errors.jsonl").read_bytes() != (args.after / "errors.jsonl").read_bytes():
        raise ValueError("parse/export failures changed; investigate before proceeding")
    summary = {"packages_with_property_evidence": checked,
                      "packages_improved": changed_packages,
                      "raw_values_decoded": replacements,
                      "existing_values_unchanged": True}
    if args.output:
        args.output.write_text(json.dumps({**summary, "improved_packages": improved}, indent=2), encoding="utf8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

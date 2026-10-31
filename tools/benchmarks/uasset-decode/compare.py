#!/usr/bin/env python3
"""Compare ordered package digests and median decode-harness measurements."""

import argparse
import csv
import json
import statistics
from pathlib import Path


def read_digests(directory):
    entries = []
    with (directory / "digests.tsv").open(encoding="utf-8", newline="") as stream:
        for row in csv.reader(stream, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(row) != 3:
                raise ValueError(f"{directory}/digests.tsv: expected three columns")
            entries.append(tuple(row))
    return entries


def compare_digests(before, after):
    # Retain duplicate list entries and their order, rather than silently overwriting them.
    before_paths = {}
    after_paths = {}
    for path, text, inspect in before:
        before_paths.setdefault(path, []).append((text, inspect))
    for path, text, inspect in after:
        after_paths.setdefault(path, []).append((text, inspect))
    differences = 0
    for path in dict.fromkeys([*before_paths, *after_paths]):
        old = before_paths.get(path)
        new = after_paths.get(path)
        if old != new:
            differences += 1
            if old is None:
                reason = "added"
            elif new is None:
                reason = "removed"
            else:
                changes = []
                if [entry[0] for entry in old] != [entry[0] for entry in new]:
                    changes.append("text")
                if [entry[1] for entry in old] != [entry[1] for entry in new]:
                    changes.append("inspect")
                reason = ", ".join(changes)
            print(f"DIFF {path}: {reason}")
    print(f"Digest differences: {differences}")
    return differences


def read_runs(directory):
    path = directory / "runs.json"
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as stream:
        runs = json.load(stream)["runs"]
    if not runs:
        raise ValueError(f"{path}: no runs")
    return runs


def metric(runs, key, maximum=False):
    if runs is None:
        return None
    values = [run[key] for run in runs]
    return max(values) if maximum else statistics.median(values)


def print_measurements(before, after):
    print(f"{'Metric':<26} {'Before':>16} {'After':>16} {'Change':>12}")
    fields = [(f"{stage}_ns", f"{stage} (ms)", 1_000_000, False)
              for stage in ("parse", "decode", "project", "drop", "inspect")]
    fields += [("alloc_count", "alloc_count (median)", 1, False),
               ("alloc_bytes", "alloc_bytes (median)", 1, False),
               ("peak_live_bytes", "max peak_live_bytes", 1, True)]
    for key, label, divisor, maximum in fields:
        old = metric(before, key, maximum)
        new = metric(after, key, maximum)
        old_text = "n/a" if old is None else f"{old / divisor:,.3f}"
        new_text = "n/a" if new is None else f"{new / divisor:,.3f}"
        if old is None or new is None or (old == 0 and new != 0):
            change = "n/a"
        else:
            change = f"{(new / old - 1) * 100:+.2f}%" if old else "+0.00%"
        print(f"{label:<26} {old_text:>16} {new_text:>16} {change:>12}")
    if before is None or after is None:
        print("n/a: runs.json absent (digest-only output has no measurements).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before_out", type=Path)
    parser.add_argument("after_out", type=Path)
    args = parser.parse_args()
    differences = compare_digests(read_digests(args.before_out), read_digests(args.after_out))
    print_measurements(read_runs(args.before_out), read_runs(args.after_out))
    return 1 if differences else 0


if __name__ == "__main__":
    raise SystemExit(main())

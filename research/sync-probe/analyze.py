"""Produce compact committed evidence from retained logs (no invented observations)."""
import collections
import csv
import json
from evidence import OUT, DOCS

HOOKS = ["ObjectModified", "PropertyChanged", "ObjectTransacted", "DataTableChanged", "PackageDirtyStateChanged", "PackageMarkedDirty", "PostUndo", "PostRedo", "TransactionState"]

def events(version, task):
    return [json.loads(line) for line in (OUT / version / f"{task}-events.jsonl").read_text(encoding="utf-8-sig").splitlines()]

def segments(items):
    groups = {}
    label = "startup"
    for item in items:
        if item["hook"] == "Mark":
            label = item["label"].split(":", 1)[1]
            groups.setdefault(label, [])
        else: groups.setdefault(label, []).append(item)
    return groups

def matrix(version):
    groups = segments(events(version, "matrix"))
    rows = []
    for label, items in groups.items():
        counts = collections.Counter(item["hook"] for item in items)
        props = sorted(set(item.get("property", "") for item in items if item["hook"] == "PropertyChanged"))
        txprops = sorted(set(p for item in items for p in item.get("properties", [])))
        rows.append([label] + [counts[h] for h in HOOKS] + [all(item["gameThread"] for item in items) if items else None, ";".join(props), ";".join(txprops), ";".join(sorted(set(str(item["eventType"]) for item in items if "eventType" in item)))])
    with (DOCS / f"evidence/T08-{version}-matrix.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["scenario"] + HOOKS + ["allGameThread", "propertyChangedNames", "transactedProperties", "transactedEventTypes"])
        writer.writerows(rows)
    # <=200 lines per JSONL file; preserve complete event windows for key cases.
    sample = []
    for label in ["apply-five", "undo-five", "redo-five", "cell", "cancel", "raw-cell", "interactive", "save", "reload"]:
        sample.append({"scenario": label})
        sample.extend(groups.get(label, []))
    destination = DOCS / f"evidence/T08-{version}-sample.jsonl"
    destination.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in sample[:200]) + "\n", encoding="utf-8")
    print(version, "matrix", rows)

if __name__ == "__main__":
    import sys
    for version in sys.argv[1:] or ["5.7", "5.8"]: matrix(version)

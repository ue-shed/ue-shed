#!/usr/bin/env python3
"""Run one full coverage census with bounded workers over disjoint package shards."""

import argparse
import concurrent.futures
import json
import subprocess
import time
from pathlib import Path

COUNT_FIELDS = ("count", "packages_affected", "raw_payload_bytes", "unknown_payload_sizes")
BUCKET_FIELDS = ("reason", "detail", "property_type", "struct_name", "export_class")


def merge_count(target, source):
    for field in COUNT_FIELDS:
        target[field] = target.get(field, 0) + source[field]
    examples = target.setdefault("examples", [])
    for example in source["examples"]:
        if len(examples) < 3 and example not in examples:
            examples.append(example)


def merge(reports, wall_seconds):
    result = {"schema": 1, "git_commit": reports[0]["git_commit"],
              "scope": reports[0]["scope"], "wall_seconds": wall_seconds,
              "workers": len(reports), "totals": {}, "stage_ns": {},
              "by_reason": {}, "errors": {}}
    buckets = {}
    for report in reports:
        if report["schema"] != result["schema"] or report["git_commit"] != result["git_commit"]:
            raise ValueError("worker schema or source revision differs")
        for group in ("totals", "stage_ns"):
            for field, value in report[group].items():
                result[group][field] = result[group].get(field, 0) + value
        for reason, count in report["by_reason"].items():
            target = result["by_reason"].setdefault(reason, {})
            merge_count(target, count)
            for field in ("by_detail", "by_property_type", "by_struct_name", "by_export_class"):
                groups = target.setdefault(field, {})
                for key, value in count[field].items():
                    merge_count(groups.setdefault(key, {}), value)
        for bucket in report["buckets"]:
            key = tuple(bucket[field] for field in BUCKET_FIELDS)
            target = buckets.setdefault(key, {field: bucket[field] for field in BUCKET_FIELDS})
            merge_count(target, bucket)
        for error, count in report["errors"].items():
            merge_count(result["errors"].setdefault(error, {}), count)
    result["buckets"] = [buckets[key] for key in sorted(buckets)]
    return result


def markdown(report):
    totals = report["totals"]
    text = (f"# Parser coverage\n\n{totals['packages']} packages; "
            f"{totals['packages_fully_decoded']} without raw properties or decode errors. "
            f"{totals['raw_properties']} raw values of {totals['properties']} values. "
            f"Wall time: {report['wall_seconds']:.3f}s with {report['workers']} workers.\n\n"
            f"{report['scope']}\n")
    for metric in ("count", "packages_affected"):
        text += f"\n## Top 25 by {metric.replace('_', ' ')}\n\n"
        text += "| Reason | Detail | Type / struct | Export class | Raw | Packages |\n"
        text += "| --- | --- | --- | --- | ---: | ---: |\n"
        ranked = sorted(report["buckets"], key=lambda b: (-b[metric], -b["count"],
                                                         tuple(b[f] for f in BUCKET_FIELDS)))
        for bucket in ranked[:25]:
            detail = bucket["detail"].replace("|", "\\|")
            text += (f"| {bucket['reason']} | {detail} | {bucket['property_type']} / "
                     f"{bucket['struct_name']} | {bucket['export_class']} | "
                     f"{bucket['count']} | {bucket['packages_affected']} |\n")
    return text


def run_worker(executable, root, directory, paths):
    directory.mkdir()
    listing = directory / "packages.list"
    listing.write_text("\n".join(paths) + "\n", encoding="utf8")
    with (directory / "worker.log").open("w", encoding="utf8") as log:
        subprocess.run([str(executable), "--list", str(listing), "--out", str(directory),
                        "--coverage-root", str(root)], stdout=log, stderr=subprocess.STDOUT,
                       check=True, timeout=7200)
    return json.loads((directory / "census.json").read_text(encoding="utf8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--list", type=Path, required=True)
    parser.add_argument("--coverage-root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=4, choices=range(1, 9))
    args = parser.parse_args()
    paths = [line.strip() for line in args.list.read_text(encoding="utf8").splitlines()
             if line.strip() and not line.strip().startswith("#")]
    if len(set(str(Path(path).resolve()).casefold() for path in paths)) != len(paths):
        raise ValueError("parallel census requires distinct package paths")
    if not paths:
        raise ValueError("package list is empty")
    args.out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    jobs = min(args.jobs, len(paths))
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = [pool.submit(run_worker, args.executable.resolve(), args.coverage_root.resolve(),
                               args.out / f"worker-{index}",
                               paths[index::jobs])
                   for index in range(jobs)]
        reports = [future.result() for future in futures]
    report = merge(reports, time.monotonic() - started)
    (args.out / "census.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    (args.out / "census.md").write_text(markdown(report), encoding="utf8")
    with (args.out / "errors.jsonl").open("wb") as output:
        for index in range(jobs):
            with (args.out / f"worker-{index}/errors.jsonl").open("rb") as source:
                while data := source.read(1024 * 1024):
                    output.write(data)
    print(json.dumps({"wall_seconds": report["wall_seconds"], **report["totals"]}, indent=2))


if __name__ == "__main__":
    main()

"""Reproducible storage experiment, not a production Catalog adapter.

Python 3.14, duckdb==1.5.5, pyarrow==23.0.1. Run with --help.
Uses only deterministic generic data. Results include all samples and content hashes.
Application-cold means new files; OS caches are not flushed. No production caches are read.
"""

import argparse
import hashlib
import json
import platform
import sqlite3
import statistics
import time
from pathlib import Path

import duckdb
import pyarrow as pa


def ms():
    return time.perf_counter_ns() / 1_000_000


def batches(count):
    for start in range(0, count, 1024):
        rows = []
        for i in range(start, min(start + 1024, count)):
            classes = ["/Script/Core.Object", "/Script/Engine.Asset", f"/Script/Generic.Type{i % 251}"]
            if i % 5 == 0:
                classes.append("/Script/Engine.Resource")
            if i % 23 == 0:
                classes.append("/Script/Engine.Texture2D")
            if i % 113 == 0:
                classes.append("/Script/EnhancedInput.InputAction")
            if i % 227 == 0:
                classes.append("/Game/Generic.CustomInputMappingContext")
            names = [f"Property{(i * 17 + j) % 4096}" for j in range(32)]
            names += [f"Asset{i:06d}Field{j}" for j in range(9)]
            if i % 41 == 0:
                names.append("TextProperty")
            if i % 7 == 0:
                names.append("CommonProperty")
            path = f"Content/Generic/Asset{i:06d}." + ("umap" if i % 211 == 0 else "uasset")
            rows.append({"id": i, "relative_path": path, "kind": 0,
                         "size": 4096 + i % 65536, "modified_nanos": 1_700_000_000_000_000_000 + i,
                         "is_map": i % 211 == 0, "profile_version": 1,
                         "package_name": f"/Game/Generic/Asset{i:06d}", "failure_code": None,
                         "classes": classes, "class_names": [c.rsplit(".", 1)[-1] for c in classes],
                         "serialized_names": names})
        yield rows


def open_db(engine, path, readonly=True):
    if engine.startswith("duckdb"):
        return duckdb.connect(str(path), read_only=readonly, config={"threads": 4})
    c = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) if readonly else sqlite3.connect(path)
    c.execute("PRAGMA cache_size=-65536")
    return c


def build(root, count):
    paths = {e: root / (e + (".duckdb" if e == "duckdb" else ".sqlite"))
             for e in ("duckdb", "sqlite_jsonb", "sqlite_postings")}
    for path in paths.values():
        if path.exists():
            raise RuntimeError(f"Use a fresh output directory; refusing to replace {path}")
    d = duckdb.connect(config={"threads": 4, "memory_limit": "384MB"})
    escaped = str(paths["duckdb"]).replace("'", "''")
    d.execute(f"ATTACH '{escaped}' AS catalog (ROW_GROUP_SIZE 32768)")
    d.execute("USE catalog")
    d.execute("CREATE TABLE entry(id BIGINT, relative_path VARCHAR, kind UTINYINT, size UBIGINT, "
              "modified_nanos UBIGINT, is_map BOOLEAN, profile_version UINTEGER, package_name VARCHAR, "
              "failure_code VARCHAR, classes VARCHAR[], class_names VARCHAR[], serialized_names VARCHAR[])")
    sqlites = {e: open_db(e, p, False) for e, p in paths.items() if e != "duckdb"}
    for e, c in sqlites.items():
        c.execute("PRAGMA journal_mode=DELETE")
        c.execute("PRAGMA synchronous=FULL")
        c.execute("CREATE TABLE entry(id INTEGER PRIMARY KEY, relative_path TEXT UNIQUE, kind INTEGER, "
                  "size INTEGER, modified_nanos INTEGER, is_map INTEGER, profile_version INTEGER, "
                  "package_name TEXT, failure_code TEXT, classes BLOB, class_names BLOB, serialized_names BLOB)")
        c.execute("CREATE INDEX maps ON entry(relative_path) WHERE is_map=1")
        if e == "sqlite_postings":
            c.execute("CREATE TABLE posting(kind INTEGER, value TEXT, id INTEGER, PRIMARY KEY(kind,value,id)) WITHOUT ROWID")
    times = {e: {"ingest_ms": 0, "finalize_ms": 0} for e in paths}
    preparation = 0
    totals = {"packages": count, "classes": 0, "names": 0}
    for rows in batches(count):
        t = ms()
        arrow = pa.Table.from_pylist(rows)
        values = [(r["id"], r["relative_path"], r["kind"], r["size"], r["modified_nanos"], r["is_map"],
                   r["profile_version"], r["package_name"], r["failure_code"], json.dumps(r["classes"]),
                   json.dumps(r["class_names"]), json.dumps(r["serialized_names"])) for r in rows]
        postings = [(kind, value, r["id"]) for r in rows
                    for kind, values_ in ((0, r["classes"]), (1, r["serialized_names"]),
                                          (2, [s[::-1] for s in r["class_names"]]))
                    for value in set(values_)]
        preparation += ms() - t
        totals["classes"] += sum(len(r["classes"]) for r in rows)
        totals["names"] += sum(len(r["serialized_names"]) for r in rows)
        t = ms()
        d.register("batch", arrow)
        d.execute("INSERT INTO entry SELECT * FROM batch")
        d.unregister("batch")
        times["duckdb"]["ingest_ms"] += ms() - t
        for e, c in sqlites.items():
            t = ms()
            c.executemany("INSERT INTO entry VALUES (?,?,?,?,?,?,?,?,?,jsonb(?),jsonb(?),jsonb(?))", values)
            if e == "sqlite_postings":
                c.executemany("INSERT INTO posting VALUES (?,?,?)", postings)
            times[e]["ingest_ms"] += ms() - t
    for e, c in [("duckdb", d), *sqlites.items()]:
        t = ms()
        if e == "duckdb":
            c.execute("CHECKPOINT")
        else:
            c.execute("ANALYZE")
            c.commit()
        c.close()
        times[e]["finalize_ms"] = ms() - t
        times[e]["bytes"] = paths[e].stat().st_size
        times[e]["total_ms"] = times[e]["ingest_ms"] + times[e]["finalize_ms"]
    return paths, times, totals, preparation


QUERIES = [("maps", None), ("exact", "/Script/Engine.Texture2D"),
           ("prefix", "/Script/EnhancedInput."), ("suffix", "InputMappingContext"),
           ("name", "TextProperty"), ("name", "MissingProperty"), ("name", "CommonProperty")]


def query_sql(engine, kind, value):
    if kind == "maps":
        return "SELECT relative_path, package_name FROM entry WHERE relative_path>? AND is_map=1 ORDER BY relative_path LIMIT ?", []
    if engine.startswith("duckdb"):
        predicate = {"exact": "list_has_any(classes, [?])", "name": "list_has_any(serialized_names, [?])",
                     "prefix": "list_bool_or(list_transform(classes, x -> starts_with(x, ?)))",
                     "suffix": "list_bool_or(list_transform(class_names, x -> ends_with(x, ?)))"}[kind]
        if engine == "duckdb_single" and kind in ("exact", "name"):
            column = "classes" if kind == "exact" else "serialized_names"
            predicate = f"list_contains({column}, ?)"
        fields = "classes, serialized_names"
    else:
        fields = "json(classes), json(serialized_names)"
        if engine == "sqlite_jsonb":
            column = {"exact": "classes", "prefix": "classes", "suffix": "class_names", "name": "serialized_names"}[kind]
            compare = {"exact": "value=?", "name": "value=?", "prefix": "substr(value,1,length(?))=?",
                       "suffix": "substr(value,-length(?))=?"}[kind]
            predicate = f"EXISTS (SELECT 1 FROM json_each(entry.{column}) WHERE {compare})"
            args = [value] * (2 if kind in ("prefix", "suffix") else 1)
        else:
            index_kind = {"exact": 0, "prefix": 0, "name": 1, "suffix": 2}[kind]
            if kind in ("prefix", "suffix"):
                low = value[::-1] if kind == "suffix" else value
                high = low[:-1] + chr(ord(low[-1]) + 1)
                condition, args = "value>=? AND value<?", [low, high]
            else:
                condition, args = "value=?", [value]
            if engine == "sqlite_postings_seek":
                # IDs follow path order within this immutable snapshot. Translate arbitrary
                # path cursors, select a bounded ID page, then hydrate only that page.
                return ("WITH page AS (SELECT DISTINCT id FROM posting WHERE id > "
                        "COALESCE((SELECT id FROM entry WHERE relative_path<=? ORDER BY relative_path DESC LIMIT 1),-1) "
                        f"AND kind={index_kind} AND {condition} ORDER BY id LIMIT ?) "
                        f"SELECT relative_path, package_name, {fields} FROM entry JOIN page USING(id) ORDER BY relative_path", args)
            predicate = f"id IN (SELECT id FROM posting WHERE kind={index_kind} AND {condition})"
    if engine == "duckdb_page":
        sql = (f"WITH page AS MATERIALIZED (SELECT relative_path FROM entry WHERE relative_path>? AND kind=0 "
               f"AND ({predicate}) ORDER BY relative_path LIMIT ?) SELECT relative_path, package_name, {fields} "
               "FROM entry JOIN page USING(relative_path) ORDER BY relative_path")
    else:
        sql = f"SELECT relative_path, package_name, {fields} FROM entry WHERE relative_path>? AND kind=0 AND ({predicate}) ORDER BY relative_path LIMIT ?"
    return sql, [value] if engine.startswith("duckdb") else args


def workload(engine, path, reopen=False):
    connection = None
    start = ms()
    results = []
    for kind, value in QUERIES:
        t = ms()
        cursor, count, pages = "", 0, 0
        digest = hashlib.sha256()
        sql, args = query_sql(engine, kind, value)
        while True:
            if connection is None:
                connection = open_db(engine, path)
            rows = connection.execute(sql, [cursor, *args, 1025]).fetchall()
            hydrated = [(r[0], r[1], json.loads(r[2]), json.loads(r[3]))
                        if not engine.startswith("duckdb") and kind != "maps" else r for r in rows]
            more = len(hydrated) > 1024
            page = hydrated[:1024]
            digest.update(json.dumps(page, separators=(",", ":"), ensure_ascii=False).encode())
            count += len(page)
            pages += 1
            if reopen:
                connection.close()
                connection = None
            if not more:
                break
            cursor = page[-1][0]
        results.append({"kind": kind, "value": value, "ms": ms() - t, "items": count,
                        "pages": pages, "sha256": digest.hexdigest()})
    if connection is not None:
        connection.close()
    return {"total_ms": ms() - start, "queries": results}


def write_native_spec(paths, output):
    engines = []
    for engine, path in paths.items():
        queries = []
        for kind, value in QUERIES:
            sql, args = query_sql(engine, kind, value)
            queries.append({"kind": kind, "sql": sql, "args": args})
        engines.append({"name": engine, "path": str(path), "queries": queries})
    (output / "native-query-spec.json").write_text(json.dumps({"engines": engines}, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--packages", type=int, default=185676)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--reuse", action="store_true", help="Rerun queries on this experiment's existing synthetic databases")
    args = parser.parse_args()
    if args.packages < 1 or args.runs < 1:
        parser.error("packages and runs must be positive")
    args.output.mkdir(parents=True, exist_ok=True)
    if args.reuse:
        previous = json.loads((args.output / "results.json").read_text())
        builds, totals, preparation = previous["build"], previous["dataset"], previous["preparation_ms"]
        paths = {e: args.output / (e + (".duckdb" if e == "duckdb" else ".sqlite"))
                 for e in ("duckdb", "sqlite_jsonb", "sqlite_postings")}
    else:
        paths, builds, totals, preparation = build(args.output, args.packages)
    paths["sqlite_postings_seek"] = paths["sqlite_postings"]
    paths["duckdb_page"] = paths["duckdb"]
    paths["duckdb_single"] = paths["duckdb"]
    write_native_spec(paths, args.output)
    result = {"schema_version": 1, "scope": "synthetic storage microbenchmark, not native Catalog conformance",
              "python": platform.python_version(), "platform": platform.platform(), "duckdb": duckdb.__version__,
              "sqlite": sqlite3.sqlite_version, "pyarrow": pa.__version__, "dataset": totals,
              "preparation_ms": preparation, "build": builds, "samples": {e: [] for e in paths}}
    print(json.dumps({"dataset": totals, "build": builds}), flush=True)
    expected = None
    engines = list(paths)
    for run in range(args.runs):
        for e in engines[run % len(engines):] + engines[:run % len(engines)]:
            sample = workload(e, paths[e])
            signature = [(q["items"], q["pages"], q["sha256"]) for q in sample["queries"]]
            if expected is None:
                expected = signature
            assert signature == expected, f"Different ordered, hydrated results: {e}"
            result["samples"][e].append(sample)
            (args.output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps({"engine": e, "run": run, "ms": sample["total_ms"]}), flush=True)
    result["reopen_per_page"] = {e: workload(e, paths[e], True) for e in engines}
    for e, sample in result["reopen_per_page"].items():
        assert [(q["items"], q["pages"], q["sha256"]) for q in sample["queries"]] == expected, e
    result["median_ms"] = {e: statistics.median(s["total_ms"] for s in samples)
                           for e, samples in result["samples"].items()}
    (args.output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["median_ms"]), flush=True)


if __name__ == "__main__":
    main()

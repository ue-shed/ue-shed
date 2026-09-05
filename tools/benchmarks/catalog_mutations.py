"""Copy-on-write snapshot experiment; run after catalog_storage.py, with its output directory.

Never writes the input snapshots. SQLite uses its backup API; DuckDB uses ordered CTAS.
Checks complete hydrated query equality after one changed header and one package deletion.
Not a test of the production manifest, cancellation, concurrent publication, or recovery.
"""
import argparse
import json
from pathlib import Path

import duckdb
import sqlite3

from catalog_storage import ms, open_db, workload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    results = []
    expected = {}
    for case in ("one_header_change", "one_delete"):
        for engine in ("duckdb", "sqlite_jsonb", "sqlite_postings_seek"):
            source_name = "sqlite_postings" if engine == "sqlite_postings_seek" else engine
            suffix = ".duckdb" if engine == "duckdb" else ".sqlite"
            source = args.directory / (source_name + suffix)
            target = args.directory / (source_name + "-" + case + suffix)
            if target.exists():
                raise RuntimeError(f"Refusing to replace {target}; use a fresh experiment directory")
            start = ms()
            if engine == "duckdb":
                c = duckdb.connect(config={"threads": 4, "memory_limit": "384MB"})
                target_sql = str(target).replace("'", "''")
                source_sql = str(source).replace("'", "''")
                c.execute(f"ATTACH '{target_sql}' AS catalog (ROW_GROUP_SIZE 32768)")
                c.execute(f"ATTACH '{source_sql}' AS previous (READ_ONLY)")
                c.execute("USE catalog")
                c.execute("CREATE TABLE entry AS SELECT * FROM previous.entry ORDER BY relative_path")
            else:
                c = sqlite3.connect(target)
                with open_db(engine, source) as prior:
                    prior.backup(c)
                c.execute("PRAGMA synchronous=FULL")
            copy_ms = ms() - start
            start = ms()
            if case == "one_header_change":
                expression = "list_append(serialized_names, 'TextProperty')" if engine == "duckdb" else "jsonb_insert(serialized_names, '$[#]', 'TextProperty')"
                c.execute(f"UPDATE entry SET size=size+1, serialized_names={expression} WHERE id=1")
                if engine == "sqlite_postings_seek":
                    c.execute("INSERT INTO posting VALUES (1, 'TextProperty', 1)")
            else:
                c.execute("DELETE FROM entry WHERE id=1")
                if engine == "sqlite_postings_seek":
                    c.execute("DELETE FROM posting WHERE id=1")
            if engine == "duckdb":
                c.execute("CHECKPOINT")
            else:
                c.commit()
            c.close()
            mutation_ms = ms() - start
            sample = workload(engine, target)
            signatures = [(q["items"], q["pages"], q["sha256"]) for q in sample["queries"]]
            if case not in expected:
                expected[case] = signatures
            assert signatures == expected[case], f"Changed results differ: {engine}, {case}"
            row = {"engine": engine, "case": case, "copy_ms": copy_ms, "mutation_commit_ms": mutation_ms,
                   "total_ms": copy_ms + mutation_ms, "bytes": target.stat().st_size, "query": sample}
            results.append(row)
            print(json.dumps({k: v for k, v in row.items() if k != "query"}), flush=True)
            (args.directory / "mutations.json").write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()

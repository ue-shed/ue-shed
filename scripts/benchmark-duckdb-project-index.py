# /// script
# requires-python = ">=3.12"
# dependencies = ["duckdb==1.5.5"]
# ///
"""Compare private DuckDB Catalog shapes using an existing disposable SQLite Catalog.

The JSON output contains aggregate timings, row counts, and file sizes only. It deliberately omits
source paths, project identities, package paths, class names, and serialized names.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import duckdb

PAGE_SIZE = 1_024
QUERY_VALUES = {
    "exact_classes": [
        "/Script/Engine.DataTable",
        "/Script/Engine.CompositeDataTable",
        "/Script/Engine.StringTable",
        "/Script/Engine.Texture2D",
    ],
    "class_prefixes": ["/Script/EnhancedInput."],
    "class_name_suffixes": ["InputAction", "InputMappingContext"],
    "serialized_names": ["TextProperty"],
}


def elapsed_ms(operation: Callable[[], Any]) -> tuple[float, Any]:
    started = time.perf_counter()
    result = operation()
    return round((time.perf_counter() - started) * 1_000, 3), result


def remove_database(path: Path) -> None:
    for candidate in (path, Path(f"{path}.wal")):
        if candidate.exists():
            candidate.unlink()


def connect(
    path: Path, *, read_only: bool = False, threads: int = 16
) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(
        str(path), read_only=read_only, config={"threads": str(threads)}
    )


def attach_sqlite(connection: duckdb.DuckDBPyConnection, source: Path) -> None:
    escaped = str(source).replace("'", "''")
    connection.execute("INSTALL sqlite; LOAD sqlite")
    connection.execute(f"ATTACH '{escaped}' AS source (TYPE sqlite, READ_ONLY)")


def create_normalized(source: Path, target: Path) -> dict[str, Any]:
    remove_database(target)
    connection = connect(target)
    attach_sqlite(connection, source)

    def build() -> None:
        connection.execute(
            """
            CREATE TABLE entry AS
            SELECT id, relative_path, kind, size, modified_nanos, is_map, profile_version,
                   package_name, failure_code
            FROM source.entry
            ORDER BY relative_path;
            CREATE TABLE entry_class AS
            SELECT entry_id, ordinal, class_path, reverse(class_name_reversed) AS class_name
            FROM source.entry_class
            ORDER BY entry_id, ordinal;
            CREATE TABLE entry_name AS
            SELECT entry_id, ordinal, serialized_name
            FROM source.entry_name
            ORDER BY entry_id, ordinal;
            """
        )
        connection.execute("CHECKPOINT")

    build_ms, _ = elapsed_ms(build)
    counts = connection.execute(
        "SELECT (SELECT count(*) FROM entry), (SELECT count(*) FROM entry_class), "
        "(SELECT count(*) FROM entry_name)"
    ).fetchone()
    connection.close()
    return {
        "buildMs": build_ms,
        "bytes": target.stat().st_size,
        "rows": {"entries": counts[0], "classes": counts[1], "names": counts[2]},
    }


def create_nested(
    normalized: Path, target: Path, row_group_size: int
) -> dict[str, Any]:
    remove_database(target)
    bootstrap = duckdb.connect()
    escaped_target = str(target).replace("'", "''")
    bootstrap.execute(
        f"ATTACH '{escaped_target}' AS target (ROW_GROUP_SIZE {row_group_size}, "
        "STORAGE_VERSION 'v1.5.0')"
    )
    escaped_source = str(normalized).replace("'", "''")
    bootstrap.execute(f"ATTACH '{escaped_source}' AS source (READ_ONLY)")

    def build() -> None:
        bootstrap.execute(
            """
            CREATE TABLE target.entry AS
            WITH classes AS (
                SELECT entry_id,
                       list(class_path ORDER BY ordinal) AS classes,
                       list(class_name ORDER BY ordinal) AS class_names
                FROM source.entry_class
                GROUP BY entry_id
            ), names AS (
                SELECT entry_id, list(serialized_name ORDER BY ordinal) AS serialized_names
                FROM source.entry_name
                GROUP BY entry_id
            )
            SELECT e.id, e.relative_path, e.kind, e.size, e.modified_nanos, e.is_map,
                   e.profile_version, e.package_name, e.failure_code,
                   coalesce(c.classes, []::VARCHAR[]) AS classes,
                   coalesce(c.class_names, []::VARCHAR[]) AS class_names,
                   coalesce(n.serialized_names, []::VARCHAR[]) AS serialized_names
            FROM source.entry e
            LEFT JOIN classes c ON c.entry_id = e.id
            LEFT JOIN names n ON n.entry_id = e.id
            ORDER BY e.relative_path
            """
        )
        bootstrap.execute("CHECKPOINT target")

    build_ms, _ = elapsed_ms(build)
    counts = bootstrap.execute(
        "SELECT count(*), sum(length(classes)), sum(length(serialized_names)) FROM target.entry"
    ).fetchone()
    bootstrap.close()
    return {
        "buildMs": build_ms,
        "bytes": target.stat().st_size,
        "rowGroupSize": row_group_size,
        "rows": {"entries": counts[0], "classes": counts[1], "names": counts[2]},
    }


def page_query(
    connection: duckdb.DuckDBPyConnection,
    model: str,
    route: str,
    cursor: str,
) -> list[tuple[Any, ...]]:
    values = QUERY_VALUES.get(route, [])
    placeholders = ", ".join("?" for _ in values)
    if model == "nested":
        predicates = {
            "maps": "is_map = 1",
            "exact_classes": f"list_has_any(classes, [{placeholders}])",
            "class_prefixes": "list_bool_or(list_transform(classes, x -> starts_with(x, ?)))",
            "class_name_suffixes": (
                "list_bool_or(list_transform(class_names, x -> "
                "ends_with(x, ?) OR ends_with(x, ?)))"
            ),
            "serialized_names": "list_contains(serialized_names, ?)",
        }
        parameters = [cursor, *values, PAGE_SIZE + 1]
        return connection.execute(
            "SELECT relative_path, package_name, classes, serialized_names FROM entry "
            f"WHERE relative_path > ? AND {predicates[route]} "
            "ORDER BY relative_path LIMIT ?",
            parameters,
        ).fetchall()

    predicates = {
        "maps": "e.is_map = 1",
        "exact_classes": (
            "e.id IN (SELECT entry_id FROM entry_class "
            f"WHERE class_path IN ({placeholders}))"
        ),
        "class_prefixes": (
            "e.id IN (SELECT entry_id FROM entry_class WHERE starts_with(class_path, ?))"
        ),
        "class_name_suffixes": (
            "e.id IN (SELECT entry_id FROM entry_class WHERE "
            "ends_with(class_name, ?) OR ends_with(class_name, ?))"
        ),
        "serialized_names": (
            "e.id IN (SELECT entry_id FROM entry_name WHERE serialized_name = ?)"
        ),
    }
    parameters = [cursor, *values, PAGE_SIZE + 1]
    return connection.execute(
        "WITH page AS MATERIALIZED ("
        "SELECT e.id, e.relative_path, e.package_name FROM entry e "
        f"WHERE e.relative_path > ? AND {predicates[route]} "
        "ORDER BY e.relative_path LIMIT ?"
        "), classes AS ("
        "SELECT c.entry_id, list(c.class_path ORDER BY c.ordinal) AS values "
        "FROM entry_class c SEMI JOIN page p ON p.id = c.entry_id GROUP BY c.entry_id"
        "), names AS ("
        "SELECT n.entry_id, list(n.serialized_name ORDER BY n.ordinal) AS values "
        "FROM entry_name n SEMI JOIN page p ON p.id = n.entry_id GROUP BY n.entry_id"
        ") SELECT p.relative_path, p.package_name, "
        "coalesce(c.values, []::VARCHAR[]), coalesce(n.values, []::VARCHAR[]) "
        "FROM page p LEFT JOIN classes c ON c.entry_id = p.id "
        "LEFT JOIN names n ON n.entry_id = p.id ORDER BY p.relative_path",
        parameters,
    ).fetchall()


def query_workload(
    path: Path,
    model: str,
    runs: int = 3,
    threads: int = 16,
    reopen_each_page: bool = False,
) -> dict[str, Any]:
    samples: list[float] = []
    pages = 0
    items = 0
    for _ in range(runs):
        connection = (
            None if reopen_each_page else connect(path, read_only=True, threads=threads)
        )

        def run(
            active_connection: duckdb.DuckDBPyConnection | None = connection,
        ) -> tuple[int, int]:
            run_pages = 0
            run_items = 0
            for route in (
                "maps",
                "exact_classes",
                "class_prefixes",
                "class_name_suffixes",
                "serialized_names",
            ):
                cursor = ""
                while True:
                    page_connection = (
                        connect(path, read_only=True, threads=threads)
                        if reopen_each_page
                        else active_connection
                    )
                    assert page_connection is not None
                    rows = page_query(page_connection, model, route, cursor)
                    if reopen_each_page:
                        page_connection.close()
                    run_pages += 1
                    page = rows[:PAGE_SIZE]
                    run_items += len(page)
                    if len(rows) <= PAGE_SIZE:
                        break
                    cursor = page[-1][0]
            return run_pages, run_items

        sample_ms, (pages, items) = elapsed_ms(run)
        samples.append(sample_ms)
        if connection is not None:
            connection.close()
    return {
        "items": items,
        "pages": pages,
        "samplesMs": samples,
        "meanMs": round(statistics.mean(samples), 3),
        "p50Ms": round(statistics.median(samples), 3),
        "reopenEachPage": reopen_each_page,
        "threads": threads,
    }


def clone_nested(
    source: Path,
    target: Path,
    row_group_size: int,
    *,
    ordered: bool = True,
) -> dict[str, Any]:
    remove_database(target)
    connection = duckdb.connect()
    escaped_source = str(source).replace("'", "''")
    escaped_target = str(target).replace("'", "''")
    connection.execute(f"ATTACH '{escaped_source}' AS source (READ_ONLY)")
    connection.execute(
        f"ATTACH '{escaped_target}' AS target (ROW_GROUP_SIZE {row_group_size}, "
        "STORAGE_VERSION 'v1.5.0')"
    )
    order = "relative_path" if ordered else "hash(relative_path)"
    build_ms, _ = elapsed_ms(
        lambda: connection.execute(
            f"CREATE TABLE target.entry AS SELECT * FROM source.entry ORDER BY {order}"
        )
    )
    before_checkpoint = sum(
        candidate.stat().st_size
        for candidate in (target, Path(f"{target}.wal"))
        if candidate.exists()
    )
    checkpoint_ms, _ = elapsed_ms(lambda: connection.execute("CHECKPOINT target"))
    after_checkpoint = sum(
        candidate.stat().st_size
        for candidate in (target, Path(f"{target}.wal"))
        if candidate.exists()
    )
    connection.close()
    return {
        "buildMs": build_ms,
        "bytesBeforeCheckpoint": before_checkpoint,
        "checkpointMs": checkpoint_ms,
        "bytesAfterCheckpoint": after_checkpoint,
        "orderedByPath": ordered,
        "rowGroupSize": row_group_size,
    }


def rebuild_generation(source: Path, target: Path) -> dict[str, Any]:
    remove_database(target)
    connection = duckdb.connect()
    escaped_source = str(source).replace("'", "''")
    escaped_target = str(target).replace("'", "''")
    connection.execute(f"ATTACH '{escaped_source}' AS prior (READ_ONLY)")
    connection.execute(
        f"ATTACH '{escaped_target}' AS next (ROW_GROUP_SIZE 16384, STORAGE_VERSION 'v1.5.0')"
    )

    def build() -> None:
        connection.execute("CREATE TABLE next.entry AS SELECT * FROM prior.entry")
        connection.execute("CHECKPOINT next")

    build_ms, _ = elapsed_ms(build)
    connection.close()
    return {"buildMs": build_ms, "bytes": target.stat().st_size}


def existing_model(
    path: Path, model: str, row_group_size: int | None = None
) -> dict[str, Any]:
    connection = connect(path, read_only=True)
    if model == "nested":
        counts = connection.execute(
            "SELECT count(*), sum(length(classes)), sum(length(serialized_names)) FROM entry"
        ).fetchone()
    else:
        counts = connection.execute(
            "SELECT (SELECT count(*) FROM entry), (SELECT count(*) FROM entry_class), "
            "(SELECT count(*) FROM entry_name)"
        ).fetchone()
    connection.close()
    result: dict[str, Any] = {
        "buildMs": None,
        "bytes": path.stat().st_size,
        "rows": {"entries": counts[0], "classes": counts[1], "names": counts[2]},
    }
    if row_group_size is not None:
        result["rowGroupSize"] = row_group_size
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-sqlite", required=True, type=Path)
    parser.add_argument("--working-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--reuse-models", action="store_true")
    options = parser.parse_args()
    options.working_dir.mkdir(parents=True, exist_ok=True)

    normalized = options.working_dir / "normalized.duckdb"
    nested_default = options.working_dir / "nested-default.duckdb"
    nested_small_groups = options.working_dir / "nested-16384.duckdb"
    next_generation = options.working_dir / "nested-next-generation.duckdb"

    if options.reuse_models:
        print("reusing existing models", flush=True)
        normalized_result = existing_model(normalized, "normalized")
        nested_default_result = existing_model(nested_default, "nested", 122_880)
        nested_small_result = existing_model(nested_small_groups, "nested", 16_384)
    else:
        print("building normalized model", flush=True)
        normalized_result = create_normalized(options.source_sqlite, normalized)
        print("building nested model with default row groups", flush=True)
        nested_default_result = create_nested(normalized, nested_default, 122_880)
        print("building nested model with 16,384-row groups", flush=True)
        nested_small_result = create_nested(normalized, nested_small_groups, 16_384)
    result = {
        "schemaVersion": 1,
        "duckdbVersion": duckdb.__version__,
        "sourceBytes": options.source_sqlite.stat().st_size,
        "models": {
            "normalized": normalized_result,
            "nestedDefault": nested_default_result,
            "nested16384": nested_small_result,
        },
    }
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps(result, indent="\t") + "\n", encoding="utf-8")
    print("querying normalized model", flush=True)
    result["models"]["normalized"]["query"] = query_workload(normalized, "normalized")
    print("querying nested default model", flush=True)
    result["models"]["nestedDefault"]["query"] = query_workload(
        nested_default, "nested"
    )
    print("querying nested small-row-group model", flush=True)
    result["models"]["nested16384"]["query"] = query_workload(
        nested_small_groups, "nested"
    )
    print("testing row-group, ordering, checkpoint, and thread variants", flush=True)
    tuning: dict[str, Any] = {"rowGroups": {}, "threads": {}}
    for row_group_size in (2_048, 8_192, 32_768):
        variant_path = options.working_dir / f"nested-{row_group_size}.duckdb"
        variant = clone_nested(
            nested_small_groups, variant_path, row_group_size, ordered=True
        )
        variant["query"] = query_workload(variant_path, "nested")
        tuning["rowGroups"][str(row_group_size)] = variant
    unordered_path = options.working_dir / "nested-16384-unordered.duckdb"
    tuning["unordered"] = clone_nested(
        nested_small_groups, unordered_path, 16_384, ordered=False
    )
    tuning["unordered"]["query"] = query_workload(unordered_path, "nested")
    for thread_count in (1, 4, 8, 16, 32):
        tuning["threads"][str(thread_count)] = query_workload(
            nested_small_groups, "nested", threads=thread_count
        )
    tuning["reopenEachPage"] = query_workload(
        nested_small_groups, "nested", reopen_each_page=True
    )
    result["tuning"] = tuning
    print("copying immutable generation", flush=True)
    result["immutableGenerationCopy"] = rebuild_generation(
        nested_small_groups, next_generation
    )
    options.output.write_text(json.dumps(result, indent="\t") + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

"""A stock Python SQLite consumer: complete evidence and a new SQL report, no UE Shed runtime."""
import functools
import json
import pathlib
import sqlite3
import sys

path = pathlib.Path(sys.argv[1]).resolve()
db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row


def text(raw):
    return raw.decode("utf-16-le", errors="surrogatepass")


layouts = {}
for row in db.execute("SELECT * FROM layout_field ORDER BY layout,position"):
    layouts.setdefault(row["layout"], []).append(text(row["key"]))
for row in db.execute("SELECT id FROM record_layout"):
    layouts.setdefault(row["id"], [])


@functools.lru_cache(maxsize=100000)
def value(ident):
    node = db.execute("SELECT * FROM value_node WHERE id=?", (ident,)).fetchone()
    if node is None:
        raise ValueError("Missing retained value")
    kind = node["kind"]
    if kind == 0:
        return None
    if kind == 1:
        return text(node["text"])
    if kind == 2:
        number = node["number"]
        return int(number) if number == int(number) else number
    if kind == 3:
        return bool(node["number"])
    if kind == 4:
        return [value(row[0]) for row in db.execute("SELECT value FROM array_item WHERE owner=? ORDER BY position", (ident,))]
    if kind == 5:
        layout = int(node["layout"])
        row = db.execute(f"SELECT * FROM record_{layout} WHERE id=?", (ident,)).fetchone()
        return {key: value(row[f"f{i}"]) for i, key in enumerate(layouts[layout])}
    raise ValueError("Unknown retained kind")


first = db.execute("SELECT raw FROM row_data WHERE kind='line' ORDER BY rank LIMIT 1").fetchone()
report = [dict(row) for row in db.execute("SELECT audience,count(*) AS lines,min(characters) AS shortest,max(characters) AS longest,sum(words) AS sourceWords FROM query_row WHERE kind='line' AND visible=1 GROUP BY audience ORDER BY audience")]
result = {"sqlite": sqlite3.sqlite_version, "lineCount": db.execute("SELECT count(*) FROM row_data WHERE kind='line'").fetchone()[0], "firstFullLine": value(first[0]) if first else None, "audienceLengthReport": report}
print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
db.close()

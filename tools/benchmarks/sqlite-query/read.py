"""Read the spike's SQLite database without UE Shed, Rust, or SQLite extensions."""
import json
import sqlite3
import sys
from pathlib import Path

with sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + "?mode=ro", uri=True) as db:
    rows = []
    for identity, namespace, key, source in db.execute(
        "SELECT l.id,n.utf16,k.utf16,s.utf16 FROM line l "
        "LEFT JOIN string n ON n.id=l.namespace LEFT JOIN string k ON k.id=l.key "
        "JOIN string s ON s.id=l.source ORDER BY l.rank LIMIT 50"
    ):
        decode = lambda value: value.decode("utf-16-be", "surrogatepass")
        rows.append({
            "id": identity,
            "identity": None if namespace is None else {"namespace": decode(namespace), "key": decode(key)},
            "source": decode(source),
        })
    distribution = [{"utf16Length": length, "n": count} for length, count in db.execute(
        "SELECT length(s.utf16)/2,count(*) FROM line l JOIN string s ON s.id=l.source "
        "GROUP BY length(s.utf16)/2 ORDER BY length(s.utf16)/2"
    )]
    print(json.dumps({"sqlite": sqlite3.sqlite_version, "rows": rows, "lengthDistribution": distribution,
                      "total": db.execute("SELECT count(*) FROM text_lines").fetchone()[0]},
                     ensure_ascii=True, separators=(",", ":")))

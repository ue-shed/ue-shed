"""Prepare an isolated native SQLite Catalog experiment from the current Rust tree.

No production Cargo files or backend selection are changed. Output must be a new directory.
"""
import argparse
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--serialized-names", choices=["postings", "scan"], default="postings")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ["Cargo.toml", "Cargo.lock"]:
    shutil.copy2(root / name, out / name)
shutil.copytree(root / "crates", out / "crates")
shutil.copytree(root / "fixtures", out / "fixtures")
shutil.copytree(root / "packages/protocol/contracts", out / "packages/protocol/contracts")
source = (root / "tools/benchmarks/catalog-manifest-research.rs").read_text(encoding="utf-8")
types, helpers = source.split("// @HELPERS@")
helpers = helpers.replace("duckdb::Error", "rusqlite::Error").replace("AccessMode::ReadOnly", "OpenFlags::SQLITE_OPEN_READ_ONLY").replace("DuckDB", "SQLite").replace(".duckdb", ".sqlite")
template = (root / "tools/benchmarks/sqlite-catalog.rs").read_text(encoding="utf-8")
template = template.replace("DuckdbCatalog", "SqliteCatalog")
module = template.replace("// @MANIFEST_TYPES@", types).replace("// @MANIFEST_HELPERS@", helpers)
if args.serialized_names == "scan":
    module = module.replace("const INDEX_SERIALIZED_NAMES: bool = true;", "const INDEX_SERIALIZED_NAMES: bool = false;")
(out / "crates/uasset-io/src/direct_executor/catalog_sqlite.rs").write_text(module, encoding="utf-8")
manifest = out / "crates/uasset-io/Cargo.toml"
text = manifest.read_text(encoding="utf-8")
text, count = re.subn(r'^rusqlite = .*$', 'rusqlite = { version = "=0.37.0", default-features = false, features = ["bundled"] }', text, flags=re.M)
assert count == 1
manifest.write_text(text, encoding="utf-8")
print(out)

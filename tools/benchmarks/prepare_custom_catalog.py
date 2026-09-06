"""Compile a binary Catalog prototype against the unchanged production pipeline.

Output must be new. SQLite is retained only as a test oracle in the isolated workspace.
The production workspace and backend selection are not changed.
"""
import argparse
from pathlib import Path
import re
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--version", choices=["v1", "v2"], default="v1")
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ["Cargo.toml", "Cargo.lock"]:
    shutil.copy2(root / name, out / name)
for name in ["crates", "fixtures", "packages/protocol/contracts"]:
    shutil.copytree(root / name, out / name, ignore=shutil.ignore_patterns("target", "node_modules", ".git", "__pycache__"))

scaffold = (root / "tools/benchmarks/catalog-manifest-research.rs").read_text(encoding="utf-8")
types, helpers = scaffold.split("// @HELPERS@")
a = helpers.index("fn verify_snapshot(")
b = helpers.index("fn require_manifest(", a) if "fn require_manifest(" in helpers[a:] else helpers.index("fn require_manifest<'", a)
helpers = helpers[:a] + helpers[b:]
helpers = helpers[:helpers.index("fn storage_error(")]
helpers = helpers.replace("DuckDB", "binary").replace(".duckdb", ".catalog")
if args.version == "v2":
    start = helpers.index("fn quarantine_directory(")
    end = helpers.index("fn snapshot_file_name(", start)
    helpers = helpers[:start] + helpers[end:]
template = "custom-catalog.rs" if args.version == "v1" else "custom-catalog-v2.rs"
module = (root / "tools/benchmarks" / template).read_text(encoding="utf-8")
module = module.replace("// @MANIFEST_TYPES@", types).replace("// @MANIFEST_HELPERS@", helpers)
(out / "crates/uasset-io/src/direct_executor/catalog_custom.rs").write_text(module, encoding="utf-8")
p = out / "crates/uasset-io/src/direct_executor.rs"
oracle_cfg = '#[cfg(all(test, feature = "sqlite-oracle"))]' if args.version == "v2" else '#[cfg(test)]'
declarations = p.read_text(encoding="utf-8")
declarations = re.sub(r'#\[cfg\(all\(test, feature = "catalog-oracle"\)\)\]\n', '', declarations)
declarations = declarations.replace('mod catalog_binary;\n', '')
p.write_text(declarations.replace("mod catalog_sqlite;", oracle_cfg + "\nmod catalog_sqlite;\nmod catalog_custom;"), encoding="utf-8")
p = out / "crates/uasset-io/src/direct_executor/project_index_io.rs"
s = p.read_text(encoding="utf-8").replace("catalog_sqlite::SqliteCatalog", "catalog_custom::CustomCatalog").replace("catalog_binary::BinaryCatalog", "catalog_custom::CustomCatalog")
p.write_text(s.replace("SqliteCatalog", "CustomCatalog").replace("BinaryCatalog", "CustomCatalog"), encoding="utf-8")
p = out / "crates/uasset-io/Cargo.toml"
s = p.read_text(encoding="utf-8")
dependency = re.search(r'^rusqlite = \{[^}]*\}', s, re.M).group(0)
s = s.replace(dependency + '\n', '')
dependency = ' '.join(dependency.split()).replace(', optional = true', '')
s = re.sub(r'^crc32fast = .*\n', '', s, flags=re.M)
s = re.sub(r'\n\[features\]\ncatalog-oracle = \["dep:rusqlite"\]\n', '\n', s)
if args.version == "v2":
    s = s.replace('[dependencies]\n', '[dependencies]\n' + dependency[:-1] + ', optional = true }\n')
    s += '\n[features]\nsqlite-oracle = ["dep:rusqlite"]\n'
    s = s.replace('[dependencies]\n', '[dependencies]\ncrc32fast = "=1.5.0"\n')
    s = s.replace('rust-version = "1.88"', 'rust-version = "1.89"')
else:
    s += "\n[dev-dependencies]\n" + dependency + "\n"
p.write_text(s, encoding="utf-8")
print(out)

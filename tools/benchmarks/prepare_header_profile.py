"""Create an isolated, instrumented native reader; production has no profiling hooks.

Stage totals are elapsed nanoseconds summed per worker, not CPU or wall-clock totals.
Use the ordinary project benchmark for uninstrumented before/after measurements.
"""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ["Cargo.toml", "Cargo.lock"]:
    shutil.copy2(root / name, out / name)
for name in ["crates", "packages/protocol/contracts"]:
    shutil.copytree(root / name, out / name, ignore=shutil.ignore_patterns("target", "node_modules", ".git", "__pycache__"))
# Unreal-generated Intermediate/Saved files can dwarf the fixture itself. Only tracked fixture
# inputs belong in a disposable Rust build; read their current worktree contents.
for name in subprocess.check_output(["git", "ls-files", "-z", "--", "fixtures"], cwd=root).decode().split("\0"):
    if name and (root / name).is_file():
        destination = out / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, destination)

profile = '''
pub mod header_profile {
    use std::{cell::RefCell, time::Instant};
    const LABELS: [&str; 22] = ["summary", "names", "soft_paths", "imports", "exports", "resolve_paths", "materialize_paths", "open_prefix", "grow_header", "evidence", "send_wait", "receive_wait", "sink", "signature", "discovery", "comparison", "records_postings", "strings_lexicon", "posting_encoding", "section_checksums", "write_sync", "verify_snapshot"];
    thread_local! { static TOTALS: RefCell<[(u64,u64);22]> = const { RefCell::new([(0,0);22]) }; }
    pub struct Stage(usize, Instant);
    impl Stage { pub fn new(index: usize) -> Self { Self(index, Instant::now()) } }
    impl Drop for Stage { fn drop(&mut self) { let ns = self.1.elapsed().as_nanos() as u64; TOTALS.with_borrow_mut(|v| { v[self.0].0 += ns; v[self.0].1 += 1; }); } }
    pub fn report() { TOTALS.with_borrow_mut(|v| { for (label, (ns,count)) in LABELS.iter().zip(v.iter()) { if *count > 0 { eprintln!("HEADER_PROFILE {label} {ns} {count}"); } } *v = [(0,0);22]; }); }
}
'''
p = out / "crates/uasset-parser/src/lib.rs"
p.write_text(p.read_text(encoding="utf-8") + profile, encoding="utf-8")
p = out / "crates/uasset-parser/src/package.rs"
s = p.read_text(encoding="utf-8")
for index, expr in enumerate([
    "PackageSummary::parse_with_file_len(source, file_len)?",
    "read_name_map(&mut reader, &summary)?",
    "read_soft_object_path_list(source, &summary, &names)?",
    "read_import_map(&mut reader, &summary, &names)?",
    "read_export_map(&mut reader, &summary, &names, file_len)?",
    "resolve_package_paths(&summary.package_name, &names, &imports, &exports)?",
]):
    assert expr in s, expr
    s = s.replace(expr, "{ let _stage = crate::header_profile::Stage::new(" + str(index) + "); " + expr + " }", 1)
s = s.replace("        for (import, object_path) in imports.iter_mut()", "        let materialize = crate::header_profile::Stage::new(6);\n        for (import, object_path) in imports.iter_mut()", 1)
s = s.replace("        Ok(Self {\n            summary,", "        drop(materialize);\n        Ok(Self {\n            summary,", 1)
p.write_text(s, encoding="utf-8")
p = out / "crates/uasset-io/src/direct_executor/scanner.rs"
s = p.read_text(encoding="utf-8")
s = s.replace("use uasset_parser::PackageSummary;", "use uasset_parser::{PackageSummary, header_profile::{Stage, report}};")
s = s.replace("        let classes = bounded_header_values(", "        let _evidence = Stage::new(9);\n        let classes = bounded_header_values(", 1)
for expr in ["sender.send(ready)", "sender.send(batch)"]:
    assert expr in s, expr
    s = s.replace(expr, "{ let _send = Stage::new(10); " + expr + " }")
assert "                });\n            }\n            for (index, signature)" in s
s = s.replace("                });\n            }\n            for (index, signature)", "                    report();\n                });\n            }\n            for (index, signature)", 1)
assert "receivers[lane].recv()" in s
s = s.replace("receivers[lane].recv()", "{ let _receive = Stage::new(11); receivers[lane].recv() }")
s = s.replace("                    Ok((received_index, result)) => {", "                    Ok((received_index, result)) => {\n                        let _sink = Stage::new(12);")
s = s.replace("            drop(receivers);", "            drop(receivers);\n            report();")
s = s.replace("    let mut file = File::open(path)", "    let open_prefix = Stage::new(7);\n    let mut file = File::open(path)", 1)
s = s.replace("    let summary = loop {", "    drop(open_prefix);\n    let summary_timer = Stage::new(0);\n    let summary = loop {", 1)
s = s.replace("    let header_len = usize::try_from(summary.total_header_size)", "    drop(summary_timer);\n    let grow_header = Stage::new(8);\n    let header_len = usize::try_from(summary.total_header_size)", 1)
s = s.replace("    Package::parse_header(&bytes, file_len)", "    drop(grow_header);\n    Package::parse_header(&bytes, file_len)", 1)
p.write_text(s, encoding="utf-8")
p = out / "crates/uasset-io/src/direct_executor/project_index.rs"
s = p.read_text(encoding="utf-8")
s = s.replace("    let signature = scanner.reread_signature(", "    let _signature_timer = uasset_parser::header_profile::Stage::new(13);\n    let signature = scanner.reread_signature(", 1)
s = s.replace("let mut enumerated = scanner.enumerate(project_root, cancellation)?;", "let mut enumerated = { let _t = uasset_parser::header_profile::Stage::new(14); scanner.enumerate(project_root, cancellation)? };\n        let comparison_timer = uasset_parser::header_profile::Stage::new(15);")
s = s.replace("        scanner.stream_header_evidence(", "        drop(comparison_timer);\n        scanner.stream_header_evidence(", 1)
s = s.replace("        events.push(RefreshEvent::Completed", "        uasset_parser::header_profile::report();\n        events.push(RefreshEvent::Completed", 1)
p.write_text(s, encoding="utf-8")
p = out / "crates/uasset-io/src/direct_executor/catalog_binary.rs"
s = p.read_text(encoding="utf-8")
replacements = [
    ("    let dictionary = staging.dictionary.take()", "    let records_timer = uasset_parser::header_profile::Stage::new(16);\n    let dictionary = staging.dictionary.take()"),
    ("    let mut strings = Vec::new();\n    put32(&mut strings, dictionary.strings.len())?", "    drop(records_timer);\n    let strings_timer = uasset_parser::header_profile::Stage::new(17);\n    let mut strings = Vec::new();\n    put32(&mut strings, dictionary.strings.len())?"),
    ("    let mut directory = Vec::new();\n    let mut lists", "    drop(strings_timer);\n    let postings_timer = uasset_parser::header_profile::Stage::new(18);\n    let mut directory = Vec::new();\n    let mut lists"),
    ("    let sections = [inventory, strings, directory, lists, payload];", "    drop(postings_timer);\n    let checksums_timer = uasset_parser::header_profile::Stage::new(19);\n    let sections = [inventory, strings, directory, lists, payload];"),
    ('    publication_checkpoint("snapshot_created")?;', '    drop(checksums_timer);\n    let _write_timer = uasset_parser::header_profile::Stage::new(20);\n    publication_checkpoint("snapshot_created")?;'),
    ("            verify_snapshot(&path)?;", "            { let _verify_timer = uasset_parser::header_profile::Stage::new(21); verify_snapshot(&path)?; }")
]
for before, after in replacements:
    assert before in s, before
    s = s.replace(before, after, 1)
p.write_text(s, encoding="utf-8")
print(out)

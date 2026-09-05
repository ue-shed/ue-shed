"""Create an isolated, instrumented native reader; production has no profiling hooks.

Stage totals are elapsed nanoseconds summed per worker, not CPU or wall-clock totals.
Use the ordinary project benchmark for uninstrumented before/after measurements.
"""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
out = args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
for name in ["Cargo.toml", "Cargo.lock"]:
    shutil.copy2(root / name, out / name)
for name in ["crates", "fixtures", "packages/protocol/contracts"]:
    shutil.copytree(root / name, out / name, ignore=shutil.ignore_patterns("target", "node_modules", ".git", "__pycache__"))

profile = '''
pub mod header_profile {
    use std::{cell::RefCell, time::Instant};
    const LABELS: [&str; 14] = ["summary", "names", "soft_paths", "imports", "exports", "resolve_paths", "materialize_paths", "open_prefix", "grow_header", "evidence", "send_wait", "receive_wait", "sink", "signature"];
    thread_local! { static TOTALS: RefCell<[(u64,u64);14]> = const { RefCell::new([(0,0);14]) }; }
    pub struct Stage(usize, Instant);
    impl Stage { pub fn new(index: usize) -> Self { Self(index, Instant::now()) } }
    impl Drop for Stage { fn drop(&mut self) { let ns = self.1.elapsed().as_nanos() as u64; TOTALS.with_borrow_mut(|v| { v[self.0].0 += ns; v[self.0].1 += 1; }); } }
    pub fn report() { TOTALS.with_borrow_mut(|v| { for (label, (ns,count)) in LABELS.iter().zip(v.iter()) { if *count > 0 { eprintln!("HEADER_PROFILE {label} {ns} {count}"); } } *v = [(0,0);14]; }); }
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
s = s.replace("                        if sender.send((index, result)).is_err() {", "                        let _send = Stage::new(10);\n                        if sender.send((index, result)).is_err() {")
s = s.replace("                });\n            }\n            for index", "                    report();\n                });\n            }\n            for index", 1)
s = s.replace("let received = receiver.recv();", "let received = { let _receive = Stage::new(11); receiver.recv() };")
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
p.write_text(s, encoding="utf-8")
print(out)

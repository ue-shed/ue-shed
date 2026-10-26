use super::*;
use serde::Deserialize;
use std::process::{Command, Stdio};

#[derive(Deserialize)]
struct Oracle {
    rules: Vec<AudienceRule>,
    cases: Vec<Case>,
    #[serde(rename = "fixtureRecords")]
    fixture_records: usize,
}
#[derive(Deserialize)]
struct Case {
    records: Vec<Stored>,
    columns: Vec<ExpectedColumn>,
    snapshot: String,
}
#[derive(Deserialize)]
struct ExpectedColumn {
    name: String,
    kind: String,
    domain: String,
    strings: u32,
    bytes: Vec<u8>,
}

#[test]
fn typescript_differential_package_columns_and_staged_bytes() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let directory = workspace
        .join("target/package-columns-oracle")
        .join(std::process::id().to_string());
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/package-text-columns-oracle.test-support.ts",
        ])
        .arg(&directory)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Oracle = wtf8::parse_json_as(std::str::from_utf8(&output.stdout).unwrap()).unwrap();
    assert!(
        oracle.fixture_records > 0,
        "fixture records must be exercised"
    );
    for (index, case) in oracle.cases.into_iter().enumerate() {
        let mut builder = Columns::new().unwrap();
        for record in case.records {
            builder.feed(record, &oracle.rules).unwrap();
        }
        let actual = builder.finish().unwrap();
        assert_eq!(
            actual.len(),
            case.columns.len(),
            "case {index} column count"
        );
        for (a, b) in actual.iter().zip(case.columns) {
            assert_eq!(a.name, b.name, "case {index}");
            assert_eq!(
                ["bytes", "?", "u32", "stringIds", "strings"][a.kind as usize],
                b.kind,
                "case {index} {}",
                a.name
            );
            assert_eq!(a.domain, b.domain, "case {index} {}", a.name);
            assert_eq!(a.strings, b.strings, "case {index} {}", a.name);
            assert!(
                a.bytes == b.bytes,
                "case {index} {} raw bytes differ",
                a.name
            );
        }
        let path = directory.join(format!("{index}.native.snapshot"));
        write_staged(&path, &actual).unwrap();
        assert!(
            std::fs::read(path).unwrap() == std::fs::read(case.snapshot).unwrap(),
            "case {index} staged snapshot bytes differ"
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

use super::*;
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn files(root: &Path, found: &mut Vec<(Vec<u8>, Options)>) {
    if !root.exists() {
        return;
    }
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, found);
        } else if let Some(format) = match path.extension().and_then(|v| v.to_str()) {
            Some("manifest") => Some(Format::Manifest),
            Some("archive") => Some(Format::Archive),
            Some("po") => Some(Format::Po),
            _ => None,
        } {
            found.push((
                fs::read(path).unwrap(),
                Options {
                    format,
                    po_format: None,
                    collapse_mode: None,
                },
            ));
        }
    }
}

#[test]
fn typescript_differential_localization_columns_and_diagnostics() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    let mut cases = Vec::new();
    files(
        &workspace.join("fixtures/unreal-project/Content/Localization"),
        &mut cases,
    );
    for version in ["57", "58"] {
        files(
            &Path::new("E:/ue-shed-fixture-scratch").join(format!(
                "p1-canonical-ue{version}-facts/Content/Localization"
            )),
            &mut cases,
        );
    }
    let manifest = r#"{"FormatVersion":1,"Namespace":"Root","Children":[{"Source":{"Text":"source","extra":{"2":0.000001,"1":1e20}},"Keys":[{"Key":"a","Path":"/A/B","Optional":false,"MetaData":{},"DevNotes":""},{"Key":"a","Path":"/A/C"}]}],"Subnamespaces":[{"Namespace":"child","Children":[]}]}"#;
    for (format, texts) in [
        (
            Format::Manifest,
            vec![
                manifest,
                r#"{"Namespace":"","FormatVersion":1,"Children":[]}"#,
                "{}",
                "[]",
                "",
                "null",
                "{",
                "{\"Namespace\":0,\"FormatVersion\":1}",
                r#"{"FormatVersion":1,"Namespace":"","Children":[{}]}"#,
                r#"{"FormatVersion":1,"Namespace":"\ud800"}"#,
                r#"{"Namespace":"","FormatVersion":2}"#,
                r#"{"Namespace":"","FormatVersion":1,}"#,
            ],
        ),
        (
            Format::Archive,
            vec![
                r#"{"FormatVersion":2,"Namespace":"","Children":[{"Key":"","Source":{"Text":"a"},"Translation":{"Text":"a"}}]}"#,
                r#"{"FormatVersion":2,"Children":[],"Namespace":"n"}"#,
            ],
        ),
        (
            Format::Po,
            vec![
                "",
                "# comment\r\n",
                "msgid \"\"\nmsgstr \"header\"\n",
                "msgctxt \"N,K\"\nmsgid \"a\"\nmsgstr \"b\"\n",
                "msgid \"a\"\n\"b\\n\"\nmsgstr \"\\\\n\\t\\r\\\"\"",
                "msgctxt \"A\\,B,K\"\nmsgid \"a\"\nmsgid_plural \"many\"\nmsgstr[0] \"x\"\nmsgstr[2] \"y\"",
                "#| msgid \"old\"\n#, fuzzy, other\n#. Key: K\n#: /A/B\nmsgctxt \"N,K\"\nmsgid \"a\"\nmsgstr \"b\"",
                "msgid \"a\"\nmsgstr \"b\"\nmsgid \"a\"\nmsgstr \"c\"",
                "msgid \"a\"\nmsgstr \"b\"\n\nmsgctxt \"\"\nmsgid \"\"\nmsgstr \"\"",
                "msgid \"a\"\nmsgstr[1] \"b\"",
                "msgid \"x\"\n",
                "msgid \"x\" trailing",
                "msgstr[9007199254740992] \"x\"",
                "msgid \"x\"\nmsgid \"y\"\nmsgstr \"z\"",
                "\"continuation\"",
                "msgid \"a\u{2028}b\"\nmsgstr \"c\"",
                "msgid \"N,K\"\nmsgstr \"translation\"\n\nmsgid \"\"\nmsgstr \"X-Crowdin-SourceKey: msgstr\\n\"",
            ],
        ),
    ] {
        for text in texts {
            for bom in 0..3 {
                let bytes = match bom {
                    0 => text.as_bytes().to_vec(),
                    1 => [&[239, 187, 191][..], text.as_bytes()].concat(),
                    _ => [
                        &[255, 254][..],
                        &text
                            .encode_utf16()
                            .flat_map(u16::to_le_bytes)
                            .collect::<Vec<_>>(),
                    ]
                    .concat(),
                };
                cases.push((
                    bytes,
                    Options {
                        format,
                        po_format: None,
                        collapse_mode: None,
                    },
                ));
            }
        }
    }
    for bytes in [
        vec![0xff],
        vec![0xef, 0xbb],
        vec![0xff, 0xfe, 0x00],
        vec![0xc0, 0x80],
    ] {
        cases.push((
            bytes,
            Options {
                format: Format::Manifest,
                po_format: None,
                collapse_mode: None,
            },
        ));
    }
    let directory = crate::test_directory("localization-parser");
    fs::create_dir_all(&directory).unwrap();
    let requests = cases
        .iter()
        .enumerate()
        .map(|(i, (bytes, options))| {
            let path = directory.join(format!("{i}.input"));
            fs::write(&path, bytes).unwrap();
            json!({"path":path,"options":options})
        })
        .collect::<Vec<_>>();
    let mut child = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/localization-parser-oracle.test-support.ts",
        ])
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&requests).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(expected.len(), cases.len());
    for (i, ((bytes, options), expected)) in cases.iter().zip(expected).enumerate() {
        let actual = match parse_bytes(bytes, "input", options, &Limits::default()) {
            Ok(layer) => {
                json!({"columns":layer.columns.iter().map(|c| json!({"name":c.entry.name,"kind":match c.entry.kind { 0 => "bytes",2 => "u32",3 => "stringIds",4 => "strings",_ => "?" },"domain":c.entry.domain,"strings":c.entry.strings,"bytes":*c.bytes})).collect::<Vec<_>>()})
            }
            Err(error) => json!({"error":error}),
        };
        assert_eq!(
            actual, expected,
            "differential case {i}, {:?}",
            options.format
        );
    }
    fs::remove_dir_all(directory).unwrap();
}

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
    for text in [
        "{\"Namespace\":\"\",\"FormatVersion\":1,\"Children\":[{\"Source\":{\"Text\":\"raw\ncontrol\"},\"Keys\":[]}]}",
        "{\"Namespace\":\"\",\"FormatVersion\":1,\"Children\":[{\"Source\":{\"Text\":\"x\"},\"Keys\":[],}]}",
    ] {
        cases.push((
            text.as_bytes().to_vec(),
            Options {
                format: Format::Manifest,
                po_format: None,
                collapse_mode: None,
            },
        ));
    }
    let late_invalid = [
        format!("{{\"Namespace\":\"{}", "a".repeat(300_000)).into_bytes(),
        vec![0xff],
    ]
    .concat();
    cases.push((
        late_invalid,
        Options {
            format: Format::Manifest,
            po_format: None,
            collapse_mode: None,
        },
    ));
    for (format, prefix) in [
        (Format::Manifest, "{} }"),
        (
            Format::Po,
            "msgid \"broken\" trailing\nmsgstr \"x\"\n\nmsgid \"next\"\n",
        ),
    ] {
        cases.push((
            [prefix.as_bytes(), " ".repeat(300_000).as_bytes(), &[0xff]].concat(),
            Options {
                format,
                po_format: None,
                collapse_mode: None,
            },
        ));
    }
    let oversized = "s".repeat(1024 * 1024 + 1);
    for (format, text) in [
        (
            Format::Manifest,
            format!(
                "{{\"Namespace\":\"\",\"FormatVersion\":1,\"Children\":[{{\"Source\":{{\"Text\":\"{oversized}\"}},\"Keys\":[{{\"Key\":\"k\"}}]}},oops]}}"
            ),
        ),
        (
            Format::Po,
            format!("msgid \"{oversized}\"\nmsgstr \"x\"\n\nmsgid \"broken\" trailing\n"),
        ),
    ] {
        cases.push((
            text.into_bytes(),
            Options {
                format,
                po_format: None,
                collapse_mode: None,
            },
        ));
    }
    let large = (0..2500).map(|i| json!({"Source":{"Text":format!("{i}-{}", "source".repeat(40))},"Keys":[{"Key":format!("{i}-{}", "key".repeat(40)),"Path":format!("/A/B/{i}")}]})).collect::<Vec<_>>();
    cases.push((
        serde_json::to_vec(&json!({"Namespace":"","Children":large,"FormatVersion":1})).unwrap(),
        Options {
            format: Format::Manifest,
            po_format: None,
            collapse_mode: None,
        },
    ));
    for format in ["Unreal", "Crowdin"] {
        for collapse in [
            "IdenticalTextIdAndSource",
            "IdenticalNamespaceAndSource",
            "IdenticalPackageIdTextIdAndSource",
        ] {
            for text in [
                "#. Key: K\n#: /A/B\nmsgctxt \"N,K\"\nmsgid \"N,K\"\nmsgstr[4294967296] \"b\"\nmsgstr[4294967295] \"c\"\nmsgstr[1] \"d\"\nmsgstr[0] \"N,K\"",
                "msgid \"\"\nmsgstr \"prefix\\nX-Crowdin-SourceKey:\\nmsgstr\\n\"\n\nmsgid \"N,K\"\nmsgstr \"a\"",
                "msgctxt \"N,K\"\nmsgid \"source\"\nmsgstr \"b\"\n",
            ] {
                cases.push((
                    text.as_bytes().to_vec(),
                    Options {
                        format: Format::Po,
                        po_format: Some(format.into()),
                        collapse_mode: Some(collapse.into()),
                    },
                ));
            }
        }
    }
    cases.push((serde_json::to_vec(&json!({"Namespace":"N","FormatVersion":1,"Children":[{"Source":{"Text":"a"},"Keys":[{"Key":"k","Path":"/A/\u{f0000}/B"}]}]})).unwrap(), Options { format: Format::Manifest, po_format: None, collapse_mode: None }));
    for po_format in [None, Some("Unreal".to_string())] {
        for plural in ["", "msgid_plural \"many\"\nmsgstr[2] \"others\"\n"] {
            cases.push((
                format!("#. Key: K\n#. reserved \u{f0000}\u{f0001}\n# literal \u{f0800}\nmsgctxt \"N,K\u{f0001}\"\nmsgid \"source\u{f0000}\"\n{plural}msgstr \"translation\u{f0001}\"\n").into_bytes(),
                Options { format: Format::Po, po_format: po_format.clone(), collapse_mode: None },
            ));
        }
    }
    cases.extend(generated_cases());
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
        if let Some(fast) = fast::parse(bytes, "input", options, &Limits::default()) {
            assert_layers(
                &fast,
                &parse_bytes_reference(bytes, "input", options, &Limits::default()).unwrap(),
            );
        }
        let actual = match parse_bytes(bytes, "input", options, &Limits::default()) {
            Ok(layer) => {
                json!({"columns":layer.columns.iter().map(|c| json!({"name":c.entry.name,"kind":match c.entry.kind { 0 => "bytes",2 => "u32",3 => "stringIds",4 => "strings",_ => "?" },"domain":c.entry.domain,"strings":c.entry.strings,"bytes":*c.bytes})).collect::<Vec<_>>()})
            }
            Err(error) => json!({"error":error}),
        };
        if actual != expected {
            let one = actual.get("columns").and_then(Value::as_array);
            let two = expected.get("columns").and_then(Value::as_array);
            if let (Some(one), Some(two)) = (one, two) {
                assert_eq!(one.len(), two.len(), "column count at case {i}");
                for (a, b) in one.iter().zip(two) {
                    assert!(a == b, "differential case {i}, column {}", a["name"]);
                }
            }
            assert_eq!(actual, expected, "diagnostic at case {i}");
        }
    }
    fs::remove_dir_all(directory).unwrap();
}

fn assert_layers(one: &columns::LocalLayer, two: &columns::LocalLayer) {
    assert_eq!(one.columns.len(), two.columns.len());
    for (one, two) in one.columns.iter().zip(&two.columns) {
        assert_eq!(one.entry.name, two.entry.name);
        assert_eq!(one.entry.kind, two.entry.kind);
        assert_eq!(one.entry.domain, two.entry.domain);
        assert_eq!(one.entry.strings, two.entry.strings);
        assert_eq!(one.bytes, two.bytes, "column {}", one.entry.name);
    }
}

struct Random(u64);
impl Random {
    fn next(&mut self) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 32) as usize
    }
    fn object(&mut self, mut members: Vec<(&str, String)>) -> String {
        for i in (1..members.len()).rev() {
            let j = self.next() % (i + 1);
            members.swap(i, j);
        }
        format!(
            "{{\n{}\n}}",
            members
                .into_iter()
                .map(|(k, v)| format!("\"{k}\":{v}"))
                .collect::<Vec<_>>()
                .join(",\n")
        )
    }
    fn string(&mut self, text: &str) -> String {
        let mut out = String::from("\"");
        for c in text.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '/' => out.push_str("\\/"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if u32::from(c) < 32
                    || (u32::from(c) <= 0xffff && self.next().is_multiple_of(3)) =>
                {
                    out.push_str(&format!("\\u{:04x}", u32::from(c)));
                }
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }
    fn node(
        &mut self,
        format: Format,
        depth: usize,
        remaining: usize,
        serial: &mut usize,
    ) -> String {
        let name = self.string(if depth.is_multiple_of(2) {
            ""
        } else {
            "節.é😀"
        });
        let mut members = vec![("Namespace", name)];
        if depth == 0 {
            members.push((
                "FormatVersion",
                if format == Format::Manifest { "1" } else { "2" }.into(),
            ));
        }
        let mut children = Vec::new();
        for _ in 0..1 + self.next() % 3 {
            *serial += 1;
            let source = self.string(if serial.is_multiple_of(4) {
                ""
            } else {
                "é漢😀/\"\\\n\r\t\u{8}\u{c}\u{1}"
            });
            let source = format!("{{\"Text\":{source}}}");
            let mut record = vec![("Source", source)];
            if format == Format::Manifest {
                let mut keys = Vec::new();
                for k in 0..self.next() % 4 {
                    let key = self.string(&format!("k{},{}\\😀", *serial, k));
                    let path = self.string(if k == 0 { "" } else { "/Game/Text/é😀" });
                    let mut fields = vec![("Key", key), ("Path", path)];
                    if self.next().is_multiple_of(2) {
                        fields.push(("Optional", self.next().is_multiple_of(2).to_string()));
                    }
                    if self.next().is_multiple_of(2) {
                        fields.push((
                            "DevNotes",
                            self.string(if k == 0 { "" } else { "note\n漢😀" }),
                        ));
                    }
                    keys.push(self.object(fields));
                }
                record.push(("Keys", format!("[{}]", keys.join(","))));
            } else {
                record.push(("Key", self.string(&format!("k{}", *serial))));
                record.push((
                    "Translation",
                    format!("{{\"Text\":{}}}", self.string("訳😀\t\n\\\"")),
                ));
                if self.next().is_multiple_of(2) {
                    record.push(("Optional", self.next().is_multiple_of(2).to_string()));
                }
            }
            children.push(self.object(record));
        }
        members.push(("Children", format!("[{}]", children.join(","))));
        let nodes = if remaining > 0 {
            self.node(format, depth + 1, remaining - 1, serial)
        } else {
            String::new()
        };
        members.push(("Subnamespaces", format!("[{nodes}]")));
        self.object(members)
    }
}

fn generated_cases() -> Vec<(Vec<u8>, Options)> {
    let mut rng = Random(0x4c6f_6361_6c69_7a65);
    let mut cases = Vec::new();
    for format in [Format::Archive, Format::Manifest, Format::Po] {
        for i in 0..220 {
            let text = if format == Format::Po {
                let mut text = String::new();
                if i % 3 == 0 {
                    text.push_str("msgid \"\"\nmsgstr \"X-Crowdin-SourceKey: msgstr\\n\"\n\n");
                }
                for row in 0..1 + rng.next() % 6 {
                    let key = ["K", "", "A,B", "A\\B", "A\\,B", "漢😀"][rng.next() % 6];
                    let context = format!("N,{key}");
                    let quoted = serde_json::to_string(&context).unwrap();
                    text.push_str(&format!("#. Key: {key}\n#. extracted é😀\t\u{1}\n# translator é😀\n#: /Game/Text/{row}\n#: second/path\n#, fuzzy, other\n#| msgid \"old\"\nmsgctxt {quoted}\nmsgid \"é漢😀\"\n\"line\\n\\t\\r\\\"\\\\\"\n"));
                    if (i + row) % 4 == 0 {
                        text.push_str(
                            "msgid_plural \"many\"\nmsgstr[0] \"one\"\nmsgstr[2] \"many\"\n\n",
                        );
                    } else {
                        text.push_str("msgstr \"訳😀\"\n\"continued\\n\"\n\n");
                    }
                }
                if i % 3 == 1 {
                    text.push_str("msgid \"\"\nmsgstr \"X-Crowdin-SourceKey: msgstr\\n\"\n");
                }
                text
            } else {
                rng.node(format, 0, i % 5, &mut 0)
            };
            let text = if i % 2 == 0 {
                text.replace('\n', "\r\n")
            } else {
                text
            };
            let bytes = match (format, i % 3) {
                (Format::Po, _) | (_, 0) => text.into_bytes(),
                (_, 1) => [vec![239, 187, 191], text.into_bytes()].concat(),
                (_, _) => [
                    vec![255, 254],
                    text.encode_utf16().flat_map(u16::to_le_bytes).collect(),
                ]
                .concat(),
            };
            let options = Options {
                format,
                po_format: None,
                collapse_mode: None,
            };
            if format == Format::Po {
                cases.push((
                    bytes.clone(),
                    Options {
                        format,
                        po_format: Some("Unreal".into()),
                        collapse_mode: Some("IdenticalTextIdAndSource".into()),
                    },
                ));
            }
            cases.push((bytes, options));
        }
    }
    cases
}

#[test]
fn fast_generated_and_plain_fixtures_match_reference() {
    let mut cases = generated_cases();
    let generated = cases.len();
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap();
    files(
        &workspace.join("fixtures/unreal-project/Content/Localization"),
        &mut cases,
    );
    assert!(cases.len() > generated);
    for (i, (bytes, options)) in cases.iter().enumerate() {
        let text = if bytes.starts_with(&[255, 254]) {
            String::from_utf16(
                &bytes[2..]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| u16::from_le_bytes(*b))
                    .collect::<Vec<_>>(),
            )
            .unwrap()
        } else {
            String::from_utf8(bytes.clone()).unwrap()
        };
        // These manifests exercise metadata, which deliberately uses the reference path.
        if i >= generated && text.contains("\"MetaData\"") {
            assert!(fast::parse(bytes, "input", options, &Limits::default()).is_none());
            assert_results(bytes, options, &Limits::default());
            continue;
        }
        if let Ok(reference) = parse_bytes_reference(bytes, "input", options, &Limits::default()) {
            let fast = fast::parse(bytes, "input", options, &Limits::default())
                .unwrap_or_else(|| panic!("eligible case {i}, {:?}", options.format));
            assert_layers(&fast, &reference);
        } else if i < generated {
            panic!("invalid generated case {i}");
        }
    }
}

fn assert_results(bytes: &[u8], options: &Options, limits: &Limits) {
    match (
        parse_bytes(bytes, "input", options, limits),
        parse_bytes_reference(bytes, "input", options, limits),
    ) {
        (Ok(one), Ok(two)) => assert_layers(&one, &two),
        (Err(one), Err(two)) => assert_eq!(one, two),
        _ => panic!("different parse outcome"),
    }
}

#[test]
fn fast_rejects_unusual_and_invalid_json() {
    let options = Options {
        format: Format::Archive,
        po_format: None,
        collapse_mode: None,
    };
    let valid = r#"{"FormatVersion":2,"Namespace":"N","Children":[{"Key":"K","Source":{"Text":"s"},"Translation":{"Text":"t"}}]}"#;
    let cases = [
        valid.replace("\"Key\":\"K\"", "\"Key\":\"K\",\"MetaData\":{}"),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"\\ud800\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"\\ud83d\\ude00\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"\u{f0001}\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"s\",\"Other\":0"),
        valid.replace("\"Namespace\":\"N\"", "\"Namespace\":\"N\",\"Other\":[]"),
        valid.replace(
            "\"Namespace\":\"N\"",
            "\"Namespace\":\"N\",\"Namespace\":\"Z\"",
        ),
        valid.replace("\"Key\":\"K\"", "\"Key\":\"K\",\"Key\":\"Z\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"s\",\"Text\":\"t\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"\\q\""),
        valid.replace("\"Text\":\"s\"", "\"Text\":\"raw\ncontrol\""),
        valid.replace("\"FormatVersion\":2,", ""),
        valid.replace("\"FormatVersion\":2", "\"FormatVersion\":2.0"),
        valid.replace("\"Key\":\"K\",", ""),
        valid.replace("\"Namespace\":\"N\"", "\"Namespace\":null"),
        valid.replace("\"Children\":[", "\"Children\":false,\"other\":["),
        format!("{valid} false"),
        valid[..valid.len() - 1].into(),
        "{}".into(),
        String::new(),
        "[]".into(),
        valid.replace(",\"Children\"", ",,\"Children\""),
    ];
    for text in cases {
        assert!(
            fast::parse(text.as_bytes(), "input", &options, &Limits::default()).is_none(),
            "{text}"
        );
        assert_results(text.as_bytes(), &options, &Limits::default());
    }
    for bytes in [
        vec![255, 254, 0],
        vec![255, 254, 0, 216],
        vec![0xff],
        vec![0xc0, 0x80],
    ] {
        assert!(fast::parse(&bytes, "input", &options, &Limits::default()).is_none());
        assert_results(&bytes, &options, &Limits::default());
    }
    let mut rng = Random(0x4661_6c6c_6261_636b);
    for _ in 0..400 {
        let mut bytes = valid.as_bytes().to_vec();
        let i = rng.next() % bytes.len();
        bytes[i] = [b'{', b'}', b'"', b'\\', b'0', b',', b' ', 0][rng.next() % 8];
        assert_results(&bytes, &options, &Limits::default());
    }
}

#[test]
fn fast_limits_and_chunk_boundaries_preserve_outcomes() {
    for (bytes, options) in generated_cases().into_iter().step_by(31) {
        for n in [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4096] {
            for limits in [
                Limits {
                    max_depth: n,
                    ..Limits::default()
                },
                Limits {
                    max_entries: n,
                    ..Limits::default()
                },
                Limits {
                    max_record_bytes: n,
                    ..Limits::default()
                },
                Limits {
                    max_identity_bytes: n,
                    ..Limits::default()
                },
                Limits {
                    max_file_bytes: n as u64,
                    ..Limits::default()
                },
            ] {
                assert_results(&bytes, &options, &limits);
                if let Some(fast) = fast::parse(&bytes, "input", &options, &limits) {
                    assert_layers(
                        &fast,
                        &parse_bytes_reference(&bytes, "input", &options, &limits).unwrap(),
                    );
                }
            }
        }
        let reference =
            parse_bytes_reference(&bytes, "input", &options, &Limits::default()).unwrap();
        for chunk in [1, 2, 3, 7, 31, 256 * 1024] {
            assert_layers(
                &parse_bytes_reference_with_chunk(
                    &bytes,
                    "input",
                    &options,
                    &Limits::default(),
                    chunk,
                )
                .unwrap(),
                &reference,
            );
        }
    }
}

#[test]
fn fast_node_nesting_guard_falls_back() {
    let options = Options {
        format: Format::Archive,
        po_format: None,
        collapse_mode: None,
    };
    for depth in [16, 17] {
        let mut node = r#"{"Namespace":"","Children":[]}"#.to_string();
        for _ in 1..depth {
            node = format!("{{\"Namespace\":\"\",\"Subnamespaces\":[{node}]}}");
        }
        let text = node.replacen('{', "{\"FormatVersion\":2,", 1);
        let fast = fast::parse(text.as_bytes(), "input", &options, &Limits::default());
        assert_eq!(fast.is_some(), depth == 16);
        assert_results(text.as_bytes(), &options, &Limits::default());
    }
}

#[test]
fn po_byte_helpers_and_json_writer_match_original_operations() {
    let values = [
        "",
        "ascii",
        "é漢😀",
        "\t\n\u{b}\u{c}\r text \t",
        "\u{a0}\u{feff}text\u{3000}",
        "\u{85}text\u{85}",
        "\"\\\u{0}\u{1}\u{8}\u{c}",
        "\u{f0000}\u{f0001}",
    ];
    for value in values {
        assert_eq!(utf16_len(value), value.encode_utf16().count());
        assert_eq!(trim(value), value.trim_matches(js_space));
        assert_eq!(trim_start(value), value.trim_start_matches(js_space));
        let view = crate::wtf8::Wtf8Buf::from_utf8(value).into_view();
        let mut out = String::new();
        columns::write_string(&mut out, &view);
        assert_eq!(out, crate::wtf8::Wtf8Buf::from_view(&view).json_string());
    }
}

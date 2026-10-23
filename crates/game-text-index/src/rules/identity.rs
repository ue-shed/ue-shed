use super::columns::{Arena, Atom, Structured};
use crate::wtf8::Wtf8Buf;
use serde_json::{Value, json};

fn write_number(number: f64, out: &mut String) {
    if number.is_finite() {
        out.push_str(ryu_js::Buffer::new().format_finite(number));
    } else {
        out.push_str("null");
    }
}
pub(crate) fn write_string(text: &str, out: &mut String) {
    out.push_str(&Wtf8Buf::from_view(text).json_string());
}
/// `javascript_json(&arena.json(atom), sorted)`, written straight from the arena.
pub(crate) fn write_atom(arena: &Arena, atom: Atom, sorted: bool, out: &mut String) {
    match atom {
        Atom::Null => out.push_str("null"),
        Atom::Bool(value) => out.push_str(if value { "true" } else { "false" }),
        Atom::Int(value) => write_number(value as f64, out),
        Atom::Num(bits) => write_number(f64::from_bits(bits), out),
        Atom::Str(id) => write_string(arena.text(id), out),
        Atom::Val(id) => match &arena.values[id.0 as usize] {
            Structured::List(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_atom(arena, *value, sorted, out);
                }
                out.push(']');
            }
            Structured::Object(fields)
                if fields.iter().enumerate().all(|(index, (key, _))| {
                    fields[..index]
                        .iter()
                        .all(|(other, _)| arena.text(*other) != arena.text(*key))
                }) =>
            {
                let mut order = fields.iter().collect::<Vec<_>>();
                if sorted {
                    order.sort_by(|a, b| {
                        super::text::code_unit_compare(arena.text(a.0), arena.text(b.0))
                    });
                }
                out.push('{');
                for (index, (key, value)) in order.into_iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_string(arena.text(*key), out);
                    out.push(':');
                    write_atom(arena, *value, sorted, out);
                }
                out.push('}');
            }
            Structured::Scalar(value) => write_atom(arena, *value, sorted, out),
            // Occurrence views and objects with repeated keys keep the general encoding.
            _ => out.push_str(&javascript_json(&arena.json(atom), sorted)),
        },
    }
}

/// JSON with JavaScript number formatting, reversible UTF-16 strings, and optional key sorting.
pub fn javascript_json(value: &Value, sorted: bool) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => {
            let number = number.as_f64().unwrap_or(f64::NAN);
            if number.is_finite() {
                ryu_js::Buffer::new().format_finite(number).to_owned()
            } else {
                "null".into()
            }
        }
        Value::String(text) => Wtf8Buf::from_view(text).json_string(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(|value| javascript_json(value, sorted))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            if sorted {
                keys.sort_by(|a, b| super::text::code_unit_compare(a, b));
            }
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        Wtf8Buf::from_view(key).json_string(),
                        javascript_json(&values[key], sorted)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
pub fn localization_identity(
    line: &str,
    culture: &str,
    rule: &str,
    kind: &str,
    actual: &Value,
    expectation: &Value,
) -> (String, [u32; 2]) {
    localization_hash(&javascript_json(
        &json!([line, culture, rule, kind, actual, expectation]),
        true,
    ))
}
/// `localization_identity` from key-sorted encodings of `actual` and `expectation`.
pub(crate) fn localization_identity_encoded(
    line: &str,
    culture: &str,
    rule: &str,
    kind: &str,
    actual: &str,
    expectation: &str,
) -> (String, [u32; 2]) {
    let mut input = String::from("[");
    for text in [line, culture, rule, kind] {
        write_string(text, &mut input);
        input.push(',');
    }
    input.push_str(actual);
    input.push(',');
    input.push_str(expectation);
    input.push(']');
    localization_hash(&input)
}
fn localization_hash(input: &str) -> (String, [u32; 2]) {
    let (mut first, mut second) = (0x811c9dc5u32, 0x9e3779b9u32);
    for unit in Wtf8Buf::from_utf8(input).to_utf16() {
        first = (first ^ u32::from(unit)).wrapping_mul(0x01000193);
        second = (second ^ u32::from(unit)).wrapping_mul(0x5bd1e995);
        second ^= second >> 15;
    }
    (
        format!("localization-finding:{first:08x}{second:08x}"),
        [first, second],
    )
}
pub fn source_identity(
    rule: &str,
    role: Option<&str>,
    unit: &str,
    kind: &str,
    actual: &Value,
    expectation: &Value,
    occurrences: &[Option<std::sync::Arc<str>>],
) -> (String, [u32; 2]) {
    let mut ids = occurrences.iter().map(Option::as_deref).collect::<Vec<_>>();
    ids.sort_by(|a, b| super::text::code_unit_compare(a.unwrap_or(""), b.unwrap_or("")));
    source_hash(&javascript_json(
        &json!([rule, role, unit, kind, actual, expectation, ids]),
        false,
    ))
}
/// `source_identity` from encodings of `actual` and `expectation`, keys in stored order.
pub(crate) fn source_identity_encoded(
    rule: &str,
    role: Option<&str>,
    unit: &str,
    kind: &str,
    actual: &str,
    expectation: &str,
    occurrences: &[Option<std::sync::Arc<str>>],
) -> (String, [u32; 2]) {
    let mut ids = occurrences.iter().map(Option::as_deref).collect::<Vec<_>>();
    ids.sort_by(|a, b| super::text::code_unit_compare(a.unwrap_or(""), b.unwrap_or("")));
    let mut input = String::from("[");
    write_string(rule, &mut input);
    input.push(',');
    match role {
        Some(role) => write_string(role, &mut input),
        None => input.push_str("null"),
    }
    for text in [unit, kind] {
        input.push(',');
        write_string(text, &mut input);
    }
    for encoded in [actual, expectation] {
        input.push(',');
        input.push_str(encoded);
    }
    input.push(',');
    write_ids(&ids, &mut input);
    input.push(']');
    source_hash(&input)
}
/// A JSON array of occurrence IDs, `null` for a missing ID.
pub(crate) fn write_ids(ids: &[Option<&str>], out: &mut String) {
    out.push('[');
    for (index, id) in ids.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        match id {
            Some(id) => write_string(id, out),
            None => out.push_str("null"),
        }
    }
    out.push(']');
}
fn source_hash(input: &str) -> (String, [u32; 2]) {
    let mut hash = 0xcbf29ce484222325u64;
    for unit in Wtf8Buf::from_utf8(input).to_utf16() {
        hash = (hash ^ u64::from(unit)).wrapping_mul(0x100000001b3);
    }
    (
        format!("quality-finding:{hash:x}"),
        [(hash >> 32) as u32, hash as u32],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Result;
    use std::io::Write;
    use std::process::{Command, Stdio};
    #[test]
    fn direct_encoding_matches_the_value_encoding_and_identities() -> Result<()> {
        use super::super::columns::{Arena, Structured};
        let mut arena = Arena::new(0)?;
        let lone = Wtf8Buf::from_utf16(&[0xd800, 0x78, 0xdfff]).into_view();
        let mut texts = Vec::new();
        for text in [
            "",
            "plain",
            "quote \" back \\ slash",
            "\u{0}\n\t\u{1f}",
            "中😀𐀀",
            &lone,
        ] {
            texts.push(Atom::Str(arena.string(text)?));
        }
        let mut atoms = vec![
            Atom::Null,
            Atom::Bool(true),
            Atom::Bool(false),
            Atom::Int(0),
            Atom::Int(-7),
            Atom::Int(i64::MAX),
        ];
        for number in [0.1f64, 2.0, 1e21, 1e-7, 0.000001, -2.5, 123456789.125] {
            atoms.push(Atom::Num(number.to_bits()));
        }
        atoms.extend_from_slice(&texts);
        let list = arena.list(atoms.clone())?;
        let mut fields = Vec::new();
        for (name, value) in [
            ("z", texts[1]),
            ("a", atoms[7]),
            ("中", list),
            ("A", Atom::Null),
        ] {
            fields.push((arena.string(name)?, value));
        }
        let object = Atom::Val(arena.structured(Structured::Object(fields.clone().into()))?);
        let nested = arena.list(vec![object, list, Atom::Null])?;
        fields.push((fields[0].0, Atom::Int(1)));
        let repeated = Atom::Val(arena.structured(Structured::Object(fields.into()))?);
        atoms.extend([list, object, nested, repeated]);
        for atom in atoms {
            for sorted in [false, true] {
                let mut direct = String::new();
                write_atom(&arena, atom, sorted, &mut direct);
                assert_eq!(
                    direct,
                    javascript_json(&arena.json(atom), sorted),
                    "{atom:?} {sorted}"
                );
            }
        }
        let encoded = |atom, sorted| {
            let mut out = String::new();
            write_atom(&arena, atom, sorted, &mut out);
            out
        };
        let ids = [
            Some(std::sync::Arc::from("中")),
            None,
            Some(std::sync::Arc::from("a")),
        ];
        assert_eq!(
            source_identity_encoded(
                "rule",
                Some("all"),
                &lone,
                "kind",
                &encoded(nested, false),
                &encoded(object, false),
                &ids,
            ),
            source_identity(
                "rule",
                Some("all"),
                &lone,
                "kind",
                &arena.json(nested),
                &arena.json(object),
                &ids,
            )
        );
        assert_eq!(
            source_identity_encoded("rule", None, "unit", "kind", "null", "1", &[]),
            source_identity("rule", None, "unit", "kind", &Value::Null, &json!(1), &[])
        );
        assert_eq!(
            localization_identity_encoded(
                "line",
                &lone,
                "rule",
                "kind",
                &encoded(nested, true),
                &encoded(object, true),
            ),
            localization_identity(
                "line",
                &lone,
                "rule",
                "kind",
                &arena.json(nested),
                &arena.json(object),
            )
        );
        Ok(())
    }
    #[test]
    fn both_finding_identity_formulas_match_the_existing_typescript() -> Result<()> {
        let values = crate::json_value::parse(
            r#"[{"text":"plain","number":2.0},{"text":"中😀𐀀","number":0.13},{"text":"\ud800x\udfff","number":1e21},{"text":"\u0000\n\t","number":1e-7},{"text":"z","number":-0.0}]"#,
        )?;
        let cases = values.as_array().ok_or("Missing identity cases.")?.iter().map(|value| json!({"lineId":"line","culture":"de","ruleId":"rule","kind":"kind","role":"all","textUnitId":value["text"],"actual":{"z":value["text"],"a":value["number"],"nested":{"z":[],"a":2.0}},"expectation":{"kind":"expected","values":[2.0,0.000001,1e21]},"affectedOccurrences":[{"id":"中"},{"id":"😀"},{"id":"a"}]})).collect::<Vec<_>>();
        let mut child = Command::new("node").args(["--import","tsx","--input-type=module","-e","import {localizationFindingHash,localizationFindingId} from './packages/game-text/src/localization-workspace.ts';import {textQualityFindingId} from './packages/game-text/src/quality-query.ts';let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(f=>[localizationFindingId(localizationFindingHash(f)),textQualityFindingId(f)]))));"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Missing repository root.")?).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
        child
            .stdin
            .take()
            .ok_or("Missing Node stdin.")?
            .write_all(javascript_json(&json!(cases), false).as_bytes())?;
        let output = child.wait_with_output()?;
        crate::require(output.status.success(), "Node identity pin failed.")?;
        let expected = crate::json_value::parse(std::str::from_utf8(&output.stdout)?)?;
        for (index, finding) in cases.iter().enumerate() {
            let localization = localization_identity(
                "line",
                "de",
                "rule",
                "kind",
                &finding["actual"],
                &finding["expectation"],
            );
            let source = source_identity(
                "rule",
                Some("all"),
                finding["textUnitId"].as_str().ok_or("Missing unit.")?,
                "kind",
                &finding["actual"],
                &finding["expectation"],
                &finding["affectedOccurrences"]
                    .as_array()
                    .ok_or("Missing places.")?
                    .iter()
                    .map(|place| place["id"].as_str().map(std::sync::Arc::from))
                    .collect::<Vec<_>>(),
            );
            assert_eq!(
                localization.0, expected[index][0],
                "localization case {index}"
            );
            assert_eq!(source.0, expected[index][1], "source case {index}");
        }
        Ok(())
    }
}

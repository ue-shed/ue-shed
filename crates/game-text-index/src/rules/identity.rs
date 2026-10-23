use crate::wtf8::Wtf8Buf;
use serde_json::{Value, json};

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
    let input = javascript_json(
        &json!([line, culture, rule, kind, actual, expectation]),
        true,
    );
    let (mut first, mut second) = (0x811c9dc5u32, 0x9e3779b9u32);
    for unit in Wtf8Buf::from_utf8(&input).to_utf16() {
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
    occurrences: &[impl std::borrow::Borrow<Value>],
) -> (String, [u32; 2]) {
    let mut ids = occurrences
        .iter()
        .map(|occurrence| occurrence.borrow()["id"].clone())
        .collect::<Vec<_>>();
    ids.sort_by(|a, b| {
        super::text::code_unit_compare(a.as_str().unwrap_or(""), b.as_str().unwrap_or(""))
    });
    let input = javascript_json(
        &json!([rule, role, unit, kind, actual, expectation, ids]),
        false,
    );
    let mut hash = 0xcbf29ce484222325u64;
    for unit in Wtf8Buf::from_utf8(&input).to_utf16() {
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
                finding["affectedOccurrences"]
                    .as_array()
                    .ok_or("Missing places.")?,
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

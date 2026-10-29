//! `findingJson` (Phase 4 §8): a line finding as `loc check`'s report holds it. The report's
//! schema rebuilds each finding in its fields' order and keeps only the members it names, so a
//! finding's members are picked and ordered here, and its place set is inlined.
use super::replies::Place;
use crate::Result;
use serde_json::{Map, Value};
use std::collections::HashMap;

/// Every member a reported line finding may hold, in the report schema's order: the shared
/// fields, then a policy finding's role, then the kind and the fields of its family.
const ORDER: [&str; 20] = [
    "lineId",
    "target",
    "culture",
    "identity",
    "ruleId",
    "recovery",
    "affectedOccurrences",
    "manifestLocations",
    "translationOrigin",
    "suggestedChange",
    "severity",
    "sourceVariants",
    "role",
    "kind",
    "label",
    "subject",
    "check",
    "actual",
    "expectation",
    "unreportedMatches",
];

/// A policy finding's `actual` in its schema's order: the source finding's fields, with the
/// translation last where the source finding has its source.
fn policy_actual(kind: &str) -> Option<&'static [&'static str]> {
    match kind {
        "localization_character_budget" => Some(&["characterCount", "kind", "translation"]),
        "localization_terminology" => Some(&["end", "kind", "start", "term", "translation"]),
        _ => None,
    }
}

/// A place's location with the members its kind's schema names, in their order.
fn location(location: &Value) -> Value {
    let members: &[&str] = match location["kind"].as_str() {
        Some("asset_property") => &["kind", "objectPath", "classPath", "propertyPath"],
        Some("data_table_cell") => &["kind", "objectPath", "row", "propertyPath"],
        Some("code_place") => &["kind", "file", "line", "macro", "wrapper", "table"],
        _ => &["kind", "objectPath", "entryKey"],
    };
    picked(location, members)
}

fn picked(value: &Value, members: &[&str]) -> Value {
    let mut out = Map::new();
    for member in members {
        if let Some(item) = value.get(*member) {
            out.insert((*member).into(), item.clone());
        }
    }
    Value::Object(out)
}

/// JavaScript's truthiness, which decided whether the report kept an optional member.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A composed line finding as the report holds it, its places read from `sets` by its
/// `places` ID. A set with no places sends none.
pub(super) fn reported_finding(
    mut finding: Value,
    sets: &HashMap<u32, Vec<Place>>,
) -> Result<Value> {
    let kind = finding["kind"]
        .as_str()
        .ok_or("A reported finding has no kind.")?
        .to_owned();
    let set = finding["places"]
        .as_u64()
        .ok_or("A reported finding names no place set.")?;
    let places = sets
        .get(&u32::try_from(set)?)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let fields = finding
        .as_object_mut()
        .ok_or("A reported finding is not an object.")?;
    fields.insert(
        "affectedOccurrences".into(),
        Value::Array(
            places
                .iter()
                .map(|place| {
                    let mut out = Map::new();
                    out.insert("id".into(), Value::String(place.id.clone()));
                    out.insert("location".into(), location(&place.location));
                    out.insert(
                        "packageFile".into(),
                        Value::String(place.package_file.clone()),
                    );
                    Value::Object(out)
                })
                .collect(),
        ),
    );
    let policy = policy_actual(&kind);
    let custom = kind == "custom";
    let kept = |member: &str, value: &Value| match member {
        "role" => policy.is_some(),
        "label" | "subject" | "check" => custom,
        "sourceVariants" => policy.is_none() && !custom && truthy(value),
        "suggestedChange" => kind == "format_argument_renamed" && truthy(value),
        "unreportedMatches" => kind == "placeholder_text",
        _ => true,
    };
    let mut out = Map::new();
    for member in ORDER {
        if let Some(value) = fields.remove(member)
            && kept(member, &value)
        {
            let value = match (member, policy) {
                ("actual", Some(order)) => picked(&value, order),
                _ => value,
            };
            out.insert(member.into(), value);
        }
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn place() -> Place {
        Place {
            id: "o1".into(),
            location: json!({"propertyPath": "Text", "kind": "asset_property", "objectPath": "/Game/A.A", "classPath": "/Script/UMG.TextBlock", "extra": 1}),
            package_file: "Content/A.uasset".into(),
        }
    }

    fn keys(value: &Value) -> Vec<&str> {
        value
            .as_object()
            .map(|object| object.keys().map(String::as_str).collect())
            .unwrap_or_default()
    }

    #[test]
    fn built_in_findings_keep_the_report_schemas_members_in_its_order() -> Result<()> {
        let sets = HashMap::from([(3, vec![place()])]);
        let finding = json!({
            "id": "localization-finding:0000000100000002",
            "kind": "format_argument_renamed",
            "severity": "blocking",
            "lineId": "L",
            "places": 3,
            "target": "Game",
            "culture": "de",
            "identity": {"namespace": "", "key": "K"},
            "actual": {"arguments": ["A"], "renamed": []},
            "expectation": {"arguments": ["B"]},
            "ruleId": "localization.format_argument_renamed",
            "recovery": "Rename it.",
            "manifestLocations": [],
            "translationOrigin": "archive",
            "suggestedChange": {"translation": "x"},
            "sourceVariants": null,
            "role": "ui",
            "family": "builtin",
            "lineSource": "Hello",
            "manifestSource": null,
            "shippedTranslation": "Hallo"
        });
        let reported = reported_finding(finding, &sets)?;
        assert_eq!(
            keys(&reported),
            [
                "lineId",
                "target",
                "culture",
                "identity",
                "ruleId",
                "recovery",
                "affectedOccurrences",
                "manifestLocations",
                "translationOrigin",
                "suggestedChange",
                "severity",
                "kind",
                "actual",
                "expectation"
            ]
        );
        assert_eq!(
            reported["affectedOccurrences"],
            json!([{"id": "o1", "location": {"kind": "asset_property", "objectPath": "/Game/A.A", "classPath": "/Script/UMG.TextBlock", "propertyPath": "Text"}, "packageFile": "Content/A.uasset"}])
        );
        Ok(())
    }

    #[test]
    fn policy_and_custom_findings_keep_their_familys_members() -> Result<()> {
        let sets = HashMap::new();
        let policy = reported_finding(
            json!({
                "kind": "localization_terminology",
                "places": 9,
                "role": "ui",
                "sourceVariants": ["a", "b"],
                "suggestedChange": {"translation": "x"},
                "actual": {"kind": "terminology_match", "translation": "t", "start": 0, "end": 1, "term": "t"},
                "lineId": "L"
            }),
            &sets,
        )?;
        assert_eq!(
            keys(&policy),
            ["lineId", "affectedOccurrences", "role", "kind", "actual"]
        );
        assert_eq!(
            keys(&policy["actual"]),
            ["end", "kind", "start", "term", "translation"]
        );
        let custom = reported_finding(
            json!({"check": "pattern", "subject": "translation", "label": "No", "kind": "custom", "places": 1, "role": "ui", "unreportedMatches": []}),
            &sets,
        )?;
        assert_eq!(
            keys(&custom),
            ["affectedOccurrences", "kind", "label", "subject", "check"]
        );
        Ok(())
    }
}

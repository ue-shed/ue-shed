//! Matcher for text-audience.ts; the host supplies the ordered policy and its persisted codes.

use super::{Occurrence, location};
use crate::protocol_result::TextExtractionIdentity;

pub use game_text_index::package_text_contract::PackageTextAudienceRule as AudienceRule;
use game_text_index::package_text_contract::{
    PackageTextAudienceMatch as AudienceMatch, PackageTextObjectPosition as ObjectPosition,
};

fn suffix_start(element: &str) -> Option<usize> {
    let (opening, closing) = if element.ends_with(']') {
        ('[', ']')
    } else if element.ends_with('}') {
        ('{', '}')
    } else {
        let before = element.strip_suffix("\")")?;
        let start = before.rfind("(\"")?;
        return (!before[start + 2..].contains('"')).then_some(start);
    };
    let before = &element[..element.len() - closing.len_utf8()];
    // PROPERTY_SUFFIX permits opening delimiters in its body and takes the earliest match.
    let after = before.rfind(closing).map_or(0, |p| p + closing.len_utf8());
    before[after..].find(opening).map(|start| after + start)
}
fn property_elements(path: &str) -> Vec<String> {
    let mut after_map_entry = false;
    let mut result = Vec::new();
    // text-audience.ts:365-380: split before stripping suffixes, including quoted entry names.
    for element in path.split('.') {
        let map_side = after_map_entry && matches!(element, "key" | "value");
        after_map_entry = element.ends_with('}')
            && element[..element.len() - 1]
                .rfind('{')
                .is_some_and(|start| !element[start + 1..element.len() - 1].contains('}'));
        if map_side {
            continue;
        }
        let mut name = element;
        while let Some(start) = suffix_start(name) {
            name = &name[..start];
        }
        if !name.is_empty() {
            result.push(name.to_lowercase());
        }
    }
    result
}

fn classify(
    occurrence: &Occurrence,
    object: &str,
    class: &str,
    gather: Option<bool>,
    rules: &[AudienceRule],
) -> u32 {
    if let Some(editor_only) = gather {
        return if editor_only { 1 } else { 4 };
    }
    let (_, property, _, _, kind) = location(&occurrence.location);
    let namespace = match &occurrence.identity {
        TextExtractionIdentity::Resolved { namespace, key } if !key.is_empty() => {
            Some(namespace.to_lowercase())
        }
        _ => None,
    };
    let dot = object[object.rfind('/').map_or(0, |p| p + 1)..]
        .find('.')
        .map(|p| p + object.rfind('/').map_or(0, |p| p + 1));
    let package = dot.map_or(object, |p| &object[..p]);
    let objects = dot
        .map_or("", |p| &object[p + 1..])
        .split(['.', ':'])
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>();
    let folder = format!("{}/", package.to_lowercase());
    let class_dot = class.rfind('.');
    let class_name = class[class_dot.map_or(0, |p| p + 1)..].to_lowercase();
    let module = class
        .strip_prefix("/Script/")
        .and_then(|_| class_dot.filter(|p| *p > 0))
        .map(|p| class[8..p].to_lowercase());
    let elements = property_elements(property);
    rules
        .iter()
        .find(|rule| {
            rule.when.iter().all(|condition| {
                let value = match condition {
                    AudienceMatch::Namespace { value }
                    | AudienceMatch::Folder { value }
                    | AudienceMatch::Object { value, .. }
                    | AudienceMatch::Module { value, .. }
                    | AudienceMatch::Property { value, .. }
                    | AudienceMatch::Location { value } => value.to_lowercase(),
                };
                match condition {
                    AudienceMatch::Namespace { .. } => namespace.as_deref() == Some(&value),
                    AudienceMatch::Folder { .. } => folder.starts_with(&value),
                    AudienceMatch::Object { position, .. } => {
                        let named = |name: &str| match position {
                            ObjectPosition::Prefix => name.starts_with(&value),
                            ObjectPosition::Suffix => name.ends_with(&value),
                            ObjectPosition::Equals => name == value,
                        };
                        (kind == 0 && named(&class_name)) || objects.iter().any(|s| named(s))
                    }
                    AudienceMatch::Module { suffix, .. } => module.as_ref().is_some_and(|m| {
                        if *suffix {
                            m.ends_with(&value)
                        } else {
                            m == &value
                        }
                    }),
                    AudienceMatch::Property { anywhere, .. } => {
                        if *anywhere {
                            elements.contains(&value)
                        } else {
                            let wanted = value.split('.').collect::<Vec<_>>();
                            elements.len() >= wanted.len()
                                && elements[elements.len() - wanted.len()..]
                                    .iter()
                                    .map(String::as_str)
                                    .eq(wanted)
                        }
                    }
                    AudienceMatch::Location { value } => {
                        value
                            == if kind == 1 {
                                "data_table_cell"
                            } else if kind == 2 {
                                "string_table_entry"
                            } else {
                                "asset_property"
                            }
                    }
                }
            })
        })
        .map_or(30, |rule| rule.code)
}
pub(super) fn classify_folded(occurrence: &Occurrence, rules: &[AudienceRule]) -> u32 {
    let (object, _, class, _, kind) = location(&occurrence.location);
    let mut code = classify(
        occurrence,
        object,
        class,
        occurrence.gather_editor_only,
        rules,
    );
    let rank = |code: u32| match code & 3 {
        0 => 2,
        2 => 1,
        _ => 0,
    };
    for copy in &occurrence.copies {
        let other = classify(
            occurrence,
            &copy.object_path,
            if kind == 0 {
                copy.class_path.as_deref().unwrap_or(class)
            } else {
                ""
            },
            copy.gather_editor_only,
            rules,
        );
        if rank(other) > rank(code) {
            code = other;
        }
    }
    code
}

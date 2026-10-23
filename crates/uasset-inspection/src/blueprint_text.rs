//! Reconcile compiled Blueprint literals with their saved, package-stamped pin identities.

use std::collections::BTreeMap;

use uasset_parser::gatherable_text::strip_package_namespace;

use crate::projection::{TextIdentity, TextLocation, TextOccurrence};

/// Call once with all decoded occurrences from exactly one package. Unreal's compiler strips
/// the package namespace from bytecode; its gatherer strips the same marker from pin text.
/// Keep both locations, using the saved pin identity when key and clean namespace identify one
/// package stamp. Source equality is not required: bytecode may predate an edited pin. Missing
/// pins and ambiguous stamps stay untouched; the host folds uniquely attributable runtime copies.
pub fn reconcile_blueprint_text(occurrences: &mut [TextOccurrence]) {
    let mut pins = BTreeMap::new();
    for text in occurrences.iter() {
        let TextLocation::AssetProperty { property_path, .. } = &text.location else {
            continue;
        };
        if !property_path.starts_with("Pins[") || !property_path.ends_with("].DefaultTextValue") {
            continue;
        }
        let TextIdentity::Resolved { namespace, key } = &text.identity else {
            continue;
        };
        let clean = strip_package_namespace(namespace);
        if clean == namespace {
            continue;
        }
        pins.entry((clean, key.as_str()))
            .and_modify(|target| {
                if *target != Some(namespace.as_str()) {
                    *target = None;
                }
            })
            .or_insert(Some(namespace.as_str()));
    }
    let replacements: Vec<_> = occurrences
        .iter()
        .enumerate()
        .filter_map(|(index, text)| {
            let TextLocation::AssetProperty { property_path, .. } = &text.location else {
                return None;
            };
            if !property_path.starts_with("ScriptBytecode[") {
                return None;
            }
            let TextIdentity::Resolved { namespace, key } = &text.identity else {
                return None;
            };
            let target = pins.get(&(namespace.as_str(), key.as_str()))?;
            target.map(|target| (index, target.to_owned()))
        })
        .collect();
    for (index, target) in replacements {
        if let TextIdentity::Resolved { namespace, .. } = &mut occurrences[index].identity {
            *namespace = target;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::TextEditCapability;

    fn text(namespace: &str, source: &str, path: &str) -> TextOccurrence {
        TextOccurrence {
            source: source.into(),
            dev_notes: String::new(),
            identity: TextIdentity::Resolved {
                namespace: namespace.into(),
                key: "SharedKey".into(),
            },
            location: TextLocation::AssetProperty {
                object_path: "Blueprint".into(),
                class_path: String::new(),
                property_path: path.into(),
            },
            edit_capability: TextEditCapability::ReadOnly,
        }
    }

    #[test]
    fn reconciles_current_and_stale_compiled_copies_and_keeps_their_locations() {
        let mut texts = vec![
            text("UI", "Locked", "ScriptBytecode[0]"),
            text("UI [PackageA]", "Locked", "Pins[4].DefaultTextValue"),
            text("UI", "Barred", "ScriptBytecode[1]"),
            text("Other", "Locked", "ScriptBytecode[2]"),
            text("UI", "Locked", "Label"),
        ];
        let original = texts.clone();
        reconcile_blueprint_text(&mut texts);
        assert_eq!(texts[0].identity, texts[1].identity);
        assert_eq!(texts[2].identity, texts[1].identity);
        assert_eq!(texts[0].location, original[0].location);
        assert_eq!(texts[2].source, "Barred");
        assert_eq!(texts[2].location, original[2].location);
        assert_eq!(texts[1], original[1]);
        assert_eq!(&texts[3..], &original[3..]);
        let reconciled = texts.clone();
        reconcile_blueprint_text(&mut texts);
        assert_eq!(texts, reconciled);
    }

    #[test]
    fn unread_or_other_package_pins_cannot_supply_an_identity() {
        let mut package_a = vec![text("", "Locked", "ScriptBytecode[0]")];
        let mut package_b = vec![text("[PackageB]", "Locked", "Pins[4].DefaultTextValue")];
        let original = package_a.clone();
        reconcile_blueprint_text(&mut package_a);
        reconcile_blueprint_text(&mut package_b);
        assert_eq!(package_a, original);
    }

    #[test]
    fn ambiguous_package_stamps_and_friendly_names_do_not_match() {
        let mut texts = vec![
            text("UI", "Locked", "ScriptBytecode[0]"),
            text("UI [PackageA]", "Locked", "Pins[4].DefaultTextValue"),
            text("UI [PackageB]", "Locked", "Pins[5].DefaultTextValue"),
            text("Other", "Locked", "ScriptBytecode[1]"),
            text("Other [PackageA]", "Locked", "Pins[6].PinFriendlyName"),
        ];
        let original = texts.clone();
        reconcile_blueprint_text(&mut texts);
        assert_eq!(texts, original);
    }
}

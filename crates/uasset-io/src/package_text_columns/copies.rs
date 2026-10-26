//! Stable representation folding from packages/game-text/src/representation-copies.ts.
use std::collections::{HashMap, HashSet};

use game_text_index::Result;

use super::{CopyKind, Occurrence, RepresentationCopy, location};
use crate::protocol_result::{SavedAssetPackageTextRecord, TextExtractionIdentity};

struct Prefix<'a> {
    path: &'a str,
    blueprint: &'a str,
    kind: CopyKind,
    instances: bool,
}
struct Site {
    site: String,
    kind: CopyKind,
}
fn representation_site(object: &str, prefixes: &[Prefix<'_>]) -> Option<Site> {
    for prefix in prefixes {
        if object == prefix.path {
            return Some(Site {
                site: prefix.blueprint.into(),
                kind: prefix.kind,
            });
        }
        let Some(rest) = object.strip_prefix(prefix.path) else {
            continue;
        };
        let separator = rest.chars().next()?;
        if !matches!(separator, '.' | ':') {
            continue;
        }
        let rest = &rest[1..];
        let dot = rest.find('.');
        let first = dot.map_or(rest, |p| &rest[..p]);
        if prefix.instances && first.len() > 5 && first.ends_with("_INST") {
            return Some(Site {
                site: format!(
                    "{}{separator}{}{}",
                    prefix.blueprint,
                    &first[..first.len() - 5],
                    dot.map_or("", |p| &rest[p..])
                ),
                kind: if prefix.kind == CopyKind::GeneratedClass {
                    CopyKind::Instance
                } else {
                    prefix.kind
                },
            });
        }
        return Some(Site {
            site: format!("{}{separator}{rest}", prefix.blueprint),
            kind: prefix.kind,
        });
    }
    None
}
fn within(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with(['.', ':']))
}
fn identity_key(occurrence: &Occurrence) -> String {
    match &occurrence.identity {
        TextExtractionIdentity::Resolved { namespace, key } => format!("r\0{namespace}\0{key}"),
        TextExtractionIdentity::StringTable { table_id, key } => format!("s\0{table_id}\0{key}"),
        TextExtractionIdentity::Unresolved { reason } => format!(
            "u\0{}",
            match reason {
                crate::protocol_result::TextUnresolvedReason::CultureInvariant =>
                    "culture_invariant",
                crate::protocol_result::TextUnresolvedReason::MissingKey => "missing_key",
            }
        ),
    }
}
fn site_key(occurrence: &Occurrence, object: &str) -> String {
    let (_, property, _, row, kind) = location(&occurrence.location);
    let field = if kind == 2 {
        row.to_owned()
    } else if kind == 1 {
        format!("{row}\0{property}")
    } else {
        property.to_owned()
    };
    let kind = ["asset_property", "data_table_cell", "string_table_entry"][kind as usize];
    format!("{kind}\0{object}\0{field}\0{}", identity_key(occurrence))
}
pub(super) fn fold(record: &mut SavedAssetPackageTextRecord<Occurrence>) -> Result<()> {
    if record.blueprint_classes.is_empty() || record.occurrences.len() < 2 {
        return Ok(());
    }
    let prefixes = record
        .blueprint_classes
        .iter()
        .flat_map(|item| {
            [
                (
                    Some(item.generated_class.as_str()),
                    CopyKind::GeneratedClass,
                    true,
                ),
                (item.class_default.as_deref(), CopyKind::ClassDefault, false),
                (item.skeleton_class.as_deref(), CopyKind::Skeleton, true),
                (
                    item.skeleton_class_default.as_deref(),
                    CopyKind::Skeleton,
                    false,
                ),
            ]
            .into_iter()
            .filter_map(|(path, kind, instances)| {
                path.filter(|path| !path.is_empty() && *path != item.blueprint)
                    .map(|path| Prefix {
                        path,
                        blueprint: &item.blueprint,
                        kind,
                        instances,
                    })
            })
        })
        .collect::<Vec<_>>();
    let occurrences = &record.occurrences;
    let sites = occurrences
        .iter()
        .map(|o| representation_site(location(&o.location).0, &prefixes))
        .collect::<Vec<_>>();
    if sites.iter().all(Option::is_none) {
        return Ok(());
    }
    let mut pins = HashMap::new();
    for (index, occurrence) in occurrences.iter().enumerate() {
        let (object, property, _, _, kind) = location(&occurrence.location);
        let pin = property
            .strip_prefix("Pins[")
            .and_then(|s| s.strip_suffix("].DefaultTextValue"))
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        if sites[index].is_some()
            || kind != 0
            || !pin
            || !matches!(&occurrence.identity, TextExtractionIdentity::Resolved { key, .. } if !key.is_empty())
        {
            continue;
        }
        if let Some(blueprint) = record
            .blueprint_classes
            .iter()
            .find(|c| within(object, &c.blueprint))
        {
            pins.entry(format!(
                "{}\0{}",
                blueprint.blueprint,
                identity_key(occurrence)
            ))
            .and_modify(|value| *value = None)
            .or_insert(Some(index));
        }
    }
    let mut groups = HashMap::<String, Vec<usize>>::new();
    for (index, occurrence) in occurrences.iter().enumerate() {
        let (object, property, _, _, kind) = location(&occurrence.location);
        let blueprint = if sites[index]
            .as_ref()
            .is_some_and(|s| s.kind == CopyKind::GeneratedClass)
            && kind == 0
            && property.starts_with("ScriptBytecode[")
        {
            record
                .blueprint_classes
                .iter()
                .find(|c| within(object, &c.generated_class))
        } else {
            None
        };
        let pin = blueprint
            .and_then(|c| pins.get(&format!("{}\0{}", c.blueprint, identity_key(occurrence))))
            .copied()
            .flatten();
        let place = pin.map_or(occurrence, |p| &occurrences[p]);
        let key = site_key(
            place,
            if pin.is_some() {
                location(&place.location).0
            } else {
                sites[index].as_ref().map_or(object, |s| &s.site)
            },
        );
        groups.entry(key).or_default().push(index);
    }
    let rank = |index: usize| {
        sites[index].as_ref().map_or(0, |s| match s.kind {
            CopyKind::GeneratedClass | CopyKind::Instance => 1,
            CopyKind::ClassDefault => 2,
            CopyKind::Skeleton => 3,
        })
    };
    let mut place_of = HashMap::new();
    let mut folded = HashSet::new();
    for members in groups.values().filter(|members| members.len() >= 2) {
        let Some(&place) = members.iter().min_by_key(|index| rank(**index)) else {
            continue;
        };
        let copies = members
            .iter()
            .copied()
            .filter(|index| *index != place)
            .collect::<Vec<_>>();
        folded.extend(copies.iter().copied());
        place_of.insert(place, copies);
    }
    let mut output = Vec::new();
    for (index, occurrence) in occurrences.iter().enumerate() {
        if folded.contains(&index) {
            continue;
        }
        let mut place = occurrence.clone();
        if let Some(members) = place_of.get(&index) {
            for member in members {
                let copy = &occurrences[*member];
                let (object, _, class, _, kind) = location(&copy.location);
                place.copies.push(RepresentationCopy {
                    object_path: object.into(),
                    kind: sites[*member]
                        .as_ref()
                        .ok_or("folded copy has no representation site")?
                        .kind,
                    source: copy.source.clone(),
                    class_path: (kind == 0).then(|| class.into()),
                    gather_editor_only: copy.gather_editor_only,
                });
                place.copies.extend(copy.copies.iter().cloned());
            }
        }
        output.push(place);
    }
    record.occurrences = output;
    Ok(())
}

//! Asset types: the main asset class of the package holding each saved place, read from the
//! package shards' `package.asset_class` column when a request first filters or counts by them.
use crate::engine_match::{Kind, Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::{Result, require};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Names that differ from the class's own: Unreal shows a World as a Level. Mirrors
/// `TEXT_ASSET_TYPE_LABELS` in `packages/game-text/src/text-asset-type.ts`.
const LABELS: [(&str, &str); 1] = [("/Script/Engine.World", "Level")];

/// How writers see an asset type, as `textAssetTypeLabel` spells it: engine and plugin classes
/// split into sentence-case words with acronyms kept, Blueprint classes without their `_C`.
pub(crate) fn asset_type_label(class_path: &str) -> String {
    if let Some((_, label)) = LABELS.iter().find(|(path, _)| *path == class_path) {
        return (*label).to_owned();
    }
    let start = class_path.rfind(['.', '/']).map_or(0, |index| index + 1);
    let name = &class_path[start..];
    if !class_path.starts_with("/Script/") {
        let name = name.strip_suffix("_C").unwrap_or(name);
        return if name.is_empty() {
            class_path.to_owned()
        } else {
            name.to_owned()
        };
    }
    let chars = name.chars().collect::<Vec<_>>();
    let mut words = Vec::<String>::new();
    let mut word = String::new();
    for (index, char) in chars.iter().enumerate() {
        let previous = index.checked_sub(1).and_then(|index| chars.get(index));
        let next = chars.get(index + 1);
        if !word.is_empty()
            && char.is_ascii_uppercase()
            && (previous.is_some_and(char::is_ascii_lowercase)
                || (previous.is_some_and(char::is_ascii_uppercase)
                    && next.is_some_and(char::is_ascii_lowercase)))
        {
            words.push(std::mem::take(&mut word));
        }
        word.push(*char);
    }
    if !word.is_empty() {
        words.push(word);
    }
    if words.is_empty() {
        return class_path.to_owned();
    }
    words
        .iter()
        .enumerate()
        .map(|(index, part)| {
            // JavaScript's toUpperCase, which leaves non-letters as they are.
            if index == 0 || (part.chars().count() > 1 && *part == part.to_uppercase()) {
                part.clone()
            } else {
                part.to_lowercase()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Each global occurrence's asset type: 0 when its package has none, else an index into
/// `names`, whose labels rank in UTF-16 order.
pub(crate) struct AssetTypes {
    occurrence: Vec<u32>,
    pub names: Vec<String>,
    pub labels: Vec<String>,
    pub ranks: Vec<u32>,
}

impl AssetTypes {
    pub fn open(query: &mut EngineQuery, cancelled: &AtomicBool) -> Result<Arc<Self>> {
        if let Some(types) = &query.asset_types {
            return Ok(Arc::clone(types));
        }
        let mut names = vec![String::new()];
        let mut by_name = HashMap::from([(String::new(), 0u32)]);
        // The same class can sit in several dictionary segments under different IDs.
        let mut by_id = HashMap::<u32, u32>::new();
        let mut occurrence = Vec::new();
        for shard in 0..query.package_count() {
            checkpoint(cancelled)?;
            require(
                query.package_occurrence_start(shard) == Some(occurrence.len()),
                "Asset types outside their shard.",
            )?;
            let starts = query.package_column(shard, "package.occurrence_start")?;
            let classes = query.package_column(shard, "package.asset_class")?;
            require(
                starts.len() == classes.len() + 1 && starts.first() == Some(&0),
                "Invalid asset type column.",
            )?;
            for (row, id) in classes.iter().enumerate() {
                let kind = match by_id.get(id) {
                    Some(kind) => *kind,
                    None => {
                        let name = query.reader.string(*id)?;
                        let next = names.len() as u32;
                        let kind = *by_name.entry(name.clone()).or_insert(next);
                        if kind == next {
                            names.push(name);
                        }
                        by_id.insert(*id, kind);
                        kind
                    }
                };
                let count = starts[row + 1]
                    .checked_sub(starts[row])
                    .ok_or("Invalid asset type range.")?;
                occurrence.extend(std::iter::repeat_n(kind, count as usize));
            }
        }
        let labels = names
            .iter()
            .map(|name| asset_type_label(name))
            .collect::<Vec<_>>();
        let mut order = (0..labels.len()).collect::<Vec<_>>();
        order.sort_by(|a, b| crate::join::ordinal(&labels[*a], &labels[*b]));
        let mut ranks = vec![0; labels.len()];
        for (rank, kind) in order.into_iter().enumerate() {
            ranks[kind] = rank as u32;
        }
        let types = Arc::new(Self {
            occurrence,
            names,
            labels,
            ranks,
        });
        query.asset_types = Some(Arc::clone(&types));
        Ok(types)
    }

    /// The types of the given type names, each a flag by type index.
    pub fn wanted(&self, values: &[String]) -> Vec<bool> {
        let mut wanted = vec![false; self.names.len()];
        for (kind, name) in self.names.iter().enumerate().skip(1) {
            wanted[kind] = values.iter().any(|value| value == name);
        }
        wanted
    }

    /// Visits each saved place's type once per row, skipping places without one, until `visit`
    /// returns true. A line has the places of its visible slices.
    pub fn each(
        &self,
        projection: &Projection,
        kind: Kind,
        row: usize,
        visit: &mut impl FnMut(u32) -> bool,
    ) -> Result<bool> {
        let mut seen = Vec::<u32>::new();
        let mut found = false;
        projection.each_member(kind, row, &mut |member| {
            let kind = *self
                .occurrence
                .get(member as usize)
                .ok_or("Occurrence outside asset types.")?;
            if kind == 0 || seen.contains(&kind) {
                return Ok(false);
            }
            seen.push(kind);
            found = visit(kind);
            Ok(found)
        })?;
        Ok(found)
    }
}

impl Projection {
    /// Each saved place of a row: a line's through its visible slices. Stops when `visit` is true.
    pub(crate) fn each_member(
        &self,
        kind: Kind,
        row: usize,
        visit: &mut impl FnMut(u32) -> Result<bool>,
    ) -> Result<bool> {
        if matches!(kind, Kind::Line) {
            for sr in self.starts[row] as usize..self.starts[row + 1] as usize {
                if self.slice.visible[sr] != 0 && self.each_member(Kind::Slice, sr, visit)? {
                    return Ok(true);
                }
            }
            return Ok(false);
        }
        let rows = if matches!(kind, Kind::Raw) {
            &self.raw
        } else {
            &self.slice
        };
        for member in rows.members(row) {
            if visit(*member)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::asset_type_label;

    #[test]
    fn asset_type_labels_read_as_the_typescript_labels() {
        for (class, label) in [
            ("/Script/Engine.DataTable", "Data table"),
            ("/Script/Engine.StringTable", "String table"),
            ("/Script/Engine.Blueprint", "Blueprint"),
            ("/Script/UMGEditor.WidgetBlueprint", "Widget blueprint"),
            ("/Script/Engine.World", "Level"),
            ("/Script/Game.UIDataAsset", "UI data asset"),
            ("/Script/Engine.Texture2D", "Texture2D"),
            ("/Game/Items/BP_Item.BP_Item_C", "BP_Item"),
        ] {
            assert_eq!(asset_type_label(class), label, "{class}");
        }
    }
}

use crate::join::Joined;
use crate::join_columns::*;
use crate::join_policy::{file_key, normalized, trim};
use std::collections::HashMap;
pub(crate) fn audience(code: u32) -> u32 {
    1 << (code & 3)
}
pub(crate) fn editor_only(code: u32) -> bool {
    code & 3 == 1 && (code >> 2) & 15 != 2
}
pub(crate) fn skips_editor(target: &serde_json::Value) -> bool {
    let mut steps = Vec::new();
    if let Some(configs) = target["configs"].as_array() {
        for config in configs {
            if let Some(values) = config["steps"].as_array() {
                for step in values {
                    if step["commandletClass"] == "GatherTextFromAssets" {
                        steps.push(
                            step["fields"]["ShouldGatherFromEditorOnlyData"]
                                .as_bool()
                                .or(config["common"]["ShouldGatherFromEditorOnlyData"].as_bool())
                                .unwrap_or(false),
                        );
                    }
                }
            }
        }
    }
    if !steps.is_empty() {
        return steps.iter().all(|v| !*v);
    }
    target["dashboard"]["settings"]["GatherFromPackages"]["IsEnabled"].as_bool() == Some(true)
        && target["dashboard"]["settings"]["GatherFromPackages"]["ShouldGatherFromEditorOnlyData"]
            .as_bool()
            != Some(true)
}
#[expect(
    clippy::unwrap_used,
    reason = "serialization of tuples of strings to an owned JSON string is infallible"
)]
pub(crate) fn places(j: &Joined) -> Vec<u32> {
    use rayon::prelude::*;
    let c = &j.packages.occurrence;
    // Keys are independent per occurrence; IDs are then assigned in order, as before.
    let keys = j
        .order
        .par_iter()
        .map(|member| {
            let i = *member as usize;
            let file = file_key(&j.packages.relative_paths[j.packages.package_row[i] as usize]);
            let object = j.string(c[O_OBJECT][i]);
            if c[O_LOCATION][i] == 2 {
                serde_json::to_string(&(
                    file,
                    normalized(trim(object)).to_lowercase(),
                    j.string(c[O_ROW][i]),
                ))
                .unwrap()
            } else {
                let path = if c[O_LOCATION][i] == 1 {
                    format!(
                        "{object}.{}.{}",
                        j.string(c[O_ROW][i]),
                        j.string(c[O_PROPERTY][i])
                    )
                } else {
                    format!("{object}.{}", j.string(c[O_PROPERTY][i]))
                };
                let place = crate::join_marks::manifest_place(&path).unwrap_or(path);
                serde_json::to_string(&(file, place)).unwrap()
            }
        })
        .collect::<Vec<_>>();
    let mut result = vec![0; j.order.len()];
    let mut ids = HashMap::<String, u32>::new();
    for (member, key) in j.order.iter().zip(keys) {
        let next = ids.len() as u32;
        result[*member as usize] = *ids.entry(key).or_insert(next);
    }
    result
}
pub(crate) fn duplicates(j: &Joined, places: &[u32]) -> Vec<bool> {
    let c = &j.packages.occurrence;
    let mut lines = vec![0; j.order.len()];
    for (row, g) in j.groups.iter().enumerate() {
        for member in &j.order[g.os..g.oe] {
            lines[*member as usize] = row as u32;
        }
    }
    let mut count = HashMap::<u32, u32>::new();
    let mut identities = HashMap::<(u32, u32), u32>::new();
    let mut locations = HashMap::<(u32, u32), u32>::new();
    let mut pairs = HashMap::<(u32, u32, u32), u32>::new();
    for member in &j.order {
        let i = *member as usize;
        if c[O_IDENTITY][i] != 0 || c[O_KEY][i] == j.empty {
            continue;
        }
        let s = c[O_SOURCE][i];
        let l = lines[i];
        let p = places[i];
        *count.entry(s).or_default() += 1;
        *identities.entry((s, l)).or_default() += 1;
        *locations.entry((s, p)).or_default() += 1;
        *pairs.entry((s, l, p)).or_default() += 1;
    }
    let mut result = vec![false; j.order.len()];
    for member in &j.order {
        let i = *member as usize;
        if c[O_IDENTITY][i] != 0 || c[O_KEY][i] == j.empty {
            continue;
        }
        let s = c[O_SOURCE][i];
        let l = lines[i];
        let p = places[i];
        result[i] =
            i64::from(count[&s]) - i64::from(identities[&(s, l)]) - i64::from(locations[&(s, p)])
                + i64::from(pairs[&(s, l, p)])
                > 0;
    }
    result
}

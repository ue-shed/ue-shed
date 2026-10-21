//! Key-change and review marks, over gathered lines rather than raw saved units.
use crate::Result;
use crate::join::{JoinInput, Joined, L_KEY, L_NS, L_PROBLEMS, L_SOURCE, intern};
use crate::join_columns::*;
use crate::join_policy::*;
use crate::store::{Store, digest};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;
#[expect(
    clippy::expect_used,
    reason = "the regex is a source literal tested by manifest place fixtures"
)]
static PLACE_NUMBER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\((\d+)\)").expect("constant regex"));
#[expect(
    clippy::expect_used,
    reason = "the regex is a source literal tested by manifest place fixtures"
)]
static ASSET_PLACE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^/[^.]+\.[^.:]+[.:].+").expect("constant regex"));
#[expect(
    clippy::expect_used,
    reason = "the regex is a source literal tested by manifest place fixtures"
)]
static SOURCE_PLACE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?:\[\d+\]|:\d+)$").expect("constant regex"));

fn place(value: &str) -> String {
    let value = trim(value).replace('\\', "/").to_lowercase();
    PLACE_NUMBER.replace_all(&value, "[$1]").into_owned()
}
pub(crate) fn manifest_place(value: &str) -> Option<String> {
    let value = place(value);
    let regex = if value.starts_with('/') {
        &*ASSET_PLACE
    } else {
        &*SOURCE_PLACE
    };
    regex.is_match(&value).then_some(value)
}
fn keys(
    j: &Joined,
    row: usize,
    tier: usize,
    loose: bool,
    counts: &HashMap<u32, (usize, usize)>,
) -> Result<Vec<String>> {
    let saved = j.saved(row);
    let source = if saved {
        j.line[L_SOURCE][row]
    } else {
        j.manifest_source(row)
    };
    if tier == 2 {
        return Ok(
            if source == j.empty
                || !loose && counts.get(&source).map(|v| if saved { v.1 } else { v.0 }) != Some(1)
            {
                Vec::new()
            } else {
                vec![source.to_string()]
            },
        );
    }
    let mut values = Vec::new();
    let g = j.groups[row];
    if saved {
        let c = &j.packages.occurrence;
        for i in &j.order[g.os..g.oe] {
            let i = *i as usize;
            let value = if tier == 0 {
                if c[O_LOCATION][i] == 2
                    || c[O_LOCATION][i] == 0 && j.string(c[O_PROPERTY][i]).is_empty()
                {
                    None
                } else {
                    Some(place(&if c[O_LOCATION][i] == 1 {
                        format!(
                            "{}.{}.{}",
                            j.string(c[O_OBJECT][i]),
                            j.string(c[O_ROW][i]),
                            j.string(c[O_PROPERTY][i])
                        )
                    } else {
                        format!(
                            "{}.{}",
                            j.string(c[O_OBJECT][i]),
                            j.string(c[O_PROPERTY][i])
                        )
                    }))
                }
            } else if source == j.empty {
                None
            } else {
                Some(format!(
                    "{}\0{source}",
                    file_key(&j.packages.relative_paths[j.packages.package_row[i] as usize])
                ))
            };
            if let Some(value) = value {
                values.push(value);
            }
        }
    } else {
        for i in &j.manifest.order[g.ms..g.me] {
            let path = j.manifest.path(*i as usize, &j.strings)?;
            let value = if tier == 0 {
                manifest_place(&path)
            } else if source == j.empty {
                None
            } else {
                Some(format!("{}\0{source}", file_key(&path)))
            };
            if let Some(value) = value {
                values.push(value);
            }
        }
    }
    let mut seen = HashSet::new();
    values.retain(|v| seen.insert(v.clone()));
    Ok(values)
}
fn index(
    j: &Joined,
    old: &[usize],
    paired: &[bool],
    tier: usize,
    loose: bool,
    counts: &HashMap<u32, (usize, usize)>,
) -> Result<HashMap<String, BTreeSet<usize>>> {
    let mut result = HashMap::<String, BTreeSet<usize>>::new();
    for row in old {
        if !paired[*row] {
            for key in keys(j, *row, tier, loose, counts)? {
                result.entry(key).or_default().insert(*row);
            }
        }
    }
    Ok(result)
}
fn reachable(
    j: &Joined,
    row: usize,
    tier: usize,
    loose: bool,
    index: &HashMap<String, BTreeSet<usize>>,
    counts: &HashMap<u32, (usize, usize)>,
) -> Result<BTreeSet<usize>> {
    let mut result = BTreeSet::new();
    for key in keys(j, row, tier, loose, counts)? {
        if let Some(rows) = index.get(&key) {
            result.extend(rows);
        }
    }
    Ok(result)
}
pub(crate) fn finish(
    store: &mut Store,
    input: &JoinInput,
    j: &mut Joined,
    cultures: &[String],
) -> Result<Value> {
    let count = j.groups.len();
    let old = (0..count)
        .filter(|row| !j.saved(*row) && j.resolved(*row) && j.matches(*row, 6))
        .collect::<Vec<_>>();
    let mut pairs = Vec::new();
    let mut ambiguous = 0;
    let mut paired = vec![false; count];
    if !old.is_empty() {
        let mut counts = old
            .iter()
            .map(|row| (j.manifest_source(*row), (0, 0)))
            .collect::<HashMap<_, _>>();
        for (row, _) in paired.iter().enumerate().take(count) {
            if j.groups[row].ms < j.groups[row].me
                && let Some(value) = counts.get_mut(&j.manifest_source(row))
            {
                value.0 += 1;
            }
            if j.saved(row)
                && let Some(value) = counts.get_mut(&j.line[L_SOURCE][row])
            {
                value.1 += 1;
            }
        }
        for tier in 0..3 {
            let idx = index(j, &old, &paired, tier, false, &counts)?;
            let mut forward = vec![None; count];
            let mut reverse = vec![0; count];
            for (row, _) in paired.iter().enumerate().take(count) {
                if !paired[row] && j.saved(row) && j.resolved(row) && j.matches(row, 4) {
                    let reachable = reachable(j, row, tier, false, &idx, &counts)?;
                    for old in &reachable {
                        reverse[*old] += 1;
                    }
                    if reachable.len() == 1 {
                        forward[row] = reachable.first().copied();
                    }
                }
            }
            for (row, _) in forward.iter().enumerate().take(count) {
                let Some(old) = forward[row] else {
                    continue;
                };
                if reverse[old] != 1 || paired[old] {
                    continue;
                }
                let translations = cultures
                    .iter()
                    .enumerate()
                    .filter(|(_, culture)| input.target["nativeCulture"] != culture.as_str())
                    .filter_map(|(ci, culture)| {
                        j.translation(old, ci)
                            .filter(|id| *id != j.empty)
                            .map(|id| json!({"culture":culture,"translation":j.string(id)}))
                    })
                    .collect::<Vec<_>>();
                pairs.push(json!({"from":{"namespace":j.string(j.line[L_NS][old]),"key":j.string(j.line[L_KEY][old])},"to":{"namespace":j.string(j.line[L_NS][row]),"key":j.string(j.line[L_KEY][row])},"match":(["same_place","same_text_in_package","same_text"][tier]),"sourceChanged":j.manifest_source(old)!=j.line[L_SOURCE][row],"previousSource":j.string(j.manifest_source(old)),"translations":translations}));
                j.line[15][row] = pairs.len() as u32 * 2;
                j.line[15][old] = pairs.len() as u32 * 2 + 1;
                paired[row] = true;
                paired[old] = true;
            }
        }
        let indexes = (0..3)
            .map(|tier| index(j, &old, &paired, tier, true, &counts))
            .collect::<Result<Vec<_>>>()?;
        for (row, _) in paired.iter().enumerate().take(count) {
            if !paired[row] && j.saved(row) && j.resolved(row) && j.matches(row, 4) {
                for (tier, index) in indexes.iter().enumerate() {
                    if !reachable(j, row, tier, true, index, &counts)?.is_empty() {
                        ambiguous += 1;
                        break;
                    }
                }
            }
        }
    }
    if let Some(external) = input
        .key_change_pairs
        .as_ref()
        .and_then(Value::as_array)
        .filter(|pairs| !pairs.is_empty())
    {
        // expand_policy already converted these strings into reversible scalar views.
        let external = external.clone();
        let mut used = HashSet::new();
        pairs.extend(external);
        pairs.retain(|pair| {
            let from = (
                pair["from"]["namespace"].as_str().unwrap_or("").to_owned(),
                pair["from"]["key"].as_str().unwrap_or("").to_owned(),
            );
            let to = (
                pair["to"]["namespace"].as_str().unwrap_or("").to_owned(),
                pair["to"]["key"].as_str().unwrap_or("").to_owned(),
            );
            if used.contains(&from) || used.contains(&to) {
                return false;
            }
            used.insert(from);
            used.insert(to);
            true
        });
        let values = pairs
            .iter()
            .flat_map(|pair| {
                [
                    pair["to"]["namespace"].as_str().unwrap_or("").to_owned(),
                    pair["to"]["key"].as_str().unwrap_or("").to_owned(),
                    pair["from"]["namespace"].as_str().unwrap_or("").to_owned(),
                    pair["from"]["key"].as_str().unwrap_or("").to_owned(),
                ]
            })
            .collect::<Vec<_>>();
        let ids = intern(store, &mut j.strings, "identity", &values)?;
        let mut changes = HashMap::new();
        for index in 0..pairs.len() {
            changes.insert((ids[index * 4], ids[index * 4 + 1]), (index as u32 + 1) * 2);
            changes.insert(
                (ids[index * 4 + 2], ids[index * 4 + 3]),
                (index as u32 + 1) * 2 + 1,
            );
        }
        for (row, _) in paired.iter().enumerate().take(count) {
            j.line[15][row] = if j.resolved(row) {
                changes
                    .get(&(j.line[L_NS][row], j.line[L_KEY][row]))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
        }
    }
    if let Some(review) = &input.review
        && review["target"] == input.target["name"]
    {
        let records = review["records"].as_array().ok_or("review records")?;
        let values = records
            .iter()
            .flat_map(|r| {
                [
                    r["namespace"].as_str().unwrap_or("").to_owned(),
                    r["key"].as_str().unwrap_or("").to_owned(),
                ]
            })
            .collect::<Vec<_>>();
        let ids = intern(store, &mut j.strings, "identity", &values)?;
        let mut map = HashMap::new();
        for (row, record) in records.iter().enumerate() {
            map.insert(
                (
                    record["culture"]
                        .as_str()
                        .ok_or("review culture")?
                        .to_owned(),
                    ids[row * 2],
                    ids[row * 2 + 1],
                ),
                row,
            );
        }
        for (row, _) in paired.iter().enumerate().take(count) {
            if j.resolved(row) {
                for (ci, culture) in cultures.iter().enumerate() {
                    j.cultures[ci][5][row] = 1;
                    if let Some(index) =
                        map.get(&(culture.clone(), j.line[L_NS][row], j.line[L_KEY][row]))
                    {
                        let source = j.string(j.manifest_source(row));
                        let translation = j
                            .translation(row, ci)
                            .map(|id| j.string(id))
                            .unwrap_or("\0absent");
                        let source_bytes = crate::wtf8::Wtf8Buf::from_view(source);
                        let translation_bytes = crate::wtf8::Wtf8Buf::from_view(translation);
                        let fingerprint = digest(
                            format!(
                                "{}\0{}",
                                // Published review fingerprints hash TextEncoder's UTF-8 bytes.
                                // Lossy conversion is restricted to this existing hash policy;
                                // the source and translation columns remain lossless WTF-8.
                                String::from_utf16_lossy(&source_bytes.to_utf16()),
                                String::from_utf16_lossy(&translation_bytes.to_utf16())
                            )
                            .as_bytes(),
                        );
                        j.cultures[ci][5][row] = if records[*index]["fingerprint"] == fingerprint {
                            2
                        } else {
                            3
                        };
                        j.cultures[ci][6][row] = *index as u32 + 1;
                    }
                }
            }
        }
    }
    for (row, _) in paired.iter().enumerate().take(count) {
        // The saved-signal finding from the join, the key change, and every culture's mark, as
        // the engine classifies a line under a request that names no finding.
        let mut problems = j.line[L_PROBLEMS][row];
        if j.line[15][row] != 0 && j.line[15][row] & 1 == 0 {
            problems |= crate::text_problem::KEY_CHANGED;
        }
        for c in &j.cultures {
            problems |= crate::text_problem::culture(c[0][row], c[1][row], c[2][row]);
        }
        j.line[L_PROBLEMS][row] = crate::text_problem::settle(problems);
    }
    Ok(json!({"pairs":pairs,"ambiguous":ambiguous,"oldCandidates":old.len()}))
}

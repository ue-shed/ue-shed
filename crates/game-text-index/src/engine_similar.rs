//! Similar keys: a key that left the manifest and a new key whose text is nearly the same, such
//! as a typo fix or a changed reference that also gave the text a new key, where the join's exact
//! key-change tiers found no pair. A fourth tier after them, answered by `related` only: it never
//! changes the join, its `key_changed` marks or their counts.
//!
//! Earlier lines are the target's visible lines without saved places in state `not_found`; new
//! lines are its visible lines with saved places in state `not_gathered` and a gathered identity.
//! Lines the exact tiers paired, lines with blank or trivial text, are left out. Each new line's
//! nearest earlier lines come from the earlier lines that share one of its package files (the
//! join's own grouping: a saved line's package files, an earlier line's manifest files), and only
//! when none is near enough from those of a similar length anywhere. A pair is strictly one to
//! one: a new line proposes its single nearest earlier line, and an earlier line accepts its
//! single nearest proposal.
//!
//! The index covers the whole target, so the one-to-one rule is decided globally. A reader builds
//! it once, on the first request that asks for it, for one set of policy parameters.
use crate::cache::Lock;
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::{MAX_SECTION_ROWS, invalid};
use crate::join_policy::js_space;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock};
use std::time::Instant;
#[cfg(test)]
use ts_rs::TS;

/// The policy defaults: the edit a small change may make, as a share of the longer text's
/// length; the length difference the cross-package pass reaches, as a share of a new line's
/// length; the cap on both; the comparisons after which the cross-package pass stops; and the
/// letters a text needs to be compared at all.
pub const DISTANCE_RATIO: f64 = 0.2;
pub const REACH_RATIO: f64 = 0.25;
pub const MAX_DISTANCE: u32 = 12;
pub const COMPARISON_BUDGET: u32 = 2_000_000;
pub const MIN_LETTERS: u32 = 2;
/// The highest `maxDistance` and `minLetters` a request may set.
const POLICY_CAP: u32 = 64;
/// New lines matched between cancellation checks.
const CHECK_LINES: usize = 16;
/// Lines classified between cancellation checks.
const CHECK_ROWS: usize = 1024;
/// The localization states the two sides are in, as `STATES` numbers them.
const NOT_GATHERED: u32 = 4;
const NOT_FOUND: u32 = 6;

/// The `similarKeys` section of `related`: the selected line's similar-key pair and its nearest
/// candidates. Every policy field is optional, with the default documented on it; a reader keeps
/// the index of one parameter set, and other parameters build it again.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimilarKeysSection {
    /// Candidates listed, from 0 to 500.
    pub limit: u32,
    /// The most edits two texts may differ by, as a share of the longer one's UTF-16 length,
    /// rounded down and at least 1: above 0, at most 1. Default 0.2.
    #[cfg_attr(test, ts(optional))]
    pub distance_ratio: Option<f64>,
    /// The length difference the cross-package pass reaches, as a share of the new line's UTF-16
    /// length, rounded up and at least 1: above 0, at most 1. Default 0.25.
    #[cfg_attr(test, ts(optional))]
    pub reach_ratio: Option<f64>,
    /// The cap on both the edit distance and the reach, from 1 to 64. Default 12.
    #[cfg_attr(test, ts(optional))]
    pub max_distance: Option<u32>,
    /// Comparisons after which no further new line runs the cross-package pass; the answer is
    /// then `truncated`. The same-package pass always runs. Default 2,000,000.
    #[cfg_attr(test, ts(optional))]
    pub comparison_budget: Option<u32>,
    /// Letters (`\p{L}`) a text needs outside `{...}` and `<...>` spans to be compared, from 0
    /// (compare every non-blank text) to 64. Default 2.
    #[cfg_attr(test, ts(optional))]
    pub min_letters: Option<u32>,
}

impl SimilarKeysSection {
    pub fn validate(&self) -> Result<()> {
        require(
            self.limit <= MAX_SECTION_ROWS,
            invalid("Similar keys list between 0 and 500 candidates."),
        )?;
        let ratio = |value: Option<f64>| value.is_none_or(|value| value > 0.0 && value <= 1.0);
        require(
            ratio(self.distance_ratio) && ratio(self.reach_ratio),
            invalid("A similar-key ratio is above 0 and at most 1."),
        )?;
        require(
            self.max_distance
                .is_none_or(|value| (1..=POLICY_CAP).contains(&value)),
            invalid("A similar key's maximum distance is between 1 and 64."),
        )?;
        require(
            self.min_letters.is_none_or(|value| value <= POLICY_CAP),
            invalid("A similar key's minimum letters are between 0 and 64."),
        )?;
        Ok(())
    }

    pub(crate) fn policy(&self) -> Policy {
        Policy {
            distance_ratio: self.distance_ratio.unwrap_or(DISTANCE_RATIO),
            reach_ratio: self.reach_ratio.unwrap_or(REACH_RATIO),
            max_distance: self.max_distance.unwrap_or(MAX_DISTANCE),
            comparison_budget: self.comparison_budget.unwrap_or(COMPARISON_BUDGET),
            min_letters: self.min_letters.unwrap_or(MIN_LETTERS),
        }
    }
}

/// A request's policy with its defaults applied: the key of a reader's cached index.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Policy {
    pub distance_ratio: f64,
    pub reach_ratio: f64,
    pub max_distance: u32,
    pub comparison_budget: u32,
    pub min_letters: u32,
}

impl Default for Policy {
    fn default() -> Self {
        SimilarKeysSection {
            limit: 0,
            distance_ratio: None,
            reach_ratio: None,
            max_distance: None,
            comparison_budget: None,
            min_letters: None,
        }
        .policy()
    }
}

impl Policy {
    /// The most edits two texts of these UTF-16 lengths may differ by.
    fn limit(&self, a: usize, b: usize) -> u32 {
        ((a.max(b) as f64 * self.distance_ratio).floor() as u32)
            .max(1)
            .min(self.max_distance)
    }
    /// The length difference the cross-package pass reaches from a text this long.
    fn reach(&self, length: usize) -> usize {
        ((length as f64 * self.reach_ratio).ceil() as u32)
            .max(1)
            .min(self.max_distance) as usize
    }
}

/// Which side of a similar-key pair a line is on.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SimilarKeyState {
    /// An earlier key: gathered, and no longer in any package.
    NotFound,
    /// A new key: in packages, and not gathered yet.
    NotGathered,
}

/// How a new line found an earlier one: among those sharing one of its package files, or, when
/// none of those was near enough, among those of a similar length anywhere.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "snake_case")]
pub enum SimilarKeyScope {
    SamePackage,
    CrossPackage,
}

/// The other line of a pair or candidate.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SimilarKeyLine {
    pub id: String,
    pub namespace: String,
    pub key: String,
    pub source: String,
    pub state: SimilarKeyState,
}

/// One culture's translation of the earlier line, as the next sync ships it (a line's culture
/// marks carry it as `translation`): only the target's other cultures, and none that is empty.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SimilarKeyTranslation {
    pub culture: String,
    pub translation: String,
}

/// The selected line's one-to-one similar-key pair.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SimilarKeyPair {
    pub line: SimilarKeyLine,
    /// Edits between the two lines' comparable texts, in UTF-16 code units.
    pub distance: u32,
    pub scope: SimilarKeyScope,
    /// The earlier line's translations, which a repair carries to the new key.
    pub translations: Vec<SimilarKeyTranslation>,
}

/// A line near the selected one.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SimilarKeyCandidate {
    pub line: SimilarKeyLine,
    pub distance: u32,
    pub scope: SimilarKeyScope,
}

/// The `similarKeys` section of a `related` answer.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SimilarKeysAnswer {
    /// The selected line's side, absent when it is neither an earlier nor a new line the matcher
    /// compares.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub state: Option<SimilarKeyState>,
    /// The selected line's pair, when the one-to-one rule gives it one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub pair: Option<SimilarKeyPair>,
    /// The lines near the selected one, the pair's line among them, nearest first, then
    /// same-package before cross-package, then by line ID; up to the request's `limit`. A new
    /// line lists the earlier lines its deciding pass found within the distance limit; an earlier
    /// line, the new lines that found it.
    pub candidates: Vec<SimilarKeyCandidate>,
    pub candidates_complete: bool,
    /// Pairs in the whole target.
    pub pairs: u32,
    /// The comparison budget ran out: some new lines skipped the cross-package pass.
    pub truncated: bool,
    /// Milliseconds this request spent building the reader's index; 0 when it reused it.
    pub build_ms: f64,
}

/// A line near another: the other line's row, their distance and how it was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Near {
    other: u32,
    distance: u32,
    same_package: bool,
}

/// One target's similar keys under one policy: only the pairs and each line's ranked near lines.
pub(crate) struct SimilarKeys {
    policy: Policy,
    pairs: HashMap<u32, Near>,
    near: HashMap<u32, Vec<Near>>,
    truncated: bool,
}

/// A line the matcher compares: its row, comparable text and package files.
#[derive(Clone, Debug, Default)]
pub(crate) struct Candidate {
    pub row: u32,
    pub text: Vec<u16>,
    pub packages: Vec<u32>,
}

/// A new line's match with an earlier line: rows of the new and the earlier line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Match {
    pub fresh: u32,
    pub earlier: u32,
    pub distance: u32,
    pub same_package: bool,
}

/// What the matcher found over a target's candidates.
#[derive(Debug, Default)]
pub(crate) struct Matched {
    pub pairs: Vec<Match>,
    /// Every match within the distance limit of a new line's deciding pass.
    pub near: Vec<Match>,
    pub comparisons: u64,
    pub truncated: bool,
}

#[expect(
    clippy::expect_used,
    reason = "the regexes are source literals exercised by the trivial-text tests"
)]
static ARGUMENTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{[^{}]*\}").expect("constant regex"));
#[expect(
    clippy::expect_used,
    reason = "the regexes are source literals exercised by the trivial-text tests"
)]
static MARKUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^<>]*>").expect("constant regex"));
#[expect(
    clippy::expect_used,
    reason = "the regexes are source literals exercised by the trivial-text tests"
)]
static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}").expect("constant regex"));

fn space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js_space)
}

/// Whether a text has fewer than `min_letters` letters once `{...}` and `<...>` spans are
/// removed: numbers, punctuation, format arguments and markup are fine to repeat under any key.
pub(crate) fn trivial(units: &[u16], min_letters: u32) -> bool {
    if min_letters == 0 {
        return false;
    }
    // Lone surrogates become U+FFFD, which is neither a letter nor a brace.
    let text = String::from_utf16_lossy(units);
    let text = ARGUMENTS.replace_all(&text, "");
    let text = MARKUP.replace_all(&text, "");
    LETTER.find_iter(&text).take(min_letters as usize).count() < min_letters as usize
}

/// A text as the matcher compares it: whitespace runs collapsed to one space, trimmed, and
/// lowercased. JavaScript's `\s` and `trim` decide what whitespace is. Rust's `to_lowercase` is
/// not locale-aware, where the reference's `toLocaleLowerCase` follows the host's locale.
pub(crate) fn comparable(units: &[u16]) -> Vec<u16> {
    let mut collapsed = Vec::with_capacity(units.len());
    let mut in_space = false;
    for unit in units {
        if space(*unit) {
            in_space = true;
            continue;
        }
        if in_space && !collapsed.is_empty() {
            collapsed.push(u16::from(b' '));
        }
        in_space = false;
        collapsed.push(*unit);
    }
    // Lowercase each run of valid UTF-16, so final sigma reads its context; lone surrogates stay.
    let mut lowered = Vec::with_capacity(collapsed.len());
    let mut run = String::new();
    for item in char::decode_utf16(collapsed.iter().copied()) {
        match item {
            Ok(character) => run.push(character),
            Err(error) => {
                lowered.extend(run.to_lowercase().encode_utf16());
                run.clear();
                lowered.push(error.unpaired_surrogate());
            }
        }
    }
    lowered.extend(run.to_lowercase().encode_utf16());
    lowered
}

/// Levenshtein distance over UTF-16 code units, or `limit + 1` when it is more than `limit`. Only
/// the diagonal band of `limit` cells either side is computed: no path outside it costs `limit`
/// or less, so within the limit the result is the full matrix's.
pub(crate) fn edit_distance(a: &[u16], b: &[u16], limit: u32, rows: &mut [Vec<u32>; 2]) -> u32 {
    if a == b {
        return 0;
    }
    let (n, m) = (a.len(), b.len());
    let band = limit as usize;
    let over = limit + 1;
    if n.abs_diff(m) > band {
        return over;
    }
    if n == 0 || m == 0 {
        return (n.max(m) as u32).min(over);
    }
    let [previous, current] = rows;
    previous.clear();
    previous.extend((0..=m).map(|j| (j as u32).min(over)));
    current.clear();
    current.resize(m + 1, over);
    for i in 1..=n {
        let low = i.saturating_sub(band).max(1);
        let high = (i + band).min(m);
        current[0] = (i as u32).min(over);
        current[low - 1] = if low == 1 { current[0] } else { over };
        let mut best = current[low - 1];
        let unit = a[i - 1];
        for j in low..=high {
            let cost = u32::from(unit != b[j - 1]);
            let value = (previous[j] + 1)
                .min(current[j - 1] + 1)
                .min(previous[j - 1] + cost)
                .min(over);
            current[j] = value;
            best = best.min(value);
        }
        if high < m {
            current[high + 1] = over;
        }
        if best > limit {
            return over;
        }
        std::mem::swap(previous, current);
    }
    previous[m].min(over)
}

/// Pairs new lines with earlier ones as the module documents. Lines are matched in the order
/// given; the order decides only which new lines skip the cross-package pass once the budget
/// runs out.
pub(crate) fn match_lines(
    earlier: &[Candidate],
    fresh: &[Candidate],
    policy: &Policy,
    cancelled: &AtomicBool,
) -> Result<Matched> {
    let mut by_package = HashMap::<u32, Vec<u32>>::new();
    for (index, line) in earlier.iter().enumerate() {
        for package in &line.packages {
            let list = by_package.entry(*package).or_default();
            if list.last() != Some(&(index as u32)) {
                list.push(index as u32);
            }
        }
    }
    let mut by_length = (0..earlier.len() as u32).collect::<Vec<_>>();
    by_length.sort_by_key(|index| earlier[*index as usize].text.len());
    let lengths = by_length
        .iter()
        .map(|index| earlier[*index as usize].text.len())
        .collect::<Vec<_>>();
    let mut matched = Matched::default();
    let mut rows = [Vec::new(), Vec::new()];
    let mut seen = vec![u32::MAX; earlier.len()];
    let mut local = Vec::new();
    let mut found = Vec::new();
    // The earlier lines tied nearest to `line` in `pool`, and every one within the limit.
    let mut nearest = |line: &Candidate,
                       pool: &mut dyn Iterator<Item = u32>,
                       comparisons: &mut u64,
                       found: &mut Vec<(u32, u32)>|
     -> u32 {
        found.clear();
        let mut best = u32::MAX;
        for index in pool {
            let other = &earlier[index as usize].text;
            let limit = policy.limit(line.text.len(), other.len());
            if line.text.len().abs_diff(other.len()) > limit as usize {
                continue;
            }
            *comparisons += 1;
            let distance = edit_distance(&line.text, other, limit, &mut rows);
            if distance > limit {
                continue;
            }
            best = best.min(distance);
            found.push((index, distance));
        }
        best
    };
    let mut proposals = Vec::<Match>::new();
    for (position, line) in fresh.iter().enumerate() {
        if position % CHECK_LINES == 0 {
            checkpoint(cancelled)?;
        }
        local.clear();
        for package in &line.packages {
            for index in by_package.get(package).into_iter().flatten() {
                if seen[*index as usize] != position as u32 {
                    seen[*index as usize] = position as u32;
                    local.push(*index);
                }
            }
        }
        let mut same_package = true;
        let mut best = nearest(
            line,
            &mut local.iter().copied(),
            &mut matched.comparisons,
            &mut found,
        );
        if found.is_empty() {
            if matched.comparisons > u64::from(policy.comparison_budget) {
                matched.truncated = true;
                continue;
            }
            same_package = false;
            let length = line.text.len();
            let reach = policy.reach(length);
            let start = lengths.partition_point(|other| *other + reach < length);
            let end = lengths.partition_point(|other| *other <= length + reach);
            best = nearest(
                line,
                &mut by_length[start..end].iter().copied(),
                &mut matched.comparisons,
                &mut found,
            );
        }
        let mut nearest_count = 0;
        for (index, distance) in &found {
            let item = Match {
                fresh: line.row,
                earlier: earlier[*index as usize].row,
                distance: *distance,
                same_package,
            };
            if *distance == best {
                nearest_count += 1;
                if nearest_count == 1 {
                    proposals.push(item);
                }
            }
            matched.near.push(item);
        }
        if nearest_count > 1 {
            proposals.pop();
        }
    }
    // Each earlier line pairs once, with its single nearest proposal.
    let mut by_earlier = HashMap::<u32, (Match, bool)>::new();
    for proposal in proposals {
        by_earlier
            .entry(proposal.earlier)
            .and_modify(|(best, tied)| {
                if proposal.distance < best.distance {
                    *best = proposal;
                    *tied = false;
                } else if proposal.distance == best.distance {
                    *tied = true;
                }
            })
            .or_insert((proposal, false));
    }
    matched.pairs = by_earlier
        .into_values()
        .filter(|(_, tied)| !tied)
        .map(|(pair, _)| pair)
        .collect();
    matched.pairs.sort_by_key(|pair| pair.fresh);
    Ok(matched)
}

impl EngineQuery {
    /// Whether a line is one the matcher compares, and on which side, with its comparable text.
    fn similar_candidate(
        &self,
        p: &Projection,
        empty: &std::collections::BTreeSet<u32>,
        row: usize,
        policy: &Policy,
    ) -> Result<Option<(SimilarKeyState, Vec<u16>)>> {
        let saved = p.starts[row] != p.starts[row + 1];
        if p.source_visible[row] == 0 || saved && !p.saved_visible[row] || p.key_change[row] != 0 {
            return Ok(None);
        }
        let in_state = |state: u32| p.cultures.iter().any(|c| c.state[row] == state);
        let side = if saved {
            // A saved line with an empty key has no gathered identity.
            (in_state(NOT_GATHERED) && !empty.contains(&p.key[row]))
                .then_some(SimilarKeyState::NotGathered)
        } else {
            in_state(NOT_FOUND).then_some(SimilarKeyState::NotFound)
        };
        let Some(side) = side else {
            return Ok(None);
        };
        let units = Wtf8Buf::from_view(&self.reader.string(p.source[row])?).to_utf16();
        if units.iter().all(|unit| space(*unit)) || trivial(&units, policy.min_letters) {
            return Ok(None);
        }
        Ok(Some((side, comparable(&units))))
    }

    /// The reader's similar keys under `policy`, built on first use and again for another policy.
    /// Returns the index and the milliseconds this call spent building it.
    fn similar_keys_index(
        &self,
        policy: &Policy,
        cancelled: &AtomicBool,
    ) -> Result<(Arc<SimilarKeys>, f64)> {
        if let Some(index) = self.similar_keys.lock().as_ref()
            && index.policy == *policy
        {
            return Ok((Arc::clone(index), 0.0));
        }
        let started = Instant::now();
        let p = Projection::open(self, cancelled)?;
        let empty = self.reader.empty_string_ids()?;
        let mut rank = vec![0u32; p.source.len()];
        let mut package_ids = HashMap::<u32, u32>::new();
        let mut package_keys = HashMap::<String, u32>::new();
        let (mut earlier, mut fresh) = (Vec::new(), Vec::new());
        for (position, row) in p.order.iter().enumerate() {
            if position % CHECK_ROWS == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            rank[row] = position as u32;
            let Some((side, text)) = self.similar_candidate(&p, &empty, row, policy)? else {
                continue;
            };
            // The join's package files: a saved line's packages, an earlier line's manifest
            // files, compared as `file_key` compares them.
            let mut packages = Vec::new();
            for file in &p.files[p.file_start[row] as usize..p.file_end[row] as usize] {
                let package = match package_ids.get(file) {
                    Some(package) => *package,
                    None => {
                        let key = self.reader.string(*file)?.to_lowercase();
                        let next = package_keys.len() as u32;
                        let package = *package_keys.entry(key).or_insert(next);
                        package_ids.insert(*file, package);
                        package
                    }
                };
                if !packages.contains(&package) {
                    packages.push(package);
                }
            }
            let line = Candidate {
                row: row as u32,
                text,
                packages,
            };
            match side {
                SimilarKeyState::NotFound => earlier.push(line),
                SimilarKeyState::NotGathered => fresh.push(line),
            }
        }
        let matched = match_lines(&earlier, &fresh, policy, cancelled)?;
        drop((earlier, fresh));
        let mut pairs = HashMap::new();
        for pair in &matched.pairs {
            let near = |other| Near {
                other,
                distance: pair.distance,
                same_package: pair.same_package,
            };
            pairs.insert(pair.fresh, near(pair.earlier));
            pairs.insert(pair.earlier, near(pair.fresh));
        }
        let mut near = HashMap::<u32, Vec<Near>>::new();
        for item in &matched.near {
            let entry = |other| Near {
                other,
                distance: item.distance,
                same_package: item.same_package,
            };
            near.entry(item.fresh)
                .or_default()
                .push(entry(item.earlier));
            near.entry(item.earlier)
                .or_default()
                .push(entry(item.fresh));
        }
        for list in near.values_mut() {
            list.sort_by_key(|item| (item.distance, !item.same_package, rank[item.other as usize]));
            list.truncate(MAX_SECTION_ROWS as usize + 1);
            list.shrink_to_fit();
        }
        let index = Arc::new(SimilarKeys {
            policy: *policy,
            pairs,
            near,
            truncated: matched.truncated,
        });
        *self.similar_keys.lock() = Some(Arc::clone(&index));
        Ok((index, started.elapsed().as_secs_f64() * 1000.0))
    }

    /// The `similarKeys` section for a selected line, or for none when a unit outside lines is
    /// selected.
    pub(crate) fn similar_keys(
        &self,
        line: Option<usize>,
        section: &SimilarKeysSection,
        cancelled: &AtomicBool,
    ) -> Result<SimilarKeysAnswer> {
        let policy = section.policy();
        let (index, build_ms) = self.similar_keys_index(&policy, cancelled)?;
        let mut answer = SimilarKeysAnswer {
            state: None,
            pair: None,
            candidates: Vec::new(),
            candidates_complete: true,
            pairs: (index.pairs.len() / 2) as u32,
            truncated: index.truncated,
            build_ms,
        };
        let Some(row) = line else {
            return Ok(answer);
        };
        let p = Projection::open(self, cancelled)?;
        let empty = self.reader.empty_string_ids()?;
        let Some((state, _)) = self.similar_candidate(&p, &empty, row, &policy)? else {
            return Ok(answer);
        };
        let other_state = match state {
            SimilarKeyState::NotFound => SimilarKeyState::NotGathered,
            SimilarKeyState::NotGathered => SimilarKeyState::NotFound,
        };
        let scope = |same_package| {
            if same_package {
                SimilarKeyScope::SamePackage
            } else {
                SimilarKeyScope::CrossPackage
            }
        };
        let row_key = row as u32;
        if let Some(pair) = index.pairs.get(&row_key) {
            let earlier = match state {
                SimilarKeyState::NotFound => row,
                SimilarKeyState::NotGathered => pair.other as usize,
            };
            answer.pair = Some(SimilarKeyPair {
                line: self.similar_line(&p, pair.other as usize, other_state)?,
                distance: pair.distance,
                scope: scope(pair.same_package),
                translations: self.carried_translations(&p, earlier)?,
            });
        }
        let near = index.near.get(&row_key).map_or(&[][..], Vec::as_slice);
        for item in near.iter().take(section.limit as usize) {
            checkpoint(cancelled)?;
            answer.candidates.push(SimilarKeyCandidate {
                line: self.similar_line(&p, item.other as usize, other_state)?,
                distance: item.distance,
                scope: scope(item.same_package),
            });
        }
        answer.candidates_complete = near.len() <= section.limit as usize;
        answer.state = Some(state);
        Ok(answer)
    }

    fn similar_line(
        &self,
        p: &Projection,
        row: usize,
        state: SimilarKeyState,
    ) -> Result<SimilarKeyLine> {
        Ok(SimilarKeyLine {
            id: self.packed("line", row)?,
            namespace: self.reader.string(p.namespace[row])?,
            key: self.reader.string(p.key[row])?,
            source: self.reader.string(p.source[row])?,
            state,
        })
    }

    /// The translations a line's culture marks carry, other than the native culture's and empty
    /// ones.
    fn carried_translations(
        &self,
        p: &Projection,
        row: usize,
    ) -> Result<Vec<SimilarKeyTranslation>> {
        let native = self.target["nativeCulture"].as_str();
        let mut translations = Vec::new();
        for (ci, culture) in self.cultures.iter().enumerate() {
            if Some(culture.as_str()) == native {
                continue;
            }
            let not_synced = p.cultures[ci].facts[row] & 8 != 0;
            if let Some(translation) = self.shipped_translation(ci, row, not_synced)?
                && !translation.is_empty()
            {
                translations.push(SimilarKeyTranslation {
                    culture: culture.clone(),
                    translation,
                });
            }
        }
        Ok(translations)
    }
}

/// A reader's cached similar keys: one policy's index at a time.
pub(crate) type SimilarKeysCache = Lock<Option<Arc<SimilarKeys>>>;

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    /// The reference's full-matrix Levenshtein with its early exit.
    fn full_distance(a: &[u16], b: &[u16], limit: u32) -> u32 {
        if a == b {
            return 0;
        }
        if a.len().abs_diff(b.len()) > limit as usize {
            return limit + 1;
        }
        if a.is_empty() {
            return b.len() as u32;
        }
        if b.is_empty() {
            return a.len() as u32;
        }
        let mut previous = (0..=b.len() as u32).collect::<Vec<_>>();
        for i in 1..=a.len() {
            let mut current = vec![i as u32];
            let mut best = i as u32;
            for j in 1..=b.len() {
                let cost = u32::from(a[i - 1] != b[j - 1]);
                let value = (previous[j] + 1)
                    .min(current[j - 1] + 1)
                    .min(previous[j - 1] + cost);
                current.push(value);
                best = best.min(value);
            }
            if best > limit {
                return limit + 1;
            }
            previous = current;
        }
        previous[b.len()]
    }

    fn line(row: u32, text: &str, packages: &[u32]) -> Candidate {
        Candidate {
            row,
            text: comparable(&utf16(text)),
            packages: packages.to_vec(),
        }
    }

    fn pairs(matched: &Matched) -> Vec<(u32, u32, u32, bool)> {
        matched
            .pairs
            .iter()
            .map(|pair| (pair.fresh, pair.earlier, pair.distance, pair.same_package))
            .collect()
    }

    #[test]
    fn the_banded_distance_is_the_full_matrix_distance_within_the_limit() {
        let mut rows = [Vec::new(), Vec::new()];
        let mut seed = 0x2545_f491_u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for _ in 0..4000 {
            let length = (next() % 24) as usize;
            let a = (0..length)
                .map(|_| u16::from(b'a') + (next() % 4) as u16)
                .collect::<Vec<_>>();
            let mut b = a.clone();
            for _ in 0..next() % 6 {
                let at = if b.is_empty() {
                    0
                } else {
                    next() as usize % b.len()
                };
                match next() % 3 {
                    0 if !b.is_empty() => {
                        b.remove(at);
                    }
                    1 => b.insert(at, u16::from(b'a') + (next() % 4) as u16),
                    _ if !b.is_empty() => b[at] = u16::from(b'a') + (next() % 4) as u16,
                    _ => {}
                }
            }
            let limit = 1 + next() % 6;
            let full = full_distance(&a, &b, limit);
            let banded = edit_distance(&a, &b, limit, &mut rows);
            if full <= limit {
                assert_eq!(banded, full, "{a:?} {b:?} {limit}");
            } else {
                assert!(banded > limit, "{a:?} {b:?} {limit}");
            }
        }
    }

    #[test]
    fn distances_count_utf16_code_units() {
        let mut rows = [Vec::new(), Vec::new()];
        // One astral character is two code units: replacing it with a BMP letter costs two.
        assert_eq!(
            edit_distance(&utf16("Fire 🔥 now"), &utf16("Fire x now"), 4, &mut rows),
            2
        );
        assert_eq!(
            edit_distance(&utf16("Fire 🔥 now"), &utf16("Fire 🔥 now"), 4, &mut rows),
            0
        );
        // Two astral characters sharing a high surrogate differ in one unit.
        assert_eq!(
            edit_distance(&utf16("Go 😀"), &utf16("Go 😁"), 1, &mut rows),
            1
        );
        assert_eq!(edit_distance(&utf16("abc"), &utf16("xyz"), 1, &mut rows), 2);
    }

    #[test]
    fn comparable_text_collapses_javascript_whitespace_and_lowercases() {
        assert_eq!(
            String::from_utf16_lossy(&comparable(&utf16("\u{feff} Open\t\n THE\u{3000}Door  "))),
            "open the door"
        );
        // U+0085 is Rust whitespace but not JavaScript's.
        assert_eq!(
            String::from_utf16_lossy(&comparable(&utf16("A\u{85}B"))),
            "a\u{85}b"
        );
        // A lone surrogate stays where it was.
        let mut units = utf16("AB");
        units.insert(1, 0xd800);
        assert_eq!(
            comparable(&units),
            [u16::from(b'a'), 0xd800, u16::from(b'b')]
        );
    }

    #[test]
    fn trivial_text_has_too_few_letters_outside_arguments_and_markup() {
        for text in [
            "{Count}",
            "<b>{0}</>",
            "A",
            "12:30",
            "{Name} x <img id=\"Coin\"/>",
            "",
        ] {
            assert!(trivial(&utf16(text), 2), "{text}");
        }
        for text in ["Ok", "{Count} items", "日本"] {
            assert!(!trivial(&utf16(text), 2), "{text}");
        }
        assert!(!trivial(&utf16("{Count}"), 0));
        assert!(trivial(&utf16("Ok"), 3));
    }

    #[test]
    fn a_typo_fix_pairs_one_to_one() -> Result<()> {
        let earlier = [
            line(1, "Recieve the reward", &[]),
            line(2, "Totally unrelated", &[]),
        ];
        let fresh = [
            line(10, "Receive the reward", &[]),
            line(11, "Something else", &[]),
        ];
        let matched = match_lines(
            &earlier,
            &fresh,
            &Policy::default(),
            &AtomicBool::new(false),
        )?;
        assert_eq!(pairs(&matched), [(10, 1, 2, false)]);
        assert!(!matched.truncated);
        Ok(())
    }

    #[test]
    fn two_equally_near_new_keys_leave_an_earlier_key_unpaired() -> Result<()> {
        let earlier = [line(1, "Open the door", &[])];
        let fresh = [
            line(10, "Open the doors", &[]),
            line(11, "Open the doom", &[]),
        ];
        let matched = match_lines(
            &earlier,
            &fresh,
            &Policy::default(),
            &AtomicBool::new(false),
        )?;
        assert_eq!(pairs(&matched), []);
        assert_eq!(matched.near.len(), 2);
        // And a new key with two equally near earlier keys proposes neither.
        let earlier = [
            line(1, "Open the doors", &[]),
            line(2, "Open the doom", &[]),
        ];
        let fresh = [line(10, "Open the door", &[])];
        let matched = match_lines(
            &earlier,
            &fresh,
            &Policy::default(),
            &AtomicBool::new(false),
        )?;
        assert_eq!(pairs(&matched), []);
        assert_eq!(matched.near.len(), 2);
        Ok(())
    }

    #[test]
    fn the_cross_package_pass_runs_only_when_the_same_package_pass_finds_nothing() -> Result<()> {
        // The cross-package earlier line is nearer, but the same-package pass found one.
        let earlier = [
            line(1, "Collect the golden key", &[7]),
            line(2, "Collect the golden keys", &[8]),
        ];
        let fresh = [line(10, "Collect the golden keys!", &[7])];
        let matched = match_lines(
            &earlier,
            &fresh,
            &Policy::default(),
            &AtomicBool::new(false),
        )?;
        assert_eq!(pairs(&matched), [(10, 1, 2, true)]);
        assert_eq!(
            matched
                .near
                .iter()
                .map(|item| item.earlier)
                .collect::<Vec<_>>(),
            [1]
        );
        // With nothing near in its package, the new line reaches across packages.
        let earlier = [
            line(1, "A completely different text", &[7]),
            line(2, "Collect the golden keys", &[8]),
        ];
        let matched = match_lines(
            &earlier,
            &fresh,
            &Policy::default(),
            &AtomicBool::new(false),
        )?;
        assert_eq!(pairs(&matched), [(10, 2, 1, false)]);
        Ok(())
    }

    #[test]
    fn the_budget_stops_the_cross_package_pass_and_truncates() -> Result<()> {
        let earlier = [line(1, "Recieve the reward", &[])];
        let fresh = [
            line(10, "Nothing near at all", &[]),
            line(11, "Receive the reward", &[]),
        ];
        let policy = Policy {
            comparison_budget: 0,
            ..Policy::default()
        };
        let matched = match_lines(&earlier, &fresh, &policy, &AtomicBool::new(false))?;
        assert!(matched.truncated);
        assert_eq!(pairs(&matched), []);
        // The same-package pass still runs past the budget.
        let earlier = [line(1, "Recieve the reward", &[3])];
        let fresh = [
            line(10, "Nothing near at all", &[]),
            line(11, "Receive the reward", &[3]),
        ];
        let matched = match_lines(&earlier, &fresh, &policy, &AtomicBool::new(false))?;
        assert_eq!(pairs(&matched), [(11, 1, 2, true)]);
        Ok(())
    }

    #[test]
    fn policy_parameters_change_the_pairs() -> Result<()> {
        let earlier = [line(1, "Short", &[])];
        let fresh = [line(10, "Shirt", &[])];
        let cancelled = AtomicBool::new(false);
        // Five units allow one edit by default.
        assert_eq!(
            pairs(&match_lines(
                &earlier,
                &fresh,
                &Policy::default(),
                &cancelled
            )?)
            .len(),
            1
        );
        let fresh = [line(10, "Shrt!", &[])];
        assert_eq!(
            pairs(&match_lines(
                &earlier,
                &fresh,
                &Policy::default(),
                &cancelled
            )?),
            []
        );
        let loose = Policy {
            distance_ratio: 0.5,
            ..Policy::default()
        };
        assert_eq!(
            pairs(&match_lines(&earlier, &fresh, &loose, &cancelled)?),
            [(10, 1, 2, false)]
        );
        let capped = Policy {
            distance_ratio: 0.5,
            max_distance: 1,
            ..Policy::default()
        };
        assert_eq!(
            pairs(&match_lines(&earlier, &fresh, &capped, &cancelled)?),
            []
        );
        Ok(())
    }

    #[test]
    fn related_answers_a_lines_similar_keys_from_the_reader() -> Result<()> {
        use crate::join_fact_tests::Fixture;
        use serde_json::{Value, json};
        let mut fixture = Fixture::new()?;
        let entry = |key: &str, source: &str, path: &str| json!({"namespace":"UI","key":key,"source":source,"path":path});
        fixture.file(
            "Game.manifest",
            "manifest",
            &[
                entry("Old1", "Recieve the reward", "/Game/Text/A.A.Label"),
                entry("Old2", "{Count}", "/Game/Text/A.A.Count"),
                entry("Old3", "Exact text here", "/Game/Text/B.B.Label"),
                entry("Old4", "Open the door", "/Game/Text/C.C.Label"),
            ],
        )?;
        for culture in ["en", "de"] {
            let translation = if culture == "de" {
                "Belohnung erhalten"
            } else {
                "Recieve the reward"
            };
            fixture.file(
                &format!("{culture}.archive"),
                "archive",
                &[
                    json!({"namespace":"UI","key":"Old1","source":"Recieve the reward","translation":translation}),
                ],
            )?;
            fixture.file(&format!("{culture}.po"), "po", &[])?;
        }
        let place = |key: &str, source: &str, object: &str| json!({"namespace":"UI","key":key,"source":source,"object":object,"property":"Title"});
        fixture.shard(
            "package-text.0",
            &[
                (
                    "Content/Text/A.uasset",
                    "a",
                    vec![
                        place("New1", "Receive the reward", "/Game/Text/A.A"),
                        place("New2", "{Count}!", "/Game/Text/A.A"),
                    ],
                ),
                (
                    "Content/Text/B.uasset",
                    "b",
                    vec![place("New3", "Exact text here", "/Game/Text/B.B")],
                ),
                ("Content/Text/C.uasset", "c", vec![]),
                (
                    "Content/Text/D.uasset",
                    "d",
                    vec![
                        place("New4a", "Open the doors", "/Game/Text/D.D"),
                        place("New4b", "Open the doom", "/Game/Text/D.D"),
                    ],
                ),
            ],
        )?;
        let key = fixture.join()?.key;
        let query = EngineQuery::open(&fixture.configuration, Some(&key))?;
        let cancelled = AtomicBool::new(false);
        let id = |key: &str| format!("Game:[\"UI\",\"{key}\"]");
        let similar = |key: &str, section: Value| -> Result<Value> {
            let mut answer = query.line_answer(
                json!({"selection":{"kind":"line","id":id(key)},"target":"Game",
                    "related":{"limit":1,"similarKeys":section}}),
                &cancelled,
            )?;
            Ok(answer["related"]["similarKeys"].take())
        };
        let line = |key: &str, source: &str, state: &str| json!({"id":id(key),"namespace":"UI","key":key,"source":source,"state":state});
        // A typo fix pairs within its package, and carries the earlier key's translations.
        let typo = similar("New1", json!({"limit":10}))?;
        let old1 = line("Old1", "Recieve the reward", "not_found");
        assert!(typo["buildMs"].as_f64().is_some_and(|ms| ms > 0.0));
        assert_eq!(
            typo,
            json!({"state":"not_gathered","pair":{"line":old1,"distance":2,"scope":"same_package",
                "translations":[{"culture":"de","translation":"Belohnung erhalten"}]},
                "candidates":[{"line":old1,"distance":2,"scope":"same_package"}],
                "candidatesComplete":true,"pairs":1,"truncated":false,"buildMs":typo["buildMs"]})
        );
        let earlier = similar("Old1", json!({"limit":10}))?;
        assert_eq!(earlier["buildMs"], 0.0, "the reader reuses its index");
        assert_eq!(earlier["state"], "not_found");
        assert_eq!(
            earlier["pair"]["line"],
            line("New1", "Receive the reward", "not_gathered")
        );
        assert_eq!(
            earlier["pair"]["translations"],
            typo["pair"]["translations"]
        );
        // Two equally near new keys: no pair, and both are candidates, in line ID order.
        let tied = similar("Old4", json!({"limit":10}))?;
        assert!(tied.get("pair").is_none());
        assert_eq!(
            tied["candidates"],
            json!([
                {"line":line("New4a","Open the doors","not_gathered"),"distance":1,"scope":"cross_package"},
                {"line":line("New4b","Open the doom","not_gathered"),"distance":1,"scope":"cross_package"}
            ])
        );
        let limited = similar("Old4", json!({"limit":1}))?;
        assert_eq!(limited["candidates"].as_array().map(Vec::len), Some(1));
        assert_eq!(limited["candidatesComplete"], false);
        // Trivial text and lines the exact tiers paired are not compared.
        for key in ["New2", "Old2", "New3", "Old3"] {
            let answer = similar(key, json!({"limit":10}))?;
            assert!(answer.get("state").is_none(), "{key}");
            assert_eq!(answer["candidates"], json!([]), "{key}");
        }
        assert_eq!(
            query.line_answer(
                json!({"selection":{"kind":"line","id":id("New3")},"target":"Game","related":{"limit":1}}),
                &cancelled,
            )?["related"]["keyChange"]["members"][0]["line"]["identity"]["key"],
            "Old3"
        );
        // Another policy builds the index again: with no letter minimum, the arguments pair.
        let every = similar("New2", json!({"limit":10,"minLetters":0}))?;
        assert!(every["buildMs"].as_f64().is_some_and(|ms| ms > 0.0));
        assert_eq!(every["pairs"], 2);
        assert_eq!(every["pair"]["line"]["key"], "Old2");
        assert_eq!(similar("New1", json!({"limit":10}))?["pairs"], 1);
        // A unit outside lines, or a request without a target, has no similar keys.
        assert!(
            query
                .line_answer(
                    json!({"selection":{"kind":"line","id":id("New1")},
                        "related":{"limit":1,"similarKeys":{"limit":1}}}),
                    &cancelled,
                )
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn requests_validate_their_policy() {
        let section = |value: serde_json::Value| -> Result<SimilarKeysSection> {
            let section: SimilarKeysSection = serde_json::from_value(value)?;
            section.validate()?;
            Ok(section)
        };
        for valid in [
            serde_json::json!({"limit":0}),
            serde_json::json!({"limit":500,"distanceRatio":1,"reachRatio":0.01,"maxDistance":64,"comparisonBudget":0,"minLetters":0}),
        ] {
            assert!(section(valid.clone()).is_ok(), "{valid}");
        }
        for invalid in [
            serde_json::json!({"limit":501}),
            serde_json::json!({"limit":1,"distanceRatio":0}),
            serde_json::json!({"limit":1,"reachRatio":1.5}),
            serde_json::json!({"limit":1,"maxDistance":0}),
            serde_json::json!({"limit":1,"maxDistance":65}),
            serde_json::json!({"limit":1,"minLetters":65}),
            serde_json::json!({"limit":1,"comparisonBudget":-1}),
            serde_json::json!({"limit":1,"other":1}),
        ] {
            assert!(section(invalid.clone()).is_err(), "{invalid}");
        }
    }
}

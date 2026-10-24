//! Private numeric query indexes share the gathered slice rules with join findings.
use crate::join::{Joined, ordinal};
use crate::join_columns::*;
use crate::join_policy::*;
use crate::{Result, require};
use std::collections::{BTreeSet, HashSet};
const FIELDS: [&str; 19] = [
    "representative",
    "identity",
    "namespace",
    "raw",
    "line",
    "member_start",
    "member_end",
    "source_start",
    "source_end",
    "file_start",
    "file_end",
    "signals",
    "origins",
    "editing",
    "notes",
    "characters",
    "words",
    "visible",
    "audience",
];
type Column = (String, String, Vec<u32>);
pub(crate) fn packed(values: &[String]) -> Result<(Vec<u32>, Vec<u32>)> {
    let mut bytes = Vec::new();
    let mut starts = Vec::new();
    for value in values {
        starts.push(bytes.len() as u32);
        bytes.extend_from_slice(crate::wtf8::Wtf8Buf::from_view(value).as_bytes());
        require(
            bytes.len() <= u32::MAX as usize,
            "query IDs exceed u32 range",
        )?;
    }
    starts.push(bytes.len() as u32);
    bytes.resize(bytes.len().div_ceil(4) * 4, 0);
    Ok((crate::snapshot::integers(&bytes)?, starts))
}
struct Entries {
    c: Vec<Vec<u32>>,
    members: Vec<u32>,
    sources: Vec<u32>,
    files: Vec<u32>,
}
impl Entries {
    fn new(count: usize) -> Self {
        Self {
            c: vec![vec![0; count]; 19],
            members: Vec::new(),
            sources: Vec::new(),
            files: Vec::new(),
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        j: &Joined,
        row: usize,
        first: usize,
        gathered: u32,
        raw_index: &[u32],
        occurrence_line: &[u32],
        group_flags: &[u32],
        duplicate: &[bool],
    ) {
        let c = &j.packages.occurrence;
        self.c[0][row] = first as u32;
        self.c[1][row] = c[O_IDENTITY][first];
        self.c[2][row] = c[O_NS][first];
        self.c[3][row] = raw_index[first];
        self.c[4][row] = gathered;
        self.c[5][row] = self.members.len() as u32;
        self.c[7][row] = self.sources.len() as u32;
        self.c[9][row] = self.files.len() as u32;
        let mut values = HashSet::new();
        let mut paths = Vec::new();
        let mut paths_seen = HashSet::new();
        let mut flags = 0;
        let mut origins = 0;
        let mut audience = 0;
        let mut editing = 0;
        // A slice also has its line's manifest notes; a raw unit has no line to take them from.
        let mut notes = u32::from(gathered != ABSENT && j.manifest_notes(gathered as usize));
        let mut member = first as u32;
        while member != ABSENT {
            let i = member as usize;
            member = j.next[i];
            if gathered != ABSENT
                && c[O_IDENTITY][i] == 0
                && c[O_KEY][i] != j.empty
                && occurrence_line[i] != gathered
            {
                continue;
            }
            self.members.push(i as u32);
            values.insert(c[O_SOURCE][i]);
            let file = j.package_files[j.packages.package_row[i] as usize];
            if paths_seen.insert(file) {
                paths.push(file);
            }
            flags |= group_flags[if gathered == ABSENT {
                occurrence_line[i]
            } else {
                gathered
            } as usize];
            if duplicate[i] {
                flags |= 2;
            }
            origins |= 1
                << match c[O_LOCATION][i] {
                    2 => 0,
                    1 => 1,
                    _ => 2,
                };
            editing |= if c[O_EDITABLE][i] != 0 { 1 } else { 2 };
            audience |= crate::package_evidence::audience(c[O_AUDIENCE][i]);
            if c[O_COPIES][i] & 2 != 0 {
                flags |= 64;
            }
            if !trim(j.string(c[O_NOTES][i])).is_empty() {
                notes = 1;
            }
        }
        let mut values = values.into_iter().collect::<Vec<_>>();
        values.sort_by(|a, b| ordinal(j.string(*a), j.string(*b)));
        let mut longest = "";
        let mut visible = false;
        for id in &values {
            let value = j.string(*id);
            let length = characters(value);
            if length > characters(longest)
                || (length == characters(longest) && ordinal(value, longest).is_lt())
            {
                longest = value;
            }
            visible |= !trim(value).is_empty();
        }
        let characters_count = characters(longest);
        let word_count = words(longest);
        self.sources.extend(values);
        self.files.extend(paths);
        if characters_count >= 40 {
            flags |= 4;
        }
        if c[O_IDENTITY][first] >= 2 || c[O_KEY][first] == j.empty {
            flags |= 8;
        }
        if editing == 2 {
            flags |= 32;
        }
        self.c[6][row] = self.members.len() as u32;
        self.c[8][row] = self.sources.len() as u32;
        self.c[10][row] = self.files.len() as u32;
        self.c[11][row] = flags;
        self.c[12][row] = origins;
        self.c[13][row] = editing;
        self.c[14][row] = notes;
        self.c[15][row] = characters_count;
        self.c[16][row] = word_count;
        self.c[17][row] = u32::from(visible);
        self.c[18][row] = audience;
    }
    fn append(self, prefix: &str, result: &mut Vec<Column>) {
        for (name, values) in FIELDS.iter().zip(self.c) {
            result.push((
                format!("query.{prefix}.{name}"),
                if *name == "namespace" {
                    "identity".into()
                } else {
                    String::new()
                },
                values,
            ));
        }
        result.push((
            format!("query.{prefix}.members"),
            String::new(),
            self.members,
        ));
        result.push((
            format!("query.{prefix}.sources"),
            "source".into(),
            self.sources,
        ));
        result.push((format!("query.{prefix}.files"), "paths".into(), self.files));
    }
}
pub(crate) fn columns(j: &Joined, target: &str) -> Result<Vec<Column>> {
    let count = j.groups.len();
    let mut occurrence_line = vec![0; j.order.len()];
    let mut group_flags = vec![0; count];
    let places = crate::package_evidence::places(j);
    let duplicate = crate::package_evidence::duplicates(j, &places);
    let c = &j.packages.occurrence;
    for (row, g) in j.groups.iter().enumerate() {
        let mut sources = HashSet::new();
        for i in &j.order[g.os..g.oe] {
            let i = *i as usize;
            occurrence_line[i] = row as u32;
            if c[O_IDENTITY][i] == 1 {
                continue;
            }
            let source = c[O_SOURCE][i];
            sources.insert(source);
        }
        group_flags[row] = u32::from(g.oe - g.os > 1) | if sources.len() > 1 { 16 } else { 0 };
    }
    let raw_representatives = j
        .raw_order
        .iter()
        .copied()
        .filter(|row| j.unit[*row as usize] == *row)
        .collect::<Vec<_>>();
    let mut raw_index = vec![0; j.order.len()];
    for (index, row) in raw_representatives.iter().enumerate() {
        raw_index[*row as usize] = index as u32;
    }
    let names = raw_representatives
        .iter()
        .map(|r| j.unit_ids[*r as usize].clone())
        .collect::<Vec<_>>();
    let mut line_starts = vec![0];
    let mut representatives = Vec::new();
    for g in &j.groups {
        let mut rows = j.order[g.os..g.oe]
            .iter()
            .map(|i| j.unit[*i as usize])
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| {
            ordinal(
                &names[raw_index[*a as usize] as usize],
                &names[raw_index[*b as usize] as usize],
            )
        });
        representatives.extend(rows);
        line_starts.push(representatives.len() as u32);
    }
    let mut raw = Entries::new(raw_representatives.len());
    for (row, first) in raw_representatives.iter().enumerate() {
        raw.add(
            j,
            row,
            *first as usize,
            ABSENT,
            &raw_index,
            &occurrence_line,
            &group_flags,
            &duplicate,
        );
    }
    let mut slice = Entries::new(representatives.len());
    for row in 0..count {
        for index in line_starts[row]..line_starts[row + 1] {
            slice.add(
                j,
                index as usize,
                representatives[index as usize] as usize,
                row as u32,
                &raw_index,
                &occurrence_line,
                &group_flags,
                &duplicate,
            );
        }
    }
    let mut result = vec![
        ("query.occurrence.places".into(), String::new(), places),
        (
            "query.occurrence.sources".into(),
            "source".into(),
            c[O_SOURCE].clone(),
        ),
    ];
    raw.append("raw", &mut result);
    slice.append("slice", &mut result);
    let mut raw_order = (0..names.len() as u32).collect::<Vec<_>>();
    crate::join::sort_by_locale(&mut raw_order, &names);
    result.push(("query.raw.order".into(), String::new(), raw_order));
    let (bytes, starts) = packed(&names)?;
    result.push(("query.raw.id_utf8".into(), String::new(), bytes));
    result.push(("query.raw.id_starts".into(), String::new(), starts));
    result.push((
        "query.line.starts".into(),
        String::new(),
        line_starts.clone(),
    ));
    let mut line_names = Vec::new();
    for row in 0..count {
        let identity =
            if line_starts[row] != line_starts[row + 1] && j.string(j.line[1][row]).is_empty() {
                format!(
                    "unresolved:{}",
                    names[raw_index[representatives[line_starts[row] as usize] as usize] as usize]
                )
            } else {
                crate::wtf8::Wtf8Buf::from_utf8(&crate::wtf8::view_json(&serde_json::json!([
                    j.string(j.line[0][row]),
                    j.string(j.line[1][row])
                ]))?)
                .to_view()
            };
        line_names.push(format!(
            "{}:{identity}",
            crate::wtf8::Wtf8Buf::from_utf8(target).to_view()
        ));
    }
    let (bytes, starts) = packed(&line_names)?;
    result.push(("query.line.id_utf8".into(), String::new(), bytes));
    result.push(("query.line.id_starts".into(), String::new(), starts));
    let mut line_order = (0..count as u32).collect::<Vec<_>>();
    crate::join::sort_by_locale(&mut line_order, &line_names);
    result.push(("query.line.order".into(), String::new(), line_order));
    let paths = j
        .packages
        .paths
        .iter()
        .map(|id| crate::wtf8::Wtf8Buf::from_view(j.string(*id)))
        .collect::<Vec<_>>();
    let mut package_order = (0..paths.len() as u32).collect::<Vec<_>>();
    package_order.sort_by(|a, b| {
        crate::join::package_path_order(
            paths[*a as usize].as_bytes(),
            paths[*b as usize].as_bytes(),
        )
    });
    result.push(("query.package.order".into(), String::new(), package_order));
    // Query opens consume persisted folded bytes rather than rebuilding a source arena in JS.
    // Keep IDs as real shared string columns so coordinated compaction remaps them atomically.
    let source_ids = j.line[crate::join::L_SOURCE]
        .iter()
        .chain(c[O_SOURCE].iter())
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let folded = source_ids
        .iter()
        .map(|id| j.string(*id).to_lowercase())
        .collect::<Vec<_>>();
    let (bytes, starts) = packed(&folded)?;
    result.push(("query.source.ids".into(), "source".into(), source_ids));
    result.push(("query.source.starts".into(), String::new(), starts));
    result.push(("query.source.folded".into(), String::new(), bytes));
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_paths_follow_component_order() {
        let mut paths = [
            "Content/A.uasset",
            "Content/A/Z.uasset",
            "Content/A-Extra.uasset",
            "Content/B.uasset",
        ];
        paths.sort_by(|a, b| crate::join::package_path_order(a.as_bytes(), b.as_bytes()));
        assert_eq!(
            paths,
            [
                "Content/A/Z.uasset",
                "Content/A-Extra.uasset",
                "Content/A.uasset",
                "Content/B.uasset"
            ]
        );
        assert!(crate::join::package_path_order(b"Content\\A", b"Content/A").is_eq());
    }
}

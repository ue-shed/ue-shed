//! Source-only edits preserve membership and rebuild bounded source lists and affected signals.
use super::*;
use crate::join_policy::{characters, trim};

pub(super) type SourceEdits = BTreeMap<String, BTreeMap<u32, Vec<u32>>>;
pub(super) struct Sources<'a> {
    pub store: &'a mut Store,
    pub files: &'a mut Files,
    pub joined: &'a mut Joined,
    pub names: &'a [String],
    pub starts: &'a [u32],
    pub text: &'a mut BTreeMap<u32, String>,
    pub occurrence_lines: Option<Vec<u32>>,
    pub raw_ids: Option<Vec<u8>>,
}

impl Sources<'_> {
    fn package(&mut self, member: usize, field: &str) -> Result<u32> {
        package_value(
            self.store,
            self.files,
            self.names,
            self.starts,
            member,
            field,
        )
    }

    fn load(&mut self, ids: impl IntoIterator<Item = u32>) -> Result<()> {
        let wanted: BTreeSet<_> = ids
            .into_iter()
            .filter(|id| !self.text.contains_key(id))
            .collect();
        if wanted.is_empty() {
            return Ok(());
        }
        self.text.extend(dictionary_selected_strings(
            &self.store.directory,
            &self.store.root,
            &wanted,
        )?);
        Ok(())
    }

    /// Authored text supplies the gathered source; references retain their own query sources.
    pub fn line(&mut self, row: usize, members: &[u32]) -> Result<Option<(u32, usize)>> {
        let mut sources = BTreeSet::new();
        for member in members {
            if self.package(*member as usize, "identity")? != 1 {
                sources.insert(self.package(*member as usize, "source")?);
            }
        }
        if sources.is_empty() || sources.len() > 8192 {
            return Ok(None);
        }
        self.load(sources.iter().copied())?;
        let source = if sources.len() == 1 {
            *sources.first().ok_or("missing authored source")?
        } else {
            let begin = self.joined.get("query.line.starts", row)?;
            let end = self.joined.get("query.line.starts", row + 1)?;
            let id_starts = self.joined.col("query.raw.id_starts")?;
            if self.raw_ids.is_none() {
                self.raw_ids = Some(
                    self.joined
                        .col("query.raw.id_utf8")?
                        .iter()
                        .flat_map(|value| value.to_le_bytes())
                        .collect(),
                );
            }
            let bytes = self.raw_ids.as_ref().ok_or("raw identity arena")?;
            let mut slices = Vec::new();
            for slice in begin..end {
                let raw = self.joined.get("query.slice.raw", slice as usize)? as usize;
                let start = *id_starts.get(raw).ok_or("raw identity start")? as usize;
                let end = *id_starts.get(raw + 1).ok_or("raw identity end")? as usize;
                let id = crate::wtf8::Wtf8Buf::from_bytes(
                    bytes.get(start..end).ok_or("raw identity range")?.to_vec(),
                )?
                .into_view();
                slices.push((slice, id));
            }
            slices.sort_by(|a, b| crate::join::locale(&a.1, &b.1));
            let members = self.joined.col("query.slice.members")?;
            let mut ordered = Vec::new();
            let mut seen = HashSet::new();
            for (slice, _) in slices {
                let begin = self
                    .joined
                    .get("query.slice.member_start", slice as usize)?
                    as usize;
                let end = self.joined.get("query.slice.member_end", slice as usize)? as usize;
                for member in members.get(begin..end).ok_or("slice member range")? {
                    if self.package(*member as usize, "identity")? != 1 {
                        let source = self.package(*member as usize, "source")?;
                        if seen.insert(source) {
                            ordered.push(source);
                        }
                    }
                }
            }
            let value = ordered
                .iter()
                .map(|id| self.text[id].as_str())
                .collect::<Vec<_>>()
                .join(" ");
            require(
                crate::wtf8::Wtf8Buf::from_view(&value).as_bytes().len() <= 1024 * 1024,
                "Joined source exceeds bound",
            )?;
            let encoded = crate::wtf8::Wtf8Buf::from_view(&value).into_bytes();
            let id = self.store.intern_bytes("source", &[encoded])?[0];
            self.text.insert(id, value);
            id
        };
        if u32::from(!trim(&self.text[&source]).is_empty())
            != self.joined.get("line.source_visible", row)?
        {
            return Ok(None);
        }
        Ok(Some((source, sources.len())))
    }

    pub fn queries(
        &mut self,
        lines: &BTreeSet<usize>,
        edits: &BTreeMap<usize, u32>,
        previous: &BTreeMap<usize, u32>,
        hot: &mut Hot,
    ) -> Result<Option<SourceEdits>> {
        let mut updated = SourceEdits::new();
        let mut visited = HashSet::new();
        for line in lines {
            let begin = self.joined.get("query.line.starts", *line)?;
            let end = self.joined.get("query.line.starts", line + 1)?;
            for slice in begin..end {
                let raw = self.joined.get("query.slice.raw", slice as usize)?;
                for (kind, row) in [("slice", slice), ("raw", raw)] {
                    if !visited.insert((kind, row)) {
                        continue;
                    }
                    let prefix = format!("query.{kind}.");
                    let members = self.joined.col(&(prefix.clone() + "members"))?;
                    let begin = self
                        .joined
                        .get(&(prefix.clone() + "member_start"), row as usize)?
                        as usize;
                    let end = self
                        .joined
                        .get(&(prefix.clone() + "member_end"), row as usize)?
                        as usize;
                    let mut values = BTreeSet::new();
                    for member in members.get(begin..end).ok_or("query member range")? {
                        values.insert(self.package(*member as usize, "source")?);
                    }
                    if values.is_empty() || values.len() > 8192 {
                        return Ok(None);
                    }
                    self.load(values.iter().copied())?;
                    let mut values = values.into_iter().collect::<Vec<_>>();
                    values.sort_by(|a, b| crate::join::ordinal(&self.text[a], &self.text[b]));
                    let mut longest = "";
                    let mut visible = false;
                    for id in &values {
                        let value = &self.text[id];
                        if characters(value) > characters(longest)
                            || (characters(value) == characters(longest)
                                && crate::join::ordinal(value, longest).is_lt())
                        {
                            longest = value;
                        }
                        visible |= !trim(value).is_empty();
                    }
                    if u32::from(visible)
                        != self
                            .joined
                            .get(&(prefix.clone() + "visible"), row as usize)?
                    {
                        return Ok(None);
                    }
                    set(
                        hot,
                        &(prefix.clone() + "characters"),
                        row as usize,
                        characters(longest),
                    );
                    set(
                        hot,
                        &(prefix.clone() + "words"),
                        row as usize,
                        words(longest),
                    );
                    let longest_characters = characters(longest);
                    let flags = self
                        .joined
                        .get(&(prefix.clone() + "signals"), row as usize)?;
                    // A raw unit can span gathered lines: its conflict bit folds every member's line.
                    let conflict = if kind == "slice" {
                        hot.get("line.reasons")
                            .and_then(|rows| rows.get(&(*line as u32)))
                            .copied()
                            .unwrap_or(self.joined.get("line.reasons", *line)?)
                            & (1 << 11)
                            != 0
                    } else {
                        self.raw_conflict(
                            members.get(begin..end).ok_or("query member range")?,
                            hot,
                        )?
                    };
                    set(
                        hot,
                        &(prefix.clone() + "signals"),
                        row as usize,
                        (flags & !(4 | 16))
                            | if longest_characters >= 40 { 4 } else { 0 }
                            | if conflict { 16 } else { 0 },
                    );
                    updated.entry(kind.into()).or_default().insert(row, values);
                }
            }
        }
        if !edits.is_empty() {
            self.duplicates(edits, previous, hot)?;
        }
        if hot.values().any(|rows| rows.len() > 8192) {
            return Ok(None);
        }
        Ok(Some(updated))
    }

    fn raw_conflict(&mut self, members: &[u32], hot: &Hot) -> Result<bool> {
        if self.occurrence_lines.is_none() {
            let order = self.joined.col("occurrence.rows")?;
            let ends = self.joined.col("line.occ_end")?;
            let mut lines = vec![0; order.len()];
            let mut line = 0;
            for (position, member) in order.iter().enumerate() {
                while ends.get(line).is_some_and(|end| *end <= position as u32) {
                    line += 1;
                }
                require(line < ends.len(), "occurrence line range")?;
                *lines.get_mut(*member as usize).ok_or("occurrence row")? = line as u32;
            }
            self.occurrence_lines = Some(lines);
        }
        let lines = self.occurrence_lines.as_ref().ok_or("occurrence lines")?;
        for member in members {
            let line = *lines.get(*member as usize).ok_or("raw occurrence row")?;
            let reasons = hot
                .get("line.reasons")
                .and_then(|rows| rows.get(&line))
                .copied()
                .unwrap_or(self.joined.get("line.reasons", line as usize)?);
            if reasons & (1 << 11) != 0 {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn duplicates(
        &mut self,
        edits: &BTreeMap<usize, u32>,
        previous: &BTreeMap<usize, u32>,
        hot: &mut Hot,
    ) -> Result<()> {
        let mut sources = self.joined.col("query.occurrence.sources")?.to_vec();
        let places = self.joined.col("query.occurrence.places")?;
        require(sources.len() == places.len(), "occurrence place length")?;
        for (row, source) in edits {
            *sources.get_mut(*row).ok_or("source row")? = *source;
            set(hot, "query.occurrence.sources", *row, *source);
        }
        let dirty = edits
            .values()
            .chain(previous.values())
            .copied()
            .collect::<HashSet<_>>();
        let mut queries = Vec::new();
        let mut needed = HashSet::new();
        for kind in ["raw", "slice"] {
            let prefix = format!("query.{kind}.");
            let identity = self.joined.col(&(prefix.clone() + "identity"))?;
            let flags = self.joined.col(&(prefix.clone() + "signals"))?;
            let starts = self.joined.col(&(prefix.clone() + "member_start"))?;
            let ends = self.joined.col(&(prefix.clone() + "member_end"))?;
            let members = self.joined.col(&(prefix.clone() + "members"))?;
            let mut rows = Vec::new();
            for row in 0..flags.len() {
                if identity[row] != 0 || flags[row] & 8 != 0 {
                    continue;
                }
                let selected = members
                    .get(starts[row] as usize..ends[row] as usize)
                    .ok_or("duplicate member range")?;
                if selected.iter().any(|member| {
                    sources
                        .get(*member as usize)
                        .is_some_and(|source| dirty.contains(source))
                }) {
                    rows.push(row);
                    for member in selected {
                        needed.insert(
                            *sources
                                .get(*member as usize)
                                .ok_or("duplicate source row")?,
                        );
                    }
                }
            }
            queries.push((prefix, flags, starts, ends, members, rows));
        }
        let mut lines = vec![0; sources.len()];
        let mut count = HashMap::<u32, i64>::new();
        let mut identities = HashMap::<(u32, u32), i64>::new();
        let mut locations = HashMap::<(u32, u32), i64>::new();
        let mut pairs = HashMap::<(u32, u32, u32), i64>::new();
        let slice_lines = self.joined.col("query.slice.line")?;
        let slice_identity = self.joined.col("query.slice.identity")?;
        let (_, flags, starts, ends, members, _) = &queries[1];
        for row in 0..slice_lines.len() {
            if slice_identity[row] != 0 || flags[row] & 8 != 0 {
                continue;
            }
            let line = slice_lines[row];
            for member in members
                .get(starts[row] as usize..ends[row] as usize)
                .ok_or("slice duplicate range")?
            {
                let member = *member as usize;
                let source = *sources.get(member).ok_or("duplicate member")?;
                lines[member] = line;
                if !needed.contains(&source) {
                    continue;
                }
                let place = places[member];
                *count.entry(source).or_default() += 1;
                *identities.entry((source, line)).or_default() += 1;
                *locations.entry((source, place)).or_default() += 1;
                *pairs.entry((source, line, place)).or_default() += 1;
            }
        }
        for (prefix, flags, starts, ends, members, rows) in queries {
            for row in rows {
                let duplicate = members[starts[row] as usize..ends[row] as usize]
                    .iter()
                    .any(|member| {
                        let member = *member as usize;
                        let source = sources[member];
                        let line = lines[member];
                        let place = places[member];
                        count.get(&source).copied().unwrap_or(0)
                            - identities.get(&(source, line)).copied().unwrap_or(0)
                            - locations.get(&(source, place)).copied().unwrap_or(0)
                            + pairs.get(&(source, line, place)).copied().unwrap_or(0)
                            > 0
                    });
                let field = prefix.clone() + "signals";
                let flags = hot
                    .get(&field)
                    .and_then(|rows| rows.get(&(row as u32)))
                    .copied()
                    .unwrap_or(flags[row]);
                let updated = (flags & !2) | (u32::from(duplicate) * 2);
                if updated != flags {
                    set(hot, &field, row, updated);
                }
            }
        }
        Ok(())
    }
}

pub(super) fn pack(
    joined: &mut Joined,
    edits: &SourceEdits,
    physical: &mut Vec<(String, String, Vec<u32>)>,
    fields: &mut BTreeSet<String>,
) -> Result<Option<Value>> {
    let mut patches = serde_json::Map::new();
    for kind in ["raw", "slice"] {
        let prefix = format!("query.{kind}.");
        let prior = joined.meta["sourcePatches"][kind].clone();
        let mut rows = edits
            .get(kind)
            .map(|rows| rows.keys().copied().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        if let Some(name) = prior["rows"].as_str() {
            rows.extend(column(&mut joined.raw, &joined.record, name)?);
        }
        let starts = joined.col(&(prefix.clone() + "source_start"))?;
        let ends = joined.col(&(prefix.clone() + "source_end"))?;
        let values = joined.col(&(prefix.clone() + "sources"))?;
        if joined.meta["patches"][&(prefix.clone() + "sources")].is_string() {
            let name = joined.meta["patchRows"][&(prefix.clone() + "sources")]
                .as_str()
                .unwrap_or("patch.rows");
            for index in column(&mut joined.raw, &joined.record, name)? {
                let row = ends.partition_point(|end| *end <= index);
                require(row < ends.len(), "prior source patch range")?;
                rows.insert(row as u32);
            }
        }
        if rows.is_empty() {
            continue;
        }
        if rows.len() > 8192 {
            return Ok(None);
        }
        let rows = rows.into_iter().collect::<Vec<_>>();
        let mut offsets = vec![0];
        let mut packed = Vec::new();
        for row in &rows {
            let row_index = *row as usize;
            let selected = edits
                .get(kind)
                .and_then(|edits| edits.get(row))
                .map(Vec::as_slice)
                .unwrap_or(
                    values
                        .get(
                            *starts.get(row_index).ok_or("source row start")? as usize
                                ..*ends.get(row_index).ok_or("source row end")? as usize,
                        )
                        .ok_or("source row values")?,
                );
            packed.extend_from_slice(selected);
            if packed.len() > 8192 {
                return Ok(None);
            }
            offsets.push(packed.len() as u32);
        }
        let name = format!("source-patch.{kind}");
        patches.insert(kind.into(), json!({"rows":format!("{name}.rows"), "starts":format!("{name}.starts"), "values":format!("{name}.values")}));
        physical.push((format!("{name}.rows"), String::new(), rows));
        physical.push((format!("{name}.starts"), String::new(), offsets));
        physical.push((format!("{name}.values"), "source".into(), packed));
        for field in ["source_start", "source_end", "sources"] {
            fields.remove(&(prefix.clone() + field));
        }
    }
    Ok(Some(Value::Object(patches)))
}

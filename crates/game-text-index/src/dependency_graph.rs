//! Typed native dependency indexes over immutable, checked snapshot pages.
//! Text values and reference edges never participate in a site's logical identity.
use crate::join::Joined;
use crate::join_columns::*;
use crate::snapshot::{Reader, Writer};
use crate::store::{Store, atomic_json, bounded, decode_ids, digest, encode_ids, section, token};
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

const VERSION: u32 = 4;
const PAGE: usize = 16_384;
const PAGE_CACHE: usize = 8 * 1024 * 1024;
const MAX_MOVES: usize = 8192;
const ABSENT: u32 = u32::MAX;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    generation: String,
    revision: String,
    base: String,
    moves: BTreeMap<u32, u32>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    state: State,
    checksum: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u32,
    generation: String,
    count: u32,
    columns: BTreeMap<String, u32>,
}
struct Field {
    count: usize,
    pages: Vec<usize>,
}
struct Pages {
    reader: Reader,
    fields: BTreeMap<String, Field>,
    cache: HashMap<usize, Arc<[u32]>>,
    order: VecDeque<usize>,
    bytes: usize,
    loads: usize,
}
impl Pages {
    fn open(path: &std::path::Path, generation: &str) -> Result<(Self, u32)> {
        let reader = Reader::open(path)?;
        require(
            reader
                .entries
                .iter()
                .find(|e| e.name == "graph.meta")
                .is_some_and(|e| e.raw <= 1024 * 1024),
            "Dependency metadata exceeds its bound",
        )?;
        let meta: Metadata = serde_json::from_slice(&section(&reader, "graph.meta")?)?;
        require(
            meta.version == VERSION && meta.generation == generation,
            "Dependency base generation",
        )?;
        require(meta.columns.len() <= 64, "Dependency column count")?;
        let entries = reader
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.name.as_str(), i))
            .collect::<HashMap<_, _>>();
        let mut fields = BTreeMap::new();
        for (name, count) in meta.columns {
            let count = count as usize;
            let mut pages = Vec::new();
            for page in 0..count.div_ceil(PAGE) {
                let index = *entries
                    .get(format!("{name}.p{page}").as_str())
                    .ok_or("Missing dependency page")?;
                let entry = &reader.entries[index];
                require(
                    entry.kind == 2 && entry.count as usize == PAGE.min(count - page * PAGE),
                    "Dependency page length",
                )?;
                pages.push(index);
            }
            fields.insert(name, Field { count, pages });
        }
        Ok((
            Self {
                reader,
                fields,
                cache: HashMap::new(),
                order: VecDeque::new(),
                bytes: 0,
                loads: 0,
            },
            meta.count,
        ))
    }
    fn count(&self, name: &str) -> Result<usize> {
        Ok(self
            .fields
            .get(name)
            .ok_or("Missing dependency column")?
            .count)
    }
    fn page(&mut self, index: usize) -> Result<Arc<[u32]>> {
        if let Some(values) = self.cache.get(&index) {
            return Ok(Arc::clone(values));
        }
        let values: Arc<[u32]> = decode_ids(&self.reader.load(index)?, true)?.into();
        while self.bytes + values.len() * 4 > PAGE_CACHE {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if let Some(old) = self.cache.remove(&old) {
                self.bytes -= old.len() * 4;
            }
        }
        self.loads += 1;
        self.bytes += values.len() * 4;
        self.cache.insert(index, Arc::clone(&values));
        self.order.push_back(index);
        Ok(values)
    }
    fn get(&mut self, name: &str, row: usize) -> Result<u32> {
        let field = self.fields.get(name).ok_or("Missing dependency column")?;
        require(row < field.count, "Dependency row outside column")?;
        let index = field.pages[row / PAGE];
        self.page(index)?
            .get(row % PAGE)
            .copied()
            .ok_or_else(|| "Dependency page row".into())
    }
    fn range(&mut self, name: &str, begin: usize, end: usize) -> Result<Vec<u32>> {
        require(begin <= end && end <= self.count(name)?, "Dependency range")?;
        let mut values = Vec::with_capacity(end - begin);
        let mut row = begin;
        while row < end {
            let index = self.fields[name].pages[row / PAGE];
            let page = self.page(index)?;
            let start = row % PAGE;
            let take = (end - row).min(page.len() - start);
            values.extend_from_slice(&page[start..start + take]);
            row += take;
        }
        Ok(values)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub line: u32,
    pub source: u32,
}
#[derive(Default)]
struct Moves {
    members: BTreeMap<u32, u32>,
}
pub(crate) struct Graph {
    pages: RefCell<Pages>,
    moves: RefCell<Moves>,
    generation: String,
    base: String,
    count: u32,
    rebuilt: bool,
}
type Columns = BTreeMap<String, Vec<u32>>;

fn prefix(store: &Store) -> String {
    format!(
        "dependencies-{}",
        digest(store.configuration_view_prefix().unwrap_or("").as_bytes())
    )
}
fn state_path(store: &Store) -> PathBuf {
    store.directory.join(format!("{}.json", prefix(store)))
}
fn valid_base(store: &Store, name: &str) -> bool {
    name.strip_prefix(&(prefix(store) + "-base-"))
        .and_then(|s| s.strip_suffix(".snapshot"))
        .is_some_and(|s| {
            !s.is_empty() && s.len() <= 96 && s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        })
}
fn load_state(store: &Store) -> Result<Option<State>> {
    let path = state_path(store);
    if !path.try_exists()? {
        return Ok(None);
    }
    let envelope: Envelope = serde_json::from_slice(&bounded(&path, 1024 * 1024)?)?;
    require(
        digest(&serde_json::to_vec(&envelope.state)?) == envelope.checksum,
        "Dependency state checksum",
    )?;
    require(
        valid_base(store, &envelope.state.base),
        "Dependency base filename",
    )?;
    require(
        envelope.state.moves.len() <= MAX_MOVES,
        "Dependency move count",
    )?;
    Ok(Some(envelope.state))
}
fn adjacency(columns: &mut Columns, name: &str, rows: impl IntoIterator<Item = Vec<u32>>) {
    let mut starts = vec![0];
    let mut members = Vec::new();
    for row in rows {
        members.extend(row);
        starts.push(members.len() as u32);
    }
    columns.insert(format!("{name}.start"), starts);
    columns.insert(format!("{name}.members"), members);
}

impl Graph {
    pub(crate) fn open(store: &Store, revision: &str) -> Result<Option<Self>> {
        let Some(state) = load_state(store)? else {
            return Ok(None);
        };
        let generation = store.root["generation"]
            .as_str()
            .ok_or("Dependency generation")?;
        if state.version != VERSION || state.generation != generation || state.revision != revision
        {
            return Ok(None);
        }
        let (pages, count) = Pages::open(&store.directory.join(&state.base), generation)?;
        let mut moves = Moves::default();
        for (member, source) in state.moves {
            require(member < count, "Dependency move row")?;
            moves.members.insert(member, source);
        }
        Ok(Some(Self {
            pages: RefCell::new(pages),
            moves: RefCell::new(moves),
            generation: generation.into(),
            base: state.base,
            count,
            rebuilt: false,
        }))
    }

    pub(crate) fn rebuild(
        store: &Store,
        joined: &Joined,
        query: &[(String, String, Vec<u32>)],
    ) -> Result<Self> {
        let started = std::time::Instant::now();
        let count = joined.order.len();
        let get = |name: &str| {
            query
                .iter()
                .find(|(n, _, _)| n == name)
                .map(|(_, _, v)| v)
                .ok_or_else(|| crate::Error::from(format!("Missing dependency input {name}")))
        };
        let mut columns = Columns::new();
        let mut lines = vec![ABSENT; count];
        let mut line_members = Vec::new();
        for (row, group) in joined.groups.iter().enumerate() {
            let members = joined.order[group.os..group.oe].to_vec();
            for member in &members {
                *lines
                    .get_mut(*member as usize)
                    .ok_or("Dependency line member")? = row as u32;
            }
            line_members.push(members);
        }
        columns.insert("occ.line".into(), lines);
        adjacency(&mut columns, "line", line_members);
        // Every occurrence is a member of exactly one raw unit and one slice.
        for kind in ["raw", "slice"] {
            let starts = get(&format!("query.{kind}.member_start"))?;
            let ends = get(&format!("query.{kind}.member_end"))?;
            let members = get(&format!("query.{kind}.members"))?;
            require(starts.len() == ends.len(), "Dependency membership lengths")?;
            let mut seen = vec![false; count];
            let mut groups = Vec::new();
            for (start, end) in starts.iter().zip(ends) {
                let selected = members
                    .get(*start as usize..*end as usize)
                    .ok_or("Dependency member range")?;
                for member in selected {
                    let slot = seen
                        .get_mut(*member as usize)
                        .ok_or("Dependency member row")?;
                    require(!*slot, "Duplicate dependency membership")?;
                    *slot = true;
                }
                groups.push(selected.to_vec());
            }
            require(
                seen.iter().all(|seen| *seen),
                "Incomplete dependency membership",
            )?;
            adjacency(&mut columns, kind, groups);
        }
        require(
            !columns["occ.line"].contains(&ABSENT),
            "Incomplete dependency membership",
        )?;
        let c = &joined.packages.occurrence;
        require(c[O_SOURCE].len() == count, "Dependency occurrence length")?;
        columns.insert("occ.source".into(), c[O_SOURCE].clone());
        // Logical site coordinates exclude text, namespace/key and referenced target.
        columns.insert(
            "site.package".into(),
            joined
                .packages
                .package_row
                .iter()
                .map(|p| joined.packages.paths[*p as usize])
                .collect(),
        );
        for (name, field) in [
            ("object", O_OBJECT),
            ("property", O_PROPERTY),
            ("row", O_ROW),
            ("location", O_LOCATION),
        ] {
            columns.insert(format!("site.{name}"), c[field].clone());
        }
        let mut ordinal = Vec::with_capacity(count);
        let mut previous_package = None;
        let mut sites = BTreeMap::new();
        let mut definitions = vec![ABSENT; count];
        let mut definition_keys = vec![ABSENT; count];
        let mut references = BTreeMap::<(u32, u32), Vec<u32>>::new();
        for member in 0..count {
            let package = joined.packages.package_row[member];
            if previous_package != Some(package) {
                sites.clear();
                previous_package = Some(package);
            }
            let site = (
                c[O_OBJECT][member],
                c[O_PROPERTY][member],
                c[O_ROW][member],
                c[O_LOCATION][member],
            );
            let next = sites.entry(site).or_insert(0u32);
            ordinal.push(*next);
            *next += 1;
            if c[O_IDENTITY][member] == 1 {
                references
                    .entry((c[O_NS][member], c[O_KEY][member]))
                    .or_default()
                    .push(member as u32);
            } else if let Some((table, key)) =
                joined
                    .packages
                    .table_entry(member, &joined.strings, joined.empty)
            {
                definitions[member] = table;
                definition_keys[member] = key;
            }
        }
        columns.insert("site.ordinal".into(), ordinal);
        columns.insert("occ.def_table".into(), definitions);
        columns.insert("occ.def_key".into(), definition_keys);
        columns.insert("ref.table".into(), references.keys().map(|k| k.0).collect());
        columns.insert("ref.key".into(), references.keys().map(|k| k.1).collect());
        adjacency(&mut columns, "ref", references.into_values());
        let identities = (0..joined.groups.len())
            .filter(|row| joined.resolved(*row))
            .map(|row| {
                (
                    (
                        joined.line[crate::join::L_NS][row],
                        joined.line[crate::join::L_KEY][row],
                    ),
                    row as u32,
                )
            })
            .collect::<BTreeMap<_, _>>();
        columns.insert(
            "id.namespace".into(),
            identities.keys().map(|k| k.0).collect(),
        );
        columns.insert("id.key".into(), identities.keys().map(|k| k.1).collect());
        columns.insert("id.line".into(), identities.into_values().collect());
        let graph = Self::write(store, count as u32, columns)?;
        crate::join_incremental::note(
            "dependencyGraphBuildSeconds",
            serde_json::json!(started.elapsed().as_secs_f64()),
        );
        Ok(graph)
    }

    fn write(store: &Store, count: u32, columns: Columns) -> Result<Self> {
        let generation = store.root["generation"]
            .as_str()
            .ok_or("Dependency generation")?;
        let base = format!("{}-base-{}.snapshot", prefix(store), token());
        let mut writer = Writer::new(&store.directory.join(format!("{}.tmp", token())))?;
        let mut order = Vec::new();
        let meta = Metadata {
            version: VERSION,
            generation: generation.into(),
            count,
            columns: columns
                .iter()
                .map(|(name, values)| Ok((name.clone(), u32::try_from(values.len())?)))
                .collect::<Result<_>>()?,
        };
        order.push(writer.add("graph.meta", 0, "", &serde_json::to_vec(&meta)?, 1)?);
        for (name, values) in columns {
            for (page, values) in values.chunks(PAGE).enumerate() {
                order.push(writer.add(
                    &format!("{name}.p{page}"),
                    2,
                    "",
                    &encode_ids(values),
                    1,
                )?);
            }
        }
        writer.finish(&store.directory.join(&base), &order)?;
        let (pages, count) = Pages::open(&store.directory.join(&base), generation)?;
        Ok(Self {
            pages: RefCell::new(pages),
            moves: RefCell::new(Moves::default()),
            generation: generation.into(),
            base,
            count,
            rebuilt: true,
        })
    }
    fn get(&self, name: &str, row: usize) -> Result<u32> {
        self.pages.borrow_mut().get(name, row)
    }
    fn find_pair(&self, a: &str, b: &str, key: (u32, u32)) -> Result<Option<usize>> {
        let count = self.pages.borrow().count(a)?;
        require(
            self.pages.borrow().count(b)? == count,
            "Dependency key lengths",
        )?;
        let (mut low, mut high) = (0, count);
        while low < high {
            let middle = (low + high) / 2;
            if (self.get(a, middle)?, self.get(b, middle)?) < key {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        Ok((low < count && (self.get(a, low)?, self.get(b, low)?) == key).then_some(low))
    }
    fn adjacent(&self, name: &str, row: usize) -> Result<Vec<u32>> {
        let begin = self.get(&format!("{name}.start"), row)? as usize;
        let end = self.get(&format!("{name}.start"), row + 1)? as usize;
        self.pages
            .borrow_mut()
            .range(&format!("{name}.members"), begin, end)
    }
    pub(crate) fn route(&self, member: u32) -> Result<Route> {
        require(member < self.count, "Dependency occurrence row")?;
        let row = member as usize;
        let source = self.moves.borrow().members.get(&member).copied();
        Ok(Route {
            line: self.get("occ.line", row)?,
            source: source.unwrap_or(self.get("occ.source", row)?),
        })
    }
    pub(crate) fn identity_line(&self, namespace: u32, key: u32) -> Result<Option<u32>> {
        self.find_pair("id.namespace", "id.key", (namespace, key))?
            .map(|row| self.get("id.line", row))
            .transpose()
    }
    pub(crate) fn members(&self, kind: &str, row: u32) -> Result<Vec<u32>> {
        require(
            matches!(kind, "line" | "raw" | "slice"),
            "Unknown dependency edge kind",
        )?;
        self.adjacent(kind, row as usize)
    }
    pub(crate) fn move_source(&self, member: u32, before: u32, after: u32) -> Result<()> {
        require(
            self.route(member)?.source == before,
            "Source dependency does not match the published snapshot",
        )?;
        let base = self.get("occ.source", member as usize)?;
        let mut moves = self.moves.borrow_mut();
        moves.members.remove(&member);
        if after != base {
            moves.members.insert(member, after);
        }
        Ok(())
    }
    pub(crate) fn within_move_bound(&self) -> bool {
        self.moves.borrow().members.len() <= MAX_MOVES
    }
    pub(crate) fn consumers(&self, member: u32) -> Result<BTreeSet<u32>> {
        let table = self.get("occ.def_table", member as usize)?;
        let key = self.get("occ.def_key", member as usize)?;
        if table == ABSENT || key == ABSENT {
            return Ok(BTreeSet::new());
        }
        Ok(
            match self.find_pair("ref.table", "ref.key", (table, key))? {
                Some(row) => self.adjacent("ref", row)?.into_iter().collect(),
                None => BTreeSet::new(),
            },
        )
    }
    pub(crate) fn commit(self, store: &Store, revision: &str) -> Result<()> {
        require(
            store.root["generation"].as_str() == Some(self.generation.as_str()),
            crate::Error::new(
                crate::ErrorCode::StaleGeneration,
                "Dependency graph generation changed during the update",
            ),
        )?;
        let moves = self.moves.borrow().members.clone();
        require(moves.len() <= MAX_MOVES, "Dependency move count")?;
        let state = State {
            version: VERSION,
            generation: self.generation.clone(),
            revision: revision.into(),
            base: self.base.clone(),
            moves,
        };
        let checksum = digest(&serde_json::to_vec(&state)?);
        atomic_json(
            &state_path(store),
            &serde_json::to_value(Envelope { state, checksum })?,
        )?;
        // Only a full graph replacement reclaims old bases. Ordinary edits touch the bounded
        // delta and state file; they never enumerate the directory or rewrite the base.
        if self.rebuilt {
            for entry in std::fs::read_dir(&store.directory)? {
                let entry = entry?;
                let name = entry.file_name();
                if let Some(name) = name.to_str()
                    && name != self.base
                    && valid_base(store, name)
                    && entry.file_type()?.is_file()
                {
                    std::fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Configuration;
    use serde_json::json;
    use std::io::{Read, Seek, SeekFrom, Write};

    fn configuration() -> Configuration {
        Configuration {
            cache_root: crate::test_directory("dependency-graph"),
            project_key: "project".into(),
            target_key: "target".into(),
            shared_project: false,
            view_prefix: None,
        }
    }
    fn fixture(count: usize) -> Columns {
        let mut columns = Columns::new();
        for name in ["occ.line", "site.object"] {
            columns.insert(name.into(), (0..count as u32).collect());
        }
        columns.insert(
            "occ.source".into(),
            (0..count as u32)
                .map(|n| if n < 5 { 42 } else { 100 + n })
                .collect(),
        );
        columns.insert("occ.def_table".into(), vec![ABSENT; count]);
        columns.insert("occ.def_key".into(), vec![ABSENT; count]);
        columns.get_mut("occ.def_table").expect("fixture column")[0..2].copy_from_slice(&[10, 10]);
        columns.get_mut("occ.def_key").expect("fixture column")[0..2].copy_from_slice(&[20, 21]);
        for kind in ["line", "raw", "slice"] {
            adjacency(&mut columns, kind, (0..count as u32).map(|row| vec![row]));
        }
        columns.insert("ref.table".into(), vec![10, 10, 10]);
        columns.insert("ref.key".into(), vec![20, 21, 22]);
        columns.insert("ref.start".into(), vec![0, 1, 2, 3]);
        columns.insert("ref.members".into(), vec![2, 3, 4]);
        columns.insert("id.namespace".into(), vec![10, 10]);
        columns.insert("id.key".into(), vec![20, 21]);
        columns.insert("id.line".into(), vec![100, 101]);
        columns
    }

    #[test]
    fn text_changes_keep_reference_identity_and_missing_targets_keep_their_consumers() -> Result<()>
    {
        let config = configuration();
        let store = Store::writer(config.clone())?;
        let count = 128;
        let mut columns = fixture(count);
        let graph = Graph::write(&store, count as u32, columns.clone())?;
        assert_eq!(graph.route(4)?.source, 42);
        assert_eq!(graph.identity_line(10, 20)?, Some(100));
        assert_eq!(graph.identity_line(10, 21)?, Some(101));
        assert_eq!(graph.identity_line(10, 22)?, None);
        assert_eq!(graph.consumers(0)?, BTreeSet::from([2]));
        assert_eq!(graph.consumers(1)?, BTreeSet::from([3]));
        assert!(graph.consumers(127)?.is_empty());
        let site = graph.get("site.object", 0)?;
        graph.move_source(0, 42, 43)?;
        assert_eq!(graph.route(0)?.source, 43);
        assert_eq!(graph.route(1)?.source, 42);
        assert_eq!(graph.get("site.object", 0)?, site);
        assert_eq!(graph.consumers(0)?, BTreeSet::from([2]));
        graph.commit(&store, "revision-1")?;
        let graph = Graph::open(&store, "revision-1")?.ok_or("Missing committed graph")?;
        assert_eq!(graph.route(0)?.source, 43);
        drop(graph);
        // A reference retarget preserves its text. A new definition finds an existing missing edge.
        columns.get_mut("occ.source").ok_or("Fixture source")?[0] = 43;
        columns
            .get_mut("occ.def_table")
            .ok_or("Fixture definition")?[127] = 10;
        columns.get_mut("occ.def_key").ok_or("Fixture definition")?[127] = 22;
        columns.insert("ref.table".into(), vec![10, 10]);
        columns.insert("ref.key".into(), vec![21, 22]);
        columns.insert("ref.start".into(), vec![0, 2, 3]);
        columns.insert("ref.members".into(), vec![2, 3, 4]);
        let graph = Graph::write(&store, count as u32, columns)?;
        assert!(graph.consumers(0)?.is_empty());
        assert_eq!(graph.consumers(1)?, BTreeSet::from([2, 3]));
        assert_eq!(graph.consumers(127)?, BTreeSet::from([4]));
        assert_eq!(graph.route(2)?.source, 42);
        graph.commit(&store, "revision-2")?;
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn rollback_and_revision_guards_preserve_the_base_and_undo_removes_the_delta() -> Result<()> {
        let config = configuration();
        let mut store = Store::writer(config.clone())?;
        let graph = Graph::write(&store, 128, fixture(128))?;
        let base = store.directory.join(&graph.base);
        graph.commit(&store, "revision-1")?;
        let before = std::fs::read(&base)?;
        {
            let graph = Graph::open(&store, "revision-1")?.ok_or("Missing graph")?;
            graph.move_source(7, 107, 42)?;
            assert!(graph.move_source(7, 107, 43).is_err());
            assert_eq!(graph.route(7)?.source, 42);
        }
        let graph = Graph::open(&store, "revision-1")?.ok_or("Missing graph after rollback")?;
        assert_eq!(graph.route(7)?.source, 107);
        graph.move_source(7, 107, 42)?;
        graph.commit(&store, "revision-2")?;
        assert_eq!(std::fs::read(&base)?, before);
        assert!(Graph::open(&store, "revision-1")?.is_none());
        let graph = Graph::open(&store, "revision-2")?.ok_or("Missing graph")?;
        graph.move_source(7, 42, 107)?;
        assert!(graph.moves.borrow().members.is_empty());
        graph.commit(&store, "revision-3")?;
        let graph = Graph::open(&store, "revision-3")?.ok_or("Missing graph")?;
        store.root["generation"] = json!("next-generation");
        assert_eq!(
            graph
                .commit(&store, "revision-4")
                .err()
                .ok_or("Expected generation error")?
                .code,
            crate::ErrorCode::StaleGeneration
        );
        assert!(Graph::open(&store, "revision-3")?.is_none());
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn accumulated_source_moves_request_rebuild_before_publication_and_undo_frees_capacity()
    -> Result<()> {
        let config = configuration();
        let store = Store::writer(config.clone())?;
        let count = MAX_MOVES + 1;
        let graph = Graph::write(&store, count as u32, fixture(count))?;
        graph.commit(&store, "published")?;
        let graph = Graph::open(&store, "published")?.ok_or("Missing graph")?;
        for member in 0..MAX_MOVES as u32 {
            graph.move_source(member, graph.route(member)?.source, 99)?;
        }
        assert!(graph.within_move_bound());
        graph.commit(&store, "at-capacity")?;
        let graph = Graph::open(&store, "at-capacity")?.ok_or("Missing graph")?;
        let last = MAX_MOVES as u32;
        graph.move_source(last, graph.route(last)?.source, 99)?;
        assert!(!graph.within_move_bound());
        // Crossing the bound is disposable work, not a failed published edit.
        drop(graph);
        let graph = Graph::open(&store, "at-capacity")?.ok_or("Missing published graph")?;
        assert_ne!(graph.route(last)?.source, 99);
        graph.move_source(0, 99, 42)?;
        graph.move_source(last, graph.route(last)?.source, 99)?;
        assert!(graph.within_move_bound());
        graph.commit(&store, "capacity-reused")?;
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn dependency_lookups_read_selected_pages_and_check_integrity_when_touched() -> Result<()> {
        let config = configuration();
        let store = Store::writer(config.clone())?;
        let count = PAGE * 3 + 17;
        let graph = Graph::write(&store, count as u32, fixture(count))?;
        graph.commit(&store, "revision-1")?;
        let graph = Graph::open(&store, "revision-1")?.ok_or("Missing graph")?;
        let last = count as u32 - 1;
        assert_eq!(graph.route(last)?.line, last);
        assert_eq!(graph.route(0)?.source, 42);
        assert_eq!(graph.members("raw", last)?, vec![last]);
        assert!(
            graph.pages.borrow().loads < 32,
            "A point dependency lookup must not hydrate the graph"
        );
        assert!(graph.pages.borrow().loads * 2 < graph.pages.borrow().reader.entries.len());
        let offset = graph
            .pages
            .borrow()
            .reader
            .entries
            .iter()
            .find(|e| e.name == "occ.source.p1")
            .ok_or("Missing untouched page")?
            .offset;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(store.directory.join(&graph.base))?;
        file.seek(SeekFrom::Start(offset))?;
        let mut byte = [0];
        file.read_exact(&mut byte)?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(&[byte[0] ^ 0xff])?;
        file.sync_all()?;
        assert_eq!(graph.route(last)?.line, last);
        assert!(graph.route(PAGE as u32 + 3).is_err());
        drop(file);
        drop(graph);
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&bounded(&state_path(&store), 1024 * 1024)?)?;
        envelope["state"]["revision"] = json!("tampered");
        atomic_json(&state_path(&store), &envelope)?;
        assert!(Graph::open(&store, "revision-1").is_err());
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }
}

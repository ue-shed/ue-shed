//! Writer-owned, indexed dependencies. Values and reference edges have separate identities.
//!
//! The graph is a disposable acceleration of a named immutable snapshot. A transaction is
//! advanced before publication; a crash on either side of publication leaves a revision mismatch,
//! never a graph silently paired with another snapshot. Query readers keep their immutable files.
use crate::join::Joined;
use crate::join_columns::*;
use crate::store::{Store, digest};
use crate::{Result, require};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

pub(crate) struct Graph {
    db: Connection,
    generation: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub member: u32,
    pub line: u32,
    pub raw: u32,
    pub slice: u32,
    pub place: u32,
    pub source: u32,
    pub eligible: bool,
}

fn path(store: &Store) -> PathBuf {
    let view = store.configuration_view_prefix().unwrap_or("");
    store
        .directory
        .join(format!("dependencies-{}.sqlite", digest(view.as_bytes())))
}

fn connect(path: &std::path::Path, generation: &str) -> Result<Graph> {
    let db = Connection::open(path)?;
    // The enclosing native writer lease serializes graph writers. Full durability is retained;
    // a revision mismatch can reconstruct derived dependencies, but must not hide IO failures.
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA cache_size=-8192; BEGIN IMMEDIATE;")?;
    Ok(Graph {
        db,
        generation: generation.into(),
    })
}

impl Graph {
    pub(crate) fn open(store: &Store, revision: &str) -> Result<Option<Self>> {
        let file = path(store);
        if !file.try_exists()? {
            return Ok(None);
        }
        let generation = store.root["generation"]
            .as_str()
            .ok_or("graph generation")?;
        let graph = connect(&file, generation)?;
        if graph
            .db
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))?
            != 2
        {
            return Ok(None);
        }
        let identity: Option<(String, String)> = graph
            .db
            .query_row(
                "SELECT generation, revision FROM revision WHERE id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let generation = store.root["generation"]
            .as_str()
            .ok_or("graph generation")?;
        Ok(identity
            .filter(|(g, r)| g == generation && r == revision)
            .map(|_| graph))
    }

    /// Cold construction records physical projection rows separately from the logical site.
    /// Neither the text value nor the referenced target participates in a site's identity.
    pub(crate) fn rebuild(
        store: &Store,
        joined: &Joined,
        columns: &[(String, String, Vec<u32>)],
    ) -> Result<Self> {
        let started = std::time::Instant::now();
        let generation = store.root["generation"]
            .as_str()
            .ok_or("graph generation")?;
        let graph = connect(&path(store), generation)?;
        graph.db.execute_batch(
            "DROP TABLE IF EXISTS reference;
             DROP TABLE IF EXISTS occurrence;
             DROP TABLE IF EXISTS identity;
             DROP TABLE IF EXISTS revision;
             CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, revision TEXT NOT NULL);
             CREATE TABLE identity(namespace INTEGER NOT NULL, entry_key INTEGER NOT NULL, line INTEGER NOT NULL,
               PRIMARY KEY(namespace,entry_key)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS occurrence(
               member INTEGER PRIMARY KEY, package INTEGER NOT NULL, object INTEGER NOT NULL,
               property INTEGER NOT NULL, row_name INTEGER NOT NULL, location INTEGER NOT NULL,
               ordinal INTEGER NOT NULL, line INTEGER NOT NULL, raw INTEGER NOT NULL,
               slice INTEGER NOT NULL, place INTEGER NOT NULL, source INTEGER NOT NULL,
               eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
               UNIQUE(package,object,property,row_name,location,ordinal));
             CREATE TABLE IF NOT EXISTS reference(
               member INTEGER NOT NULL REFERENCES occurrence(member) ON DELETE CASCADE,
               kind INTEGER NOT NULL CHECK(kind IN (1,2)), table_id INTEGER NOT NULL,
               entry_key INTEGER NOT NULL, PRIMARY KEY(member,kind)) WITHOUT ROWID;
             PRAGMA user_version=2;"
        )?;
        let get = |name: &str| {
            columns
                .iter()
                .find(|(n, _, _)| n == name)
                .map(|(_, _, values)| values.as_slice())
                .ok_or_else(|| crate::Error::from(format!("Missing graph input {name}")))
        };
        let count = joined.order.len();
        let mut lines = vec![u32::MAX; count];
        for (row, group) in joined.groups.iter().enumerate() {
            for member in &joined.order[group.os..group.oe] {
                *lines.get_mut(*member as usize).ok_or("graph line member")? = row as u32;
            }
        }
        let mut raw = vec![u32::MAX; count];
        let mut slices = vec![u32::MAX; count];
        for (kind, routes) in [("raw", &mut raw), ("slice", &mut slices)] {
            let starts = get(&format!("query.{kind}.member_start"))?;
            let ends = get(&format!("query.{kind}.member_end"))?;
            let members = get(&format!("query.{kind}.members"))?;
            require(starts.len() == ends.len(), "graph membership bounds")?;
            for (row, (start, end)) in starts.iter().zip(ends).enumerate() {
                for member in members
                    .get(*start as usize..*end as usize)
                    .ok_or("graph membership range")?
                {
                    let slot = routes
                        .get_mut(*member as usize)
                        .ok_or("graph membership row")?;
                    require(*slot == u32::MAX, "duplicate graph membership")?;
                    *slot = row as u32;
                }
            }
        }
        let places = get("query.occurrence.places")?;
        require(places.len() == count, "graph place length")?;
        let c = &joined.packages.occurrence;
        let mut insert = graph
            .db
            .prepare_cached("INSERT INTO occurrence VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")?;
        let mut edge = graph
            .db
            .prepare_cached("INSERT INTO reference VALUES(?,?,?,?)")?;
        let mut package = None;
        let mut ordinals = BTreeMap::new();
        for member in 0..count {
            let next = joined.packages.package_row[member];
            if package != Some(next) {
                package = Some(next);
                ordinals.clear();
            }
            require(
                lines[member] != u32::MAX && raw[member] != u32::MAX && slices[member] != u32::MAX,
                "incomplete graph membership",
            )?;
            let site = (
                c[O_OBJECT][member],
                c[O_PROPERTY][member],
                c[O_ROW][member],
                c[O_LOCATION][member],
            );
            let ordinal = ordinals.entry(site).or_insert(0u32);
            insert.execute(params![
                member as u32,
                joined.packages.paths[next as usize],
                site.0,
                site.1,
                site.2,
                site.3,
                *ordinal,
                lines[member],
                raw[member],
                slices[member],
                places[member],
                c[O_SOURCE][member],
                c[O_IDENTITY][member] == 0 && c[O_KEY][member] != joined.empty
            ])?;
            *ordinal += 1;
            if c[O_IDENTITY][member] == 1 {
                // Unresolved targets remain indexed even when no definition exists yet.
                edge.execute(params![member as u32, 1, c[O_NS][member], c[O_KEY][member]])?;
            } else if c[O_LOCATION][member] == 2 && c[O_IDENTITY][member] == 0 {
                edge.execute(params![
                    member as u32,
                    2,
                    c[O_OBJECT][member],
                    c[O_ROW][member]
                ])?;
            }
        }
        drop(insert);
        drop(edge);
        let mut identity = graph
            .db
            .prepare_cached("INSERT INTO identity VALUES(?,?,?)")?;
        for row in 0..joined.groups.len() {
            if joined.resolved(row) {
                identity.execute(params![
                    joined.line[crate::join::L_NS][row],
                    joined.line[crate::join::L_KEY][row],
                    row as u32
                ])?;
            }
        }
        drop(identity);
        graph.db.execute_batch(
            "CREATE INDEX source_members ON occurrence(source,member);
             CREATE INDEX raw_members ON occurrence(raw,member);
             CREATE INDEX line_members ON occurrence(line,member);
             CREATE INDEX slice_members ON occurrence(slice,member);
             CREATE INDEX reference_consumers ON reference(table_id,entry_key,kind,member);",
        )?;
        crate::join_incremental::note(
            "dependencyGraphBuildSeconds",
            serde_json::json!(started.elapsed().as_secs_f64()),
        );
        Ok(graph)
    }

    pub(crate) fn route(&self, member: u32) -> Result<Route> {
        Ok(self.db.query_row(
            "SELECT member,line,raw,slice,place,source,eligible FROM occurrence WHERE member=?",
            [member],
            route,
        )?)
    }

    pub(crate) fn identity_line(&self, namespace: u32, key: u32) -> Result<Option<u32>> {
        Ok(self
            .db
            .query_row(
                "SELECT line FROM identity WHERE namespace=? AND entry_key=?",
                params![namespace, key],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub(crate) fn source_members(&self, source: u32) -> Result<Vec<Route>> {
        let mut query = self.db.prepare_cached("SELECT member,line,raw,slice,place,source,eligible FROM occurrence WHERE source=? ORDER BY member")?;
        Ok(query
            .query_map([source], route)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn members(&self, kind: &str, row: u32) -> Result<Vec<u32>> {
        let sql = match kind {
            "line" => "SELECT member FROM occurrence WHERE line=? ORDER BY member",
            "raw" => "SELECT member FROM occurrence WHERE raw=? ORDER BY member",
            "slice" => "SELECT member FROM occurrence WHERE slice=? ORDER BY member",
            _ => return Err("Unknown dependency edge kind".into()),
        };
        let mut query = self.db.prepare_cached(sql)?;
        Ok(query
            .query_map([row], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn move_source(&self, member: u32, before: u32, after: u32) -> Result<()> {
        require(
            self.db.execute(
                "UPDATE occurrence SET source=? WHERE member=? AND source=?",
                params![after, member, before],
            )? == 1,
            "Source dependency does not match the published snapshot",
        )
    }

    /// A definition's consumers are selected by the target edge, never by source equality.
    pub(crate) fn consumers(&self, member: u32) -> Result<BTreeSet<u32>> {
        let mut query = self.db.prepare_cached(
            "SELECT consumer.member FROM reference definition JOIN reference consumer
             ON definition.table_id=consumer.table_id AND definition.entry_key=consumer.entry_key
             WHERE definition.member=? AND definition.kind=2 AND consumer.kind=1 ORDER BY consumer.member"
        )?;
        Ok(query
            .query_map([member], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub(crate) fn commit(self, store: &Store, revision: &str) -> Result<()> {
        let generation = store.root["generation"]
            .as_str()
            .ok_or("graph generation")?;
        require(
            generation == self.generation,
            crate::Error::new(
                crate::ErrorCode::StaleGeneration,
                "Dependency graph generation changed during the update",
            ),
        )?;
        self.db.execute(
            "INSERT OR REPLACE INTO revision VALUES(1,?,?)",
            params![generation, revision],
        )?;
        self.db.execute_batch("COMMIT")?;
        Ok(())
    }
}

fn route(row: &rusqlite::Row<'_>) -> rusqlite::Result<Route> {
    Ok(Route {
        member: row.get(0)?,
        line: row.get(1)?,
        raw: row.get(2)?,
        slice: row.get(3)?,
        place: row.get(4)?,
        source: row.get(5)?,
        eligible: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Configuration;
    use serde_json::json;

    fn empty(store: &Store) -> Result<Graph> {
        let joined = Joined {
            line: Vec::new(),
            cultures: Vec::new(),
            groups: Vec::new(),
            order: Vec::new(),
            raw_order: Vec::new(),
            unit: Vec::new(),
            next: Vec::new(),
            package_files: Vec::new(),
            empty: 0,
            packages: PackageColumns {
                names: Vec::new(),
                starts: Vec::new(),
                occurrence: std::array::from_fn(|_| Vec::new()),
                package_row: Vec::new(),
                paths: Vec::new(),
                status: Vec::new(),
                coverage: Vec::new(),
                relative_paths: Vec::new(),
                statuses: BTreeMap::new(),
            },
            manifest: FileColumns {
                name: String::new(),
                columns: std::array::from_fn(|_| Vec::new()),
                order: Vec::new(),
                loaded: false,
                missing: false,
                has_source: false,
                prefix: String::new(),
            },
            archives: Vec::new(),
            pos: Vec::new(),
            strings: Vec::new(),
            unit_ids: Vec::new(),
        };
        let mut columns = vec![("query.occurrence.places".into(), String::new(), Vec::new())];
        for kind in ["raw", "slice"] {
            for field in ["member_start", "member_end", "members"] {
                columns.push((format!("query.{kind}.{field}"), String::new(), Vec::new()));
            }
        }
        Graph::rebuild(store, &joined, &columns)
    }

    fn configuration() -> Configuration {
        Configuration {
            cache_root: crate::test_directory("dependency-graph"),
            project_key: "project".into(),
            target_key: "target".into(),
            shared_project: false,
            view_prefix: None,
        }
    }

    fn occurrence(graph: &Graph, member: u32, source: u32) -> Result<()> {
        graph.db.execute(
            "INSERT INTO occurrence VALUES(?,1,?,3,4,0,0,?, ?, ?,7,?,1)",
            params![
                member,
                member,
                member + 10,
                member + 20,
                member + 30,
                source
            ],
        )?;
        Ok(())
    }

    #[test]
    fn source_values_do_not_merge_reference_targets_and_missing_targets_retain_consumers()
    -> Result<()> {
        let config = configuration();
        let store = Store::writer(config.clone())?;
        let graph = empty(&store)?;
        for member in 0..5 {
            occurrence(&graph, member, 42)?;
        }
        graph
            .db
            .execute_batch("INSERT INTO identity VALUES(10,20,100),(10,21,101)")?;
        assert_eq!(graph.identity_line(10, 20)?, Some(100));
        assert_eq!(graph.identity_line(10, 21)?, Some(101));
        assert_eq!(graph.identity_line(10, 22)?, None);
        graph.db.execute_batch("INSERT INTO reference VALUES(0,2,10,20),(1,2,10,21),(2,1,10,20),(3,1,10,21),(4,1,10,22)")?;
        assert_eq!(graph.source_members(42)?.len(), 5);
        assert_eq!(graph.consumers(0)?, BTreeSet::from([2]));
        assert_eq!(graph.consumers(1)?, BTreeSet::from([3]));
        graph.move_source(0, 42, 43)?;
        assert_eq!(graph.consumers(0)?, BTreeSet::from([2]));
        assert_eq!(graph.source_members(43)?[0].member, 0);
        // A new definition finds a pre-existing unresolved edge without scanning occurrences.
        occurrence(&graph, 900_000, 42)?;
        graph
            .db
            .execute("INSERT INTO reference VALUES(900000,2,10,22)", [])?;
        assert_eq!(graph.consumers(900_000)?, BTreeSet::from([4]));
        // A retarget with identical text changes dependencies while preserving all source values.
        graph.db.execute(
            "UPDATE reference SET entry_key=21 WHERE member=2 AND kind=1",
            [],
        )?;
        assert!(graph.consumers(0)?.is_empty());
        assert_eq!(graph.consumers(1)?, BTreeSet::from([2, 3]));
        graph.commit(&store, "revision-1")?;
        let graph = Graph::open(&store, "revision-1")?.ok_or("missing committed graph")?;
        assert_eq!(graph.route(900_000)?.line, 900_010);
        assert_eq!(graph.members("raw", 900_020)?, vec![900_000]);
        let plan: String = graph.db.query_row(
            "EXPLAIN QUERY PLAN SELECT member FROM occurrence WHERE source=42 ORDER BY member",
            [],
            |r| r.get(3),
        )?;
        assert!(plan.contains("source_members"), "{plan}");
        drop(graph);
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }

    #[test]
    fn uncommitted_edits_roll_back_and_publication_or_generation_mismatches_never_reuse_dependencies()
    -> Result<()> {
        let config = configuration();
        let mut store = Store::writer(config.clone())?;
        let graph = empty(&store)?;
        occurrence(&graph, 7, 40)?;
        graph.commit(&store, "revision-1")?;
        {
            let graph = Graph::open(&store, "revision-1")?.ok_or("missing graph")?;
            graph.move_source(7, 40, 41)?;
            assert!(graph.move_source(7, 40, 42).is_err());
            assert_eq!(graph.route(7)?.source, 41);
        }
        let graph = Graph::open(&store, "revision-1")?.ok_or("missing graph after rollback")?;
        assert_eq!(graph.route(7)?.source, 40);
        // Simulate graph commit followed by a failed immutable-root publication.
        graph.move_source(7, 40, 41)?;
        graph.commit(&store, "revision-2")?;
        assert!(Graph::open(&store, "revision-1")?.is_none());
        let changed_generation = Graph::open(&store, "revision-2")?.ok_or("missing graph")?;
        store.root["generation"] = json!("next-generation");
        assert_eq!(
            changed_generation
                .commit(&store, "revision-3")
                .err()
                .ok_or("expected generation failure")?
                .code,
            crate::ErrorCode::StaleGeneration
        );
        assert!(Graph::open(&store, "revision-2")?.is_none());
        drop(store);
        std::fs::remove_dir_all(config.cache_root)?;
        Ok(())
    }
}

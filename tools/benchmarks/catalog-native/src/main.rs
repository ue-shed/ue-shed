//! Native validation of the Python experiment's exact query plans and synthetic database files.
//! Usage: catalog-storage-research <query-spec.json> <runs> <output.json>
use std::collections::hash_map::DefaultHasher;
use std::error::Error;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

type Fallible<T> = Result<T, Box<dyn Error>>;
type HeaderRow = (String, String, Vec<String>, Vec<String>);

#[derive(Deserialize)]
struct Experiment {
    engines: Vec<EngineSpec>,
}

#[derive(Deserialize)]
struct EngineSpec {
    name: String,
    path: String,
    queries: Vec<Query>,
}

#[derive(Deserialize)]
struct Query {
    kind: String,
    sql: String,
    args: Vec<String>,
}

#[derive(Serialize, PartialEq, Eq)]
struct Signature {
    items: usize,
    pages: usize,
    fingerprint: u64,
}

#[derive(Serialize)]
struct QueryResult {
    kind: String,
    milliseconds: f64,
    signature: Signature,
}

#[derive(Serialize)]
struct Sample {
    engine: String,
    run: usize,
    reopen: bool,
    milliseconds: f64,
    queries: Vec<QueryResult>,
}

enum Database {
    Duck(duckdb::Connection),
    Sqlite(rusqlite::Connection),
}

impl Database {
    fn open(spec: &EngineSpec) -> Fallible<Self> {
        if spec.name.starts_with("duckdb") {
            let config = duckdb::Config::default()
                .access_mode(duckdb::AccessMode::ReadOnly)?
                .threads(4)?
                .enable_autoload_extension(false)?;
            Ok(Self::Duck(duckdb::Connection::open_with_flags(
                &spec.path, config,
            )?))
        } else {
            let connection = rusqlite::Connection::open_with_flags(
                &spec.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            connection.execute_batch("PRAGMA cache_size=-65536")?;
            Ok(Self::Sqlite(connection))
        }
    }

    fn page(&self, query: &Query, cursor: &str) -> Fallible<Vec<HeaderRow>> {
        let maps = query.kind == "maps";
        match self {
            Self::Duck(connection) => {
                use duckdb::types::Value;
                let args = std::iter::once(Value::Text(cursor.to_owned()))
                    .chain(query.args.iter().cloned().map(Value::Text))
                    .chain(std::iter::once(Value::UBigInt(1025)));
                let mut statement = connection.prepare(&query.sql)?;
                let mut rows = statement.query(duckdb::params_from_iter(args))?;
                let mut page = Vec::new();
                while let Some(row) = rows.next()? {
                    page.push((
                        row.get(0)?,
                        row.get(1)?,
                        if maps {
                            Vec::new()
                        } else {
                            strings(row.get(2)?)?
                        },
                        if maps {
                            Vec::new()
                        } else {
                            strings(row.get(3)?)?
                        },
                    ));
                }
                Ok(page)
            }
            Self::Sqlite(connection) => {
                use rusqlite::types::Value;
                let args = std::iter::once(Value::Text(cursor.to_owned()))
                    .chain(query.args.iter().cloned().map(Value::Text))
                    .chain(std::iter::once(Value::Integer(1025)));
                let mut statement = connection.prepare(&query.sql)?;
                let mut rows = statement.query(rusqlite::params_from_iter(args))?;
                let mut page = Vec::new();
                while let Some(row) = rows.next()? {
                    page.push((
                        row.get(0)?,
                        row.get(1)?,
                        if maps {
                            Vec::new()
                        } else {
                            serde_json::from_str(&row.get::<_, String>(2)?)?
                        },
                        if maps {
                            Vec::new()
                        } else {
                            serde_json::from_str(&row.get::<_, String>(3)?)?
                        },
                    ));
                }
                Ok(page)
            }
        }
    }
}

fn strings(value: duckdb::types::Value) -> Fallible<Vec<String>> {
    use duckdb::types::Value;
    let Value::List(values) = value else {
        return Err("expected string list".into());
    };
    values
        .into_iter()
        .map(|v| match v {
            Value::Text(s) => Ok(s),
            _ => Err("expected string element".into()),
        })
        .collect()
}

fn workload(spec: &EngineSpec, run: usize, reopen: bool) -> Fallible<Sample> {
    let start = Instant::now();
    let mut database = None;
    let mut queries = Vec::new();
    for query in &spec.queries {
        let start = Instant::now();
        let mut cursor = String::new();
        let mut items = 0;
        let mut pages = 0;
        let mut fingerprint = DefaultHasher::new();
        loop {
            if database.is_none() {
                database = Some(Database::open(spec)?);
            }
            let mut page = database.as_ref().unwrap().page(query, &cursor)?;
            let more = page.len() > 1024;
            page.truncate(1024);
            page.hash(&mut fingerprint);
            items += page.len();
            pages += 1;
            if reopen {
                database = None;
            }
            if !more {
                break;
            }
            cursor = page.last().ok_or("empty continuing page")?.0.clone();
        }
        queries.push(QueryResult {
            kind: query.kind.clone(),
            milliseconds: start.elapsed().as_secs_f64() * 1000.0,
            signature: Signature {
                items,
                pages,
                fingerprint: fingerprint.finish(),
            },
        });
    }
    drop(database);
    Ok(Sample {
        engine: spec.name.clone(),
        run,
        reopen,
        milliseconds: start.elapsed().as_secs_f64() * 1000.0,
        queries,
    })
}

fn main() -> Fallible<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err(
            "usage: catalog-storage-research <query-spec.json> <runs> <output.json>".into(),
        );
    }
    let experiment: Experiment = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let runs: usize = args[2].parse()?;
    if runs == 0 || experiment.engines.is_empty() {
        return Err("positive runs and engines required".into());
    }
    let mut samples: Vec<Sample> = Vec::new();
    for run in 0..=runs {
        for offset in 0..experiment.engines.len() {
            let spec = &experiment.engines[(run + offset) % experiment.engines.len()];
            let sample = workload(spec, run, run == runs)?;
            if let Some(first) = samples.first() {
                assert!(
                    first
                        .queries
                        .iter()
                        .map(|q| &q.signature)
                        .eq(sample.queries.iter().map(|q| &q.signature)),
                    "ordered hydrated results differ: {}",
                    spec.name
                );
            }
            println!(
                "{} run={run} reopen={} ms={:.3}",
                spec.name, sample.reopen, sample.milliseconds
            );
            samples.push(sample);
            let output =
                serde_json::json!({"sqlite_version": rusqlite::version(), "samples": samples});
            std::fs::write(Path::new(&args[3]), serde_json::to_vec_pretty(&output)?)?;
        }
    }
    Ok(())
}

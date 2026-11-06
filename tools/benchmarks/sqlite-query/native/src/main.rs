//! Research-only SQLite adapter using the production frame and batch encoders.
//! Serial requests only: this is not a shipping engine or a cancellation implementation.
use game_text_index::batch::{Batches, LINE};
use game_text_index::engine::{EngineRequest, Profile, Reply};
use game_text_index::session::{EngineEnd, Frame, Kind, LAST, read_frame, write_frame};
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::time::Instant;

#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SqlRequest {
    sql: String,
    parameters: Vec<rusqlite_value::Parameter>,
    output: Output,
}
#[derive(Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
enum Output {
    Lines,
    Rows,
}

mod rusqlite_value {
    use rusqlite::types::{ToSql, ToSqlOutput, Value};
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[cfg_attr(test, derive(ts_rs::TS))]
    #[serde(untagged)]
    pub enum Parameter {
        Integer(#[cfg_attr(test, ts(type = "number"))] i64),
        Real(f64),
        Text(String),
        Null,
    }
    impl ToSql for Parameter {
        fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
            Ok(ToSqlOutput::Owned(match self {
                Self::Integer(value) => Value::Integer(*value),
                Self::Real(value) => Value::Real(*value),
                Self::Text(value) => Value::Text(value.clone()),
                Self::Null => Value::Null,
            }))
        }
    }
}

struct Outgoing<'a, R, W> {
    input: &'a mut R,
    output: &'a mut W,
    request: u32,
    outstanding: u32,
    batches: u32,
    bytes: u64,
}
impl<R: Read, W: Write> Reply for Outgoing<'_, R, W> {
    fn part(&mut self, body: Vec<u8>) -> game_text_index::Result<()> {
        write_frame(self.output, Kind::Part, 0, self.request, &body)?;
        Ok(())
    }
    fn batch(&mut self, body: Vec<u8>) -> game_text_index::Result<()> {
        while self.outstanding >= game_text_index::session::WINDOW {
            let frame = read_frame(self.input)?.ok_or("Host closed before consuming batches")?;
            if frame.kind != Kind::Credit || frame.request != self.request {
                return Err("The serial spike expects only batch credits while streaming".into());
            }
            self.outstanding = self.outstanding.saturating_sub(1);
        }
        write_frame(self.output, Kind::Batch, 0, self.request, &body)?;
        self.output.flush()?;
        self.outstanding += 1;
        self.batches += 1;
        self.bytes += body.len() as u64;
        Ok(())
    }
    fn text(&mut self, _: Vec<u8>) -> game_text_index::Result<()> {
        Err("The SQLite spike does not implement text export sinks".into())
    }
}

fn query<R: Read, W: Write>(
    connection: &Connection,
    request: SqlRequest,
    reply: &mut Outgoing<'_, R, W>,
) -> Result<Profile, Box<dyn std::error::Error>> {
    let mut profile = Profile::now();
    let started = Instant::now();
    let mut statement = connection.prepare_cached(&request.sql)?;
    let columns = statement
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut rows = statement.query(params_from_iter(request.parameters.iter()))?;
    let mut records = Vec::new();
    let mut batches = Batches::new(&LINE, "lines", LINE.select(&["id", "identity", "source"])?);
    let mut sql_time = started.elapsed();
    let mut encode_time = std::time::Duration::ZERO;
    loop {
        let read_at = Instant::now();
        let Some(row) = rows.next()? else {
            sql_time += read_at.elapsed();
            break;
        };
        let mut record = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value = match row.get_ref(index)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(value) => json!(value),
                rusqlite::types::ValueRef::Real(value) => json!(value),
                rusqlite::types::ValueRef::Text(value) => json!(std::str::from_utf8(value)?),
                rusqlite::types::ValueRef::Blob(_) => {
                    return Err("BLOB output is not a query case".into());
                }
            };
            record.insert(name.clone(), value);
        }
        sql_time += read_at.elapsed();
        let encoded = Instant::now();
        match request.output {
            Output::Rows => records.push(record),
            Output::Lines => {
                let namespace = record.remove("namespace").ok_or("Missing namespace")?;
                let key = record.remove("key").ok_or("Missing key")?;
                let identity = if namespace.is_null() {
                    Value::Null
                } else {
                    json!({"namespace":namespace,"key":key})
                };
                record.insert("identity".into(), identity);
                batches.push(&Value::Object(record))?;
                if batches.full() {
                    batches.flush(reply)?;
                }
            }
        }
        encode_time += encoded.elapsed();
    }
    let encoded = Instant::now();
    match request.output {
        Output::Rows => {
            reply.part(game_text_index::wtf8::view_json(&json!(records))?.into_bytes())?
        }
        Output::Lines => {
            batches.finish(reply)?;
        }
    }
    encode_time += encoded.elapsed();
    profile
        .stage_seconds
        .insert("sql_and_rows".into(), sql_time.as_secs_f64());
    profile
        .stage_seconds
        .insert("encode_and_send".into(), encode_time.as_secs_f64());
    profile.batches = reply.batches;
    profile.batch_bytes = reply.bytes;
    Ok(profile)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let database = std::env::var("UE_SHED_SQLITE_SPIKE_DB")?;
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.set_prepared_statement_cache_capacity(128);
    connection.execute_batch("PRAGMA cache_size=-65536;")?;
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    while let Some(Frame {
        kind,
        request: id,
        body,
        ..
    }) = read_frame(&mut input)?
    {
        if kind == Kind::Credit {
            continue;
        }
        if kind != Kind::Request {
            return Err("Unsupported spike frame".into());
        }
        let request: EngineRequest = serde_json::from_slice(&body)?;
        let mut reply = Outgoing {
            input: &mut input,
            output: &mut output,
            request: id,
            outstanding: 0,
            batches: 0,
            bytes: 0,
        };
        let profile = match request {
            EngineRequest::Capabilities => {
                reply.part(serde_json::to_vec(&game_text_index::contract::identity())?)?;
                Profile::now()
            }
            EngineRequest::LocalizationExport { request, .. } => {
                query(&connection, serde_json::from_value(request)?, &mut reply)?
            }
            _ => return Err("Unsupported spike operation".into()),
        };
        write_frame(
            &mut output,
            Kind::End,
            LAST,
            id,
            &serde_json::to_vec(&EngineEnd { profile })?,
        )?;
        output.flush()?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ts_rs::TS;
    #[test]
    fn host_contract_matches_rust() {
        let config = ts_rs::Config::default();
        let generated = format!(
            "// Generated by native/src/main.rs: host_contract_matches_rust.\nexport {}\nexport {}\nexport {}\n",
            rusqlite_value::Parameter::decl(&config),
            Output::decl(&config),
            SqlRequest::decl(&config)
        );
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../contract.generated.ts");
        if std::env::var_os("UE_SHED_UPDATE_GENERATED").is_some() {
            std::fs::write(&path, &generated).expect("write generated spike contract");
        }
        // TypeScript formatting may replace object commas with semicolons; both have the same tokens.
        let tokens = |text: &str| {
            text.chars()
                .filter(|c| !c.is_whitespace() && *c != ',' && *c != ';')
                .collect::<String>()
        };
        assert_eq!(
            tokens(&std::fs::read_to_string(path).expect("read generated spike contract")),
            tokens(&generated)
        );
    }
}

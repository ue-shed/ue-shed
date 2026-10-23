//! Game Text column encoding and shared-store mechanics, used by the native IO build capability.
//! Native IO owns transport; this library never reads Unreal projects or launches editors.
mod bounded_intern;
mod error;
pub use error::{Error, ErrorCode};
pub mod builder;
mod dependency_graph;
pub mod dictionary;
pub mod engine;
mod engine_aggregate;
mod engine_asset_types;
mod engine_detail;
mod engine_evidence;
mod engine_export;
mod engine_focus;
mod engine_match;
mod engine_page;
mod engine_places;
mod engine_query;
mod engine_reader;
mod engine_rollup;
mod engine_search;
mod engine_summary;
mod engine_text;
mod engine_types;
pub mod join;
mod join_columns;
#[cfg(test)]
mod join_fact_tests;
pub mod join_incremental;
mod join_marks;
mod join_places;
mod join_policy;
mod join_query;
mod json_value;
mod layer_reuse;
mod line_break;
#[rustfmt::skip]
mod line_break_tables;
mod package_delta;
mod package_evidence;
mod query_cache;
pub mod snapshot;
pub mod store;
mod summary_state;
mod text_problem;
#[rustfmt::skip]
mod text_problem_rules;
pub mod wtf8;

pub type Result<T> = std::result::Result<T, Error>;

pub fn require(ok: bool, message: impl Into<Error>) -> Result<()> {
    if ok { Ok(()) } else { Err(message.into()) }
}

#[cfg(test)]
pub(crate) fn test_directory(kind: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate is in the workspace crates directory")
        .join("test-results/rust-index")
        .join(format!("{kind}-{}", store::token()))
}

mod source_patch;

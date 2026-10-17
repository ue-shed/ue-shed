//! Game Text column encoding and shared-store mechanics, used by the native IO build capability.
//! Native IO owns transport; this library never reads Unreal projects or launches editors.
mod bounded_intern;
mod error;
pub use error::{Error, ErrorCode};
pub mod builder;
pub mod dictionary;
pub mod join;
mod join_columns;
pub mod join_incremental;
mod join_marks;
mod join_overlay;
mod join_places;
mod join_policy;
mod join_query;
mod json_value;
mod package_evidence;
pub mod snapshot;
pub mod store;
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

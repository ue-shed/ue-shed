//! Filesystem, process, and protocol ownership for Unreal asset operations.
//!
//! The library exposes typed request/event boundary models. The `uasset` executable adapts the
//! library to human compatibility commands and the bounded NDJSON process seam.

mod cancellation;
mod direct_executor;
mod legacy;
mod package_text_columns;
pub mod protocol;
mod protocol_adapter;
pub mod protocol_result;
mod reader_memory;

#[doc(hidden)]
pub mod package_text_test_support {
    pub use crate::package_text_columns::{AudienceRule, Columns, Stored, write_staged};
}

#[cfg(test)]
use uasset_parser::{archive, package, version};
#[cfg(test)]
#[allow(dead_code)]
#[path = "../../uasset-parser/src/test_support.rs"]
mod test_support;

pub fn run(arguments: impl Iterator<Item = std::ffi::OsString>) -> u8 {
    let arguments: Vec<_> = arguments.collect();
    match arguments.first().and_then(|value| value.to_str()) {
        Some("protocol") => protocol_adapter::run(),
        Some("protocol-session") => protocol_adapter::run_session(),
        Some("game-text-engine") => game_text_engine(),
        _ => legacy::run(arguments),
    }
}
/// The Game Text engine session: binary frames on stdin and stdout until stdin closes.
fn game_text_engine() -> u8 {
    game_text_index::session::size_shared_pool();
    let output = std::io::BufWriter::with_capacity(1 << 20, std::io::stdout());
    match game_text_index::session::serve(std::io::stdin().lock(), output) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("game-text-engine: {error}");
            1
        }
    }
}
pub use protocol_result::{ResultFrame, SavedAssetInspection};

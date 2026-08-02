//! Filesystem, process, and protocol ownership for Unreal asset operations.
//!
//! The library exposes typed request/event boundary models. The `uasset` executable adapts the
//! library to human compatibility commands and the bounded NDJSON process seam.

mod cancellation;
mod direct_executor;
mod legacy;
pub mod protocol;
mod protocol_adapter;
pub mod protocol_result;

pub fn run(arguments: impl Iterator<Item = std::ffi::OsString>) -> u8 {
    let arguments: Vec<_> = arguments.collect();
    if arguments.first().and_then(|value| value.to_str()) == Some("protocol") {
        protocol_adapter::run()
    } else {
        legacy::run(arguments)
    }
}
pub use protocol_result::{ResultFrame, SavedAssetInspection};

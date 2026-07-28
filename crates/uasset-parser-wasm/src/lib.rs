//! WebAssembly adapter for the portable UAsset parser.

use wasm_bindgen::prelude::*;

// Keep the versioned inspection projection shared with the native executable. The module contains
// native host adapters too, but the linker removes those unreachable functions from the WASM
// artifact. Moving the projection into a dedicated library module can follow without changing this
// public binding.
#[allow(dead_code)]
#[path = "../../uasset-parser/src/bin/uasset.rs"]
mod native_inspection;

/// Parses bounded package bytes and returns the native schema-versioned inspection JSON.
#[wasm_bindgen]
pub fn inspect(path: &str, bytes: &[u8]) -> String {
    native_inspection::inspect_bytes_json(path, bytes)
}

/// Returns the parser/binding package version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

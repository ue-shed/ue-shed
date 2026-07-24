# `uasset-parser`

The portable saved-package parser for UE Shed. It provides the `uasset` Rust library and the native
CLI used by `@ue-shed/unreal-assets` for editor-free `inspect` and `authoring` operations.

The parser remains behind a versioned JSON process boundary. TypeScript packages consume that
contract rather than Rust implementation details, and the crate has no Workbench dependency. The
library is also required to compile for `wasm32-unknown-unknown`; package bytes, not filesystem or
process authority, are its reusable input boundary.

This code was extracted from the pre-publication `ue-parser` development repository after UAsset
and UTrace grew into separate products. UTrace parsing and dashboards are intentionally not part of
this crate. The extracted parser code retains its MIT license.

Build the CLI from the repository root:

```text
cargo build --release -p uasset-parser
```

The executable is written to `target/release/uasset` (`uasset.exe` on Windows).

Verify the portable library target with:

```text
rustup target add wasm32-unknown-unknown
cargo check --locked -p uasset-parser --lib --target wasm32-unknown-unknown
```

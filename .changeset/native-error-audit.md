---
"@ue-shed/uasset": patch
"@ue-shed/protocol": minor
---

Native error audit, part one (Rust).

**Decode errors now say where they happened.** A saved-package decode error (`SavedAssetDecodeError` in the uasset-io v1 contract, and `decode_errors` in generic inspection JSON) can carry `field`, the logical field being read (such as `Exports[3].Properties.Name`), and `offset`, the absolute byte offset. `AssetError` exposes both as `field()` and `offset()`.

**Corrected kind.** A metadata failure caused by an unsupported format or version used to be reported as `unsupported_capability`. It now keeps its own kind.

**No panics on malformed packages.** The Rust crates enable `clippy::unwrap_used` and `clippy::expect_used`:

- Every non-test `unwrap`/`expect` in the parser, inspection, source generator, IO and process supervisor crates is now either a typed error or an invariant stated once:
    - checked integer conversions go through `uasset-parser`'s `convert` helpers
    - poisoned locks recover their data
    - a lost projection worker is a retryable `unavailable` failure
    - a missing generated-layout field is `unsupported_capability`
- The few remaining invariants keep an `#[expect]` with a reason.
- A new regression test applies 328 deterministic truncations, bit flips and extreme-count overwrites to each fixture package under 400 KiB, then runs the parser, export decoders and projections. A malformed package must give a typed error, never a crash.

The `uasset-inspection-wasm` crate is outside the Cargo workspace and was not changed.

Protocol 1.14 negotiates the new decode-error context. New workers omit both fields on earlier
protocol minors, preserving strict older decoders. Public inspection and full-scan readers request
minor 14 and accept workers that omit the optional fields. Header scans retain their existing
minor negotiation. Generic inspection JSON also retains the optional context.

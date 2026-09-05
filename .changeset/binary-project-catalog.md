---
"@ue-shed/uasset-win32-x64": patch
---

Use immutable binary Project Index snapshots to improve fresh scans, indexed queries, and cache size.
Add writer exclusion and interruption recovery checks. Existing catalog caches rebuild on first use.
Native source builds now require Rust 1.89; SQLite is retained only for opt-in comparison tests.

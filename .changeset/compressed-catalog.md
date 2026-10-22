---
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
---

The Project Index Catalog is compressed. Snapshots move to `catalogs-v6` (`UESHC004`): the sections
readers decode whole are zstd frames, and posting lists and header records are independent 64 KiB
blocks, so queries still decode only what they read. A local UE 5.7 project's snapshot (about
11,000 packages) shrinks from 9.7 MB to 1.9 MB. Existing `catalogs-v5` caches are ignored and the
next refresh rebuilds the index.

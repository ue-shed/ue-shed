---
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
"@ue-shed/unreal-assets": patch
---

Project Index queries no longer decode the whole inventory before their first page. The snapshot's
row index now records a checksum for each 128-row chunk of the inventory and lists the map rows, so
a query decodes only the chunks its cursor and its matches fall in: on a project of about 800,000
packages the first inventory or map page drops from about 120 ms to under 10 ms, and the first
class or name page from about 160 ms to 30–45 ms, with a fraction of the memory. A refresh keeps
each directory's path once instead of every file's whole path, which takes about 50 MB off an
unchanged refresh of the same project. One-shot native workers and the Project Index refresh
worker start with the allocator returning freed memory at once (`MIMALLOC_PURGE_DELAY=0`) unless the
environment already sets it, which lowers a full build's peak memory by about a third. The cache
moves to `catalogs-v10`; the first refresh rebuilds it.

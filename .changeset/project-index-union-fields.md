---
"@ue-shed/protocol": minor
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/unreal-assets": minor
---

Project Index queries can ask for less. uasset-io v1.27 adds a `union` query that pages the
packages any of up to 16 header filters matches, each once, in path order, and lets header queries
name the `fields` their items carry (`classes`, `serializedNames`, `matchedSerializedNames`,
`headerData`). `@ue-shed/unreal-assets` adds `ProjectIndexQuery.cases.Union` and an optional
`fields` on header queries; a field a query leaves out is empty in its items. On a worker older
than v1.27 a header query with `fields` reads every field and the adapter leaves out the rest; a
union fails as `ProjectIndexIncompatibleWorker`. Header items in v1.27 pages may omit `classes` and
`serializedNames`.

Every query page also decodes faster: the host validates a dictionary page frame in one walk and
expands it in one pass instead of two schema walks, and the worker decodes a page's record blocks
on several threads. On a project of about 800,000 packages a five-filter sweep drops from about
410 ms to 210 ms with the same frames; as one union with only classes and matched names it takes
about 170 ms, sends 6.8 MB instead of 17.1 MB and holds about 90 MiB less Node memory.

---
"@ue-shed/game-text": minor
"@ue-shed/uasset": patch
"@ue-shed/uasset-win32-x64": patch
---

A saved Game Text index can be reopened without rescanning.

- `GameTextIndexSteps.openCommitted({ projectRoot, targetName? })` opens an already committed view
  and returns `None` when there is none to use, without reading packages or rebuilding.
- The workspace's `configuredRefresh(false)` uses it to show a saved index at once. Its completed
  result then carries `cached: true` (optional on `TextCorpusQueryRunResult`). The cached view can be
  browsed and searched, but quality rules, operation targets and investigation exports wait until a
  refresh has checked it against the current Project Index. A refresh replaces it.
- The native engine reports the ID index's load and build seconds separately in `stage_seconds`
  (`id_index_raw_*`, `id_index_line_*` and `id_index_unit_lines_*`).

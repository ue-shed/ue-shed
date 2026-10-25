---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
"@ue-shed/unreal-assets": minor
---

Quality, source quality and `loc check` read their findings from the engine. It checks a rule
document once, and each page, focus, export and proposal is a `findings_query`. A review's
accepted findings are registered once with `findings_accept`. Nothing scans on the host thread,
so the Quality worker is gone and the `qualityWorker` option has no effect.

- `localizationQuality` returns `QueriedLocalizationQuality`, a `workspace` of the Quality
  reads. `localizationQualityWorkspaceOf(source, quality)` returns that workspace. The in-memory
  `localizationQuality(report, join)` returns the same shape and still lists a given source
  report's findings.
- `indexedLocalizationStatusReport(query, evidence, page)` is an Effect that reads the index's
  report header.
- Removed: `indexedLocalizationQuality`, `indexedSourceQuality`, `LocalizationFindingList`,
  `LocalizationFindingGroup`, `LocalizationQuality` and `LocalizationQualityMetadata`.
  `NativeFindings` loses `findingsLines` and `findingsUnits`, and the engine loses the `rows`,
  `findings_lines` and `findings_units` actions.

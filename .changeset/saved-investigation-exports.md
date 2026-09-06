---
"@ue-shed/game-text": minor
"@ue-shed/unreal-assets": minor
---

Add versioned Game Text investigation presets and complete filtered JSON/CSV exports, retaining
text identities, all occurrences, quality rules, coverage, and project provenance. Query models
can export full matching results independently of paginated UI results.

Expose browser-safe investigation metadata and CSV helpers, plus a separate Node file adapter
with bounded preset reads and atomic output writes. Workbench and the CLI use these APIs for
saved investigations and replay against an explicitly selected project.

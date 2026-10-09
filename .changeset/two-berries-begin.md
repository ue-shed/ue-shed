---
"@ue-shed/game-text": minor
"@ue-shed/unreal-assets": patch
---

Aggregate saved-text gaps by package without losing reader reasons, retain at most three samples,
and count all undecoded properties. Add optional `coverageGapCounts` to corpus diagnostics while
keeping corpus schema version 1. Bound report diagnostics and incomplete package lists to 200,
with full totals and omitted counts in status, progress, quality and investigation output.

Expose a browser-safe text coverage gap schema from Unreal Assets for corpus consumers.

---
"@ue-shed/game-text": patch
"@ue-shed/localization": patch
"@ue-shed/protocol": patch
---

Game Text reviews and change checks no longer slow down or miss results on large targets:

- Comparing a change lists the findings that fail it first across every page, not only within one
  page, so a failure is never left behind a page of warnings. The engine's `compare_points` request
  takes the failing checks as `failOn`; `readGameTextChangePoints` passes them through.
- Fixing an ID reads every place of a unit, a page at a time, so a reviewed place beyond the unit's
  first 500 is found rather than reported as no longer in the scan. A unit that changes between
  pages is still refused.
- A related unit may list as many places as its request asks for, up to 500, instead of failing to
  decode beyond 50.
- Setting review flags or accepting findings, and reviewing staged edits, read each line's source,
  shipped translation and review fingerprint from the index in one engine request per culture
  (`review_lines`, new in the engine contract, exposed as `NativeTextQuery.reviewLines`), instead of
  decoding the target's manifest, archive and PO files in the host for every line.
  `reviewLocalizationChangeSet` takes such lines in place of parsed files.
- A fingerprint from parsed files (`localizationEvidenceFingerprint`) and a staged edit's review
  from parsed files now choose the shipped translation as the index's join does when a line has
  duplicate archive or PO entries or its archive is unreadable (`shippedEvidenceTranslation`), so
  a review they stamp is current to the join.

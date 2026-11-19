---
"@ue-shed/protocol": minor
"@ue-shed/uasset": minor
"@ue-shed/uasset-win32-x64": minor
"@ue-shed/unreal-assets": minor
"@ue-shed/game-text": minor
"@ue-shed/map-history": minor
---

Big maps and projects no longer lose data without saying so.

- Game Text groups past the first 200 can be listed. A search request's new `groupOffset` asks for
  the next page of up to 200 groups, and the answer's `groups.offset` says which page it is, with
  `more` counting the groups after it. Requests without it list the first 200 as before.
- A Project Index refresh that sees more than 65,536 changed paths still reports
  `complete: false` with empty lists, and now says how many changes there were in `total`. A host
  that needs the paths after a branch switch or mass resave can raise the limit with the refresh
  target's `maximumChanges` (up to 1,048,576; uasset-io v1.25). A summary that kept only the first
  64 diagnostics now counts the rest in `omittedDiagnostics`.
- Map History no longer misses old moves and renames silently. When Perforce's filelog fills the
  revision window for a file of the map's lineage, the history carries a
  `map_lineage_may_be_incomplete` diagnostic, and the new `limits.maxFilelogRevisions` widens the
  window (default `maxChangelists + maxDirectMapMoves + 2`, as before). The direct-move limit is
  now `limits.maxDirectMapMoves` (default 16), and hitting it says to raise that limit instead of
  suggesting a shorter range, which never helped.

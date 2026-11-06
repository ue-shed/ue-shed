---
"@ue-shed/game-text": minor
"@ue-shed/protocol": minor
---

`related` can answer a line's similar keys, ranked by the engine, so hosts no longer page every
`not_found` and `not_gathered` line through search and run their own edit-distance matcher:

- Ask with `similarKeys: { limit }` on `RelatedLinesRequest` (with a target). The answer's
  `similarKeys` names the selected line's side (`not_found` for a key that left the manifest,
  `not_gathered` for a new key), its one-to-one `pair` (the other line's ID, namespace, key, source
  and state, the edit `distance`, whether it was found `same_package` or `cross_package`, and the
  earlier line's translations), up to `limit` near lines as `candidates` ranked by distance, then
  same-package first, then line ID, the target's pair count, whether the comparison budget
  `truncated` the matcher, and the milliseconds the request spent building the index.
- It is a fourth key-change tier after the join's exact ones and leaves them alone: lines the
  join already paired, blank text and trivial text are not compared, and the join's
  `key_changed` marks and counts do not change.
- The matcher's policy is the host's: `distanceRatio` (0.2), `reachRatio` (0.25), `maxDistance`
  (12), `comparisonBudget` (2,000,000) and `minLetters` (2) are optional request fields. A reader
  builds the index for the whole target on the first request and keeps one parameter set.
- The engine contract adds `RelatedSection.similarKeys` (`SimilarKeysSection`) and the typed
  answer `SimilarKeysAnswer` with `SimilarKeyPair`, `SimilarKeyCandidate`, `SimilarKeyLine`,
  `SimilarKeyTranslation`, `SimilarKeyState` and `SimilarKeyScope`. `RelatedLines.similarKeys`
  is the generated type; `SimilarKeysRequest` and `SimilarKeys` are exported.
- `NativeTextQuery.related` annotates its span with the pair count, candidates, whether the line
  is paired, truncation and build time.

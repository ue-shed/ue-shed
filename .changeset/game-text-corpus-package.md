---
"@ue-shed/game-text-corpus": minor
---

New package: `compareGameTextCorpus` checks a host's Game Text index against a generated corpus's
planted answers. It runs on the host's `GameTextIndexRefresh`, or on UE Shed's own from
`gameTextCorpusIndexLayer`, and returns every disagreement with its triage against the known
defects. The package also exports the corpus plan's decoder, the answer format and the
localization files a plan writes.

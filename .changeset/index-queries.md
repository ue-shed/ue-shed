---
"@ue-shed/game-text": minor
"@ue-shed/uasset": minor
---

The native Game Text index answers more questions directly, so hosts stop exporting the corpus to
derive facts. A `source` filter clause selects up to 50 exact source texts (case, whitespace and
lone surrogates count; a unit with conflicting sources matches any of them), resolved once per
request to dictionary IDs. `finding` clauses accept every stored review signal, adding
`conflicting`, `evidence_only` and `compiled_copy_differs`. `group: "source"` groups lines by exact
source text, and `minGroupSize` lists only groups of at least that many lines, so `finding is
duplicate_source` with `group: "source"` and `minGroupSize: 2` lists the texts under several keys in
one query. Group keys and `openGroup` now hold up to 32,767 UTF-16 code units. Opening a reader
indexes line and unit IDs (`id_index_prepare`), so focus, cursors, `lines` selections and line
details no longer scan every ID: a 5,000-line selection over 200,000 lines takes 24 ms instead of
1.4 s. Bulk reads (corpus, exports, localization dumps) of a model opened through
`GameTextIndexQuery` run in a second native process, so a dump no longer holds searches and focus
behind it; `openNativeTextQuery` opts in with `bulkEngine`. Native search, the columnar and
in-memory references, and the differential fuzz agree on every new request.

The index is now queried like a library index. `aggregate` groups every matching row by one to four
dimensions (culture, the culture-mark state, fact, unknown reason, review lens, review status and
review flag, and translation key, source, namespace, audience, origin, problem, finding, asset and
gathered) and returns each group's lines, whitespace source words and `lineBreakWords`, Unreal's
word count of the gathered text, from a Rust port of the `linebreak` package that matched it on
over a million test strings. `selectLocalizationLines(request, fields)` reads only the named line
fields, adding `marks`, `problems`, `signals` and `places`; `readCorpusHeader()` reads coverage and
diagnostics without units; `readUnits(ids)` reads named units; and `corpusFingerprint()` hashes the
corpus in Rust to the value `createLocalizationBaseline` records. Models carry a `revision` that
changes when the model does. The progress report and baseline (`indexedLocalizationProgressReport`,
`indexedLocalizationBaseline`), the changed-file gate (`indexedLocalizationGateTarget`), the lines
spreadsheet, the gather key pairing and investigations use these reads, so the Workbench and the
CLI no longer export the corpus or the join to answer them. The whole-input functions remain.

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

`makeGameTextWorkspaceLocalization` now takes the current model's `revision` as its first argument
instead of the corpus read: pass `() => Effect.succeed(model.revision)` where you passed the lazy
corpus.

The localization quality worker sends its spans' and stages' timings back with its findings, and the
host adds them to its `GameTextIndex.qualityWorker.scan` span, so a host's trace shows where a
worker scan spends its time.

Localization quality scans and progress reports over large targets are faster, with the same
findings and reports. Measured on a generated target of 200,000 lines in 14 cultures with archives
and PO files: a quality scan takes 55 s instead of 104 s. Hydrating its lines takes 15 s instead of
36 s: a shared-string reader keeps strings it decoded by ID (a line's key, source and translations
recur in the manifest and every archive and PO file), and reading manifest, archive and PO entries
decodes only the columns of their format. Checking takes 25 s instead of 50 s, and preparing
2 s instead of 5 s: duplicate-source places come from the occurrence location columns instead of
whole occurrences, and column lookups, shipped translations, rule IDs and format modifiers no
longer rebuild keys or validate values the index already typed. `indexedLocalizationProgressReport`
read the manifest once and every archive twice from the index on each call, 44 s of JavaScript per
call on that target. It now reads them once per evidence object, while the native reads run, keeps
only the totals it needs, and further pages, the CSV and baseline comparisons (per baseline) reuse
them: 16 s for the first report, then about a millisecond. Spans
`GameText.localizationReport.manifest`, `.words`, `.archive` and `.assemble` show its phases.

Index refresh progress names each step it reports. `localization_publish`, `package_text` and
`package_publish` replace the `joining` events reported while publishing localization text,
preparing the package text layer and publishing it, and `joining` now means only the join of source
text with translations. `package_text` counts packages prepared of the packages in the inventory,
so a cold refresh shows a count for the 37 s it spent preparing 15,445 packages instead of none.

A progress report no longer holds the host's event loop. On an index model each read of an
evidence file decoded every entry synchronously and checked it against its schema again, about
0.8 s per archive of a 132,000-line target; the report now reads the manifest and archives page by
page, yielding between pages, and the importer's validation is not repeated. Its longest stall on
a generated 132,000-line target went from 1.3 s to 0.13 s and the report from 3.7 s to 2.0 s.
`readCorpusReportHeader()` returns what a report shows of the corpus header (coverage, every
diagnostic and package count, and the first 200 diagnostics and incomplete packages), computed in
Rust. The whole header of a project of 166,699 packages is 67 MB and took 7 s, 3 s of it decoding
JSON on the host; the report header takes 2.3 s in the native process the first time and 94 ms
after, as the native reader now reads package lists once and decodes package paths in dictionary
order. The cold package text import records its packages, shards, workers, worker busy time,
slowest shard and publish time on its span.

`TextCorpusReportHeader` and `textCorpusReportHeader` are exported for hosts that implement the
query contract. Aggregates no longer allocate per row: keys are fixed arrays and culture marks
refill their slots, so the progress report's five aggregates over a real 14-culture target take
2.5 s instead of 4.4 s (0.7 s instead of 2.1 s after the first one counts its words).

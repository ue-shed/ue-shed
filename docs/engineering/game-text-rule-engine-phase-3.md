# Game Text rule engine: Phase 3 specification

This is the Phase 3 specification for [Plan 059](../../plans/059-game-text-query-and-rule-engine.md). It builds on the [Phase 1](game-text-rule-engine.md) and [Phase 2](game-text-rule-engine-phase-2.md) specifications, whose subjects, rules, findings layer, identity and rules file still hold. It decides the API, the formats and the module boundaries.

Behaviour is defined by today's code, cited as `file:line` under `packages/game-text/src/` (`gt/`), `crates/game-text-index/src/` (`ix/`) and `extensions/game-text/src/` (`ext/`). The [fixture](game-text-corpus.md) is the oracle. Line numbers drift; re-check a citation before implementing it.

## 1. Scope

| Part                   | What changes                                                                                                                                      | §   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Fact repairs           | "No translator notes" counts manifest notes (decision 5). The line page keeps the list's culture scope (decision 6).                              | 2   |
| Row sets               | Every Browse predicate is a cached row set. Facets, counts, problem tallies and groups read sets; nothing re-matches.                             | 3   |
| Response parts, groups | A request names the parts it wants. Groups come back with their first rows.                                                                       | 3   |
| Text                   | A trigram index over folded sources and translations.                                                                                             | 4   |
| Findings queries       | The engine filters, orders, pages and counts findings, and applies review acceptance. Quality, `loc check` and the status report read through it. | 5   |
| Findings in Browse     | Findings are filter, facet, group and problem fields. The native `shared`, `long` and `duplicate_source` signals are deleted (decision 16).       | 6   |
| Related lines          | One request returns a line's related lines with their places and translations.                                                                    | 7   |
| Complete rules         | A rules file entry can be a whole rule written in the IR (decision 19).                                                                           | 8   |
| Deletions              | The Quality worker, the second TS reader, the TS scans, the per-facet re-match and the serialized response cache (decision 17).                   | 10  |

**Not in Phase 3:** IR requests, column batches, streaming, cancellation, concurrency and engine-side export sinks (Phase 4). Requests keep today's typed JSON; the row sets are what Phase 4's IR filters compile to. Incremental findings (Phase 5): until then a new joined layer re-evaluates every rule.

## 2. Fact repairs

### Translator notes (decision 5, `manifest-notes-only`)

- **Today:** a line with saved places gets `line.notes` from its occurrences' dev notes only (`ix/join.rs:911-913`). Manifest notes and `Info.Comment` count only for manifest-only lines (`:1049-1063`). Slice and raw rows read occurrences only (`ix/join_query.rs:124-126, :161`).
- **Fix:** a line's notes are present when any occurrence has a dev note, or any of its manifest entries has notes as `localizationManifestNotes` reads them: the notes `missing_translator_notes` reads (the `manifestNotes` field, `gt/rules/catalogue.ts`). A slice's notes are its occurrences' dev notes or its line's manifest notes. A raw row in corpus mode has no manifest and keeps dev notes only.
- **Readers that change with it:** the `withoutNotes` eligibility (`ix/engine_match.rs:897, :1070`), the `notes` clause (`:773-786`), the chip count (`ix/engine_search.rs:73, :107`) and the summary totals (`ix/summary_state.rs:95`).

### The line page's culture scope (decision 6, `archive-missing-entry`)

- **Today:** `localization_detail` returns every culture (`ix/engine_detail.rs:91-98`), and the renderer computes the line's problems from all of them in TS (`ext/game-text-line-page.tsx:23-32`). The list computes the row with its scope (`ix/engine_search.rs:465`).
- **Fix:** `LocalizationDetailRequest` and the public `LocalizationFocusRequest` gain `cultures` (the list's scope; omitted means every culture), and the reply gains `problems`: the line's problems computed natively with that scope and the request's findings (§6), exactly as the list row computes them. The line page shows `problems` and stops calling `textProblems`. Translations outside the scope are still listed; only problems are scoped.

## 3. The query core

### Row sets

- A **row set** is a bitset over a listing relation's row IDs: `line` rows when a localization target is selected, `raw` rows in corpus mode. At 583,507 lines a set is 72 KiB.
- A search request decomposes into **atoms**, each evaluated over every row of the relation into one set:

| Atom                            | From                                                                                            | Depends on                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `visible`                       | `source_visible` for lines; every raw row                                                       | The joined layer.                                                                                             |
| `text`                          | `query`, `searchTranslations` (§4)                                                              | The culture scope, when it searches translations.                                                             |
| `picked`                        | `lines`                                                                                         |                                                                                                               |
| `eligible`                      | `capability`, `withoutNotes`, `where`, with today's slice rule (`ix/engine_match.rs:1044-1074`) |                                                                                                               |
| `review`, `keyChanged`, `state` | The localization scope (`:1075-1108`).                                                          | The culture scope.                                                                                            |
| One per `filter` clause         | The clause.                                                                                     | The culture scope for `problem`, `translation` and `finding`; the findings layer for `finding` and `problem`. |

- The match is the AND of the atoms. An atom's set is cached by its canonical JSON, the culture scope it depends on and the keys of the layers it reads, so a keystroke re-evaluates only `text`. The cache is bounded by bytes (64 MiB) and evicts the least recently used. It replaces `matched` (`ix/engine_match.rs:934-950`).
- Paging walks the display order (`order` or `raw.order`) and tests membership. Keyset cursors are unchanged (`ix/engine_page.rs`).

### Facets, counts and problems in one pass

- A facet over field F counts the AND of every atom except F's clauses, as `without_filter` selects today (`ix/engine_types.rs:430-441`). Each facet walks its set once. The chip counts (`search_counts`), problem counts, culture facets, localization state and review counts, and group aggregates come from the same sets.
- A row's problems are computed once per (culture scope, findings layer) into a `u32` column, cached like an atom. The `problem` clause and every problem tally read it.
- **Deleted:** the per-facet and per-count re-match (`ix/engine_search.rs:337-414`), the serialized JSON `QueryCache` (`ix/query_cache.rs`), and `counted` on derived requests (`ix/engine_types.rs:175-179, :454-468`).

### Response parts and groups

- `SearchRequest` gains `parts`: any of `rows`, `counts`, `facets` and `groups`. Omitted means all of them, today's answer. A part not asked for is not computed.
- `group` gains `firstRows` (1–50). Each group entry then carries its first `firstRows` rows in display order, with a cursor when there are more. One walk of the display order fills every group. `openGroup` with a cursor stays for "more".
- The renderer asks for its open groups' rows in the header request, instead of one search per open group (`ext/game-text-grouped-results.tsx:150-190`).

### Parity

Until §6 changes the finding fields, every answer is byte-identical to today's. The native query tests, the TS reference comparisons, the fixture and the benchmark's visible-page hashes (`a2c3e70e…` on 1×, `6b19c93a…` on the released project) must not change.

## 4. Text search: the trigram index

- **Arenas.** `query.source.{ids,starts,folded}` exists today (`ix/join_query.rs:333-349`). Add `query.translation.{ids,starts,folded}`: every distinct archive translation and PO `msgstr` of every culture, folded as sources are (Rust `to_lowercase`, WTF-8 bytes).
- **Index.** For each arena, `*.trigrams.{keys,offsets,postings}`: the sorted distinct byte trigrams of the folded strings and, for each, the arena positions that contain it, as delta-encoded varints. They are written when the joined layer is published, next to the arenas.
- **Query.** A folded term of three or more bytes with no lone surrogate takes the intersection of its trigrams' postings, smallest first, and confirms each candidate with `memmem`. A shorter term, or one with a lone surrogate (`ix/engine_text.rs:100-138`), scans the arena as today. A single CJK character is three bytes, so it uses the index.
- **Strings added by an overlay** (`additions`, `ix/engine_text.rs:49-68`) are scanned, as today.
- **Semantics are unchanged.**
    - Each term gives the set of dictionary strings that contain it. A source matches when it is in every term's set.
    - With `searchTranslations`, a line matches when each term is in the set of its source, of an in-scope culture's archive translation, or of that culture's PO text when it is `not_synced`.
    - That is today's joined-string test (`ix/engine_match.rs:1109-1121`): terms never contain the space that joins the strings, and lowercasing the joined string equals lowercasing each part. A test pins this, Greek final sigma included.
    - In corpus mode, a unit with several sources matches when each term is in one of them (`:1022-1027`).
- **Recorded, not targeted:** build time and store size on both projects.

## 5. Findings queries

### Findings layer, version 2

The layer keeps Phase 1's columns (`ix/rules/findings.rs`) and adds, per finding, in one numbering across rules:

| Column         | Contents                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `f.rule`       | The rule index.                                                                                                                                                                                                                |
| `f.line`       | The line row, for `line` and `line_culture` findings.                                                                                                                                                                          |
| `f.unit`       | The raw unit row, for `unit_source` findings.                                                                                                                                                                                  |
| `f.culture`    | The culture index.                                                                                                                                                                                                             |
| `f.flags`      | `fixable`: it has a fix that `eligibleLocalizationChange` accepts (`gt/localization-quality-index.ts:318-329`). `shadowed`: below. `keyless`: its identity is null, so it can't be accepted (`gt/localization-review.ts:160`). |
| `order.report` | Line findings in report order, below.                                                                                                                                                                                          |
| `order.source` | `unit_source` findings in today's source report order: units in `raw.order`, then rule by rule (`gt/source-quality-index.ts:215-257`).                                                                                         |

**Report order** is today's, computed once when the layer is built:

1. Lines by line ID with the host collator, ties in join order (`gt/localization-quality-index.ts:198-233`).
2. Within a block of lines whose IDs compare equal: built-ins ordered by `compareLocalizationFindings`, then policy findings by rule order, then custom findings by the document's order, each stable. Then the block is stable-sorted by `compareReportedLocalizationFindings` (`gt/localization-checks.ts:45-69`, `gt/localization-quality-index.ts:263-294`). Comparisons use the host collator, and `JSON.stringify(actual)` is the stored evidence's `actual` in emission order.

**`shadowed`** is a new optional v4 rule field, a bool expression per finding. A shadowed finding is hidden when the program has an enabled `unit_source` rule. The catalogue's `placeholder_text` sets it to "`unreportedMatches` is present and empty": today's `reportedBySource` (`gt/localization-workspace.ts:816-823, :964`).

The layer's evaluator version rises, so every existing layer rebuilds once.

### Review acceptance in the join

The join already receives the whole review file (`gt/index-steps.ts:685-686`) and computes record fingerprints (`ix/join_marks.rs:326-360`). It adds `review.accepted.{rows,cultures,rules}`: each accepted finding whose line resolves by (namespace, key) and whose fingerprint equals that line's and culture's `localizationLineFingerprint`, computed as the records' fingerprints are.

A finding is **accepted** when it isn't `keyless` and its (line row, culture, `ruleId`) is in that table. This is `lazyAcceptedFindingFilter` (`gt/localization-review.ts:151-178`), including keeping a finding whose line or culture is missing. Accepted findings are hidden from every query, Browse included (§6).

### `findings_query`

```jsonc
{
	"key": "…", // the findings layer
	"culture": "de", // optional: one culture, as Quality's selection
	"rules": ["…"], // optional: program rule IDs
	"severities": ["low"], // optional
	"fixable": true, // optional
	"line": "…", // optional: one line's findings, for the line page
	"id": "localization-finding:…", // optional: one finding, for focus
	"order": "severity", // or "report"
	"offset": 0,
	"limit": 50, // 0–5,000
	"counts": true // optional
}
```

- **Selection.** A finding is selected when:
    - its culture is the requested one (a `unit_source` finding has none and is always selected);
    - its rule and severity are listed, and it is `fixable` if asked;
    - it isn't accepted, and isn't hidden as `shadowed`.

    This is today's culture filter (`gt/localization-quality-index.ts:270-271`) and workspace hiding (`gt/localization-workspace.ts:964-988`).

- **Order.**
    - `report`: `order.report`, the `loc check` order.
    - `severity`: blocking, normal, then low. Within each, `unit_source` findings come first in `order.source`, then line findings in `order.report` (`gt/localization-workspace.ts:1012-1024`).
- **Rows** are findings in today's host shapes, composed as `findings_lines` and `findings_units` compose them (`ix/rules/findings_read.rs`), each with its `id`, program rule ID, severity and line ID.
    - A row also carries what the list summary reads from the line: `manifestSource` and the first manifest path (`gt/localization-workspace.ts:573-616`). TS never reads the line.
    - Places are interned as today, with the 16 MiB spill.
- **Counts:** `total`, by rule, by severity, `fixable`, `accepted` (findings hidden as accepted) and `limits` (diagnostics in the selection by code, in first-seen order, `gt/localization-quality-index.ts:331-341`).
- The reply carries a `profile` of its stages.

Workspace filters map to rule IDs in TS, from the evaluation's rule list:

- a check to its rule;
- `character_budget` and `terminology` to every rule of that source or localization kind;
- `custom.<id>` to that rule.

Counts by filter sum the counts by rule.

## 6. Findings in Browse

- **The layer.**
    - `SearchRequest` gains `findings`: a findings layer key.
    - The workspace evaluates the active rules when a target is selected, a rules file exists and the joined layer is ready. They are the project's file plus the host overlay, as Quality reads them. It passes the key once the layer is ready.
    - The page reports `findings: {status, rules}`. `status` is `none` (no rules file or no target), `pending` (evaluating) or `ready`. `rules` lists each rule's ID, label and count in the current match.
- **Rows.** A finding belongs to a listed row when it isn't accepted, it isn't hidden as `shadowed`, and:
    - for a `line` or `line_culture` finding, it is on that line and its culture is in the request's culture scope. Without a culture scope, every culture is.
    - for a `unit_source` finding, the line holds one of its affected occurrences.
    - in corpus mode, a line finding belongs to the raw units of the line's slices, and a `unit_source` finding to its unit.
- **`finding` clauses** name rule IDs: a built-in check's name, or a project rule's or complete rule's `id`. A clause naming a rule not in the layer is invalid. Without a layer, `finding is` matches nothing. The engine keeps each rule's rows per culture scope used, in the atom cache.
- **The `finding` problem** is raised by a finding of a rule whose `counts` is true (the default). Rules with `counts: false` are still filter and facet values.
- **Facts** keep their native signals: `unresolved`, `conflicting`, `evidence_only` and `compiled_copy_differs`. They move to a new `fact` field. `unresolved` no longer raises `finding`; `conflicting` still raises `conflicting_source`.
- **Rows carry their findings.** Search previews and focus gain `findings`: the IDs of rules with a finding on the row in scope, at most 32. They replace the deleted signals in the row's suffix (`ext/game-text-result-rows.tsx:186`) and the line page's findings list (`ext/game-text-line-page.tsx:232-235`).
- **Deleted:**
    - the `shared`, `duplicate_source` and `long` signals (`ix/engine_types.rs:44-52`, `ix/join_query.rs:110-148, :199-211`, `ix/package_evidence.rs:82-122`, `ix/join_incremental_sources.rs:186-327`, `ix/summary_state.rs:17-27, :82-102`);
    - the request's `lens`, `counted_findings` and `TEXT_FINDING_SIGNALS`;
    - the persisted `line.problems` column (`ix/join.rs:900-941, :1263`, `ix/join_marks.rs:362-373`, `ix/join_incremental.rs:583, :707`), since problems are computed at query time.

    `TextReviewSignal` keeps the four facts.

- **The corpus CSV** keeps its "Review signals" column for the facts. It adds "Findings", the labels of the unit's rules, when the layer is ready (`gt/csv.ts:98-123`, `ix/engine_export.rs:226-227`).
- **The UI parts** are built after the owner approves mockups: the Finding and Fact menus, row suffixes, the line page's findings and the pending state.

## 7. Related lines

`related {target?, selection: {kind: "line" | "unit", id}, pageSize}` returns four sections, each with at most 50 members and a `complete` flag:

| Section     | Members                                                                                       | Today                                                                           |
| ----------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sameKey`   | Other units with the same gathered identity.                                                  | A `translation_key` search (`scripts/game-text-engine-stage.ts:510-531`)        |
| `sameText`  | Other resolved units with another identity whose consistent source equals this one's exactly. | The ID repair's text search and filter (`ext/game-text-id-repairs.tsx:264-280`) |
| `conflict`  | For a line with `conflicting_source`, its units whose source differs from the gathered one.   | Cause pages (`scripts/game-text-engine-stage.ts:476-494`)                       |
| `keyChange` | The line paired with this one by key-change pairing.                                          | The detail's `keyChange`                                                        |

A member is:

- the unit's search result;
- its first `pageSize` places, with `complete`;
- with a target, its translations per culture as `localization_detail` gives them.

The ID repair (`ext/game-text-id-repairs.tsx:251-321`) makes one `related` request in place of a search plus a focus and a detail per unit. It keeps its messages for incomplete sections. Its "same text" check reads `sameText` instead of the deleted `duplicate_source` signal (`:103`).

## 8. Complete rules in the file (decision 19)

A rules file entry with `kind: "rule"` is a whole rule in the v4 IR:

```jsonc
{
	"kind": "rule",
	"id": "ui.exclamation",
	"label": "Exclamation mark in UI text",
	"subject": "line_culture",
	"severity": "low",
	"scope": { "roles": ["ui"] },
	"params": { "mark": "!" },
	"when": { "contains": [{ "field": "latest" }, { "param": "mark" }] },
	"actual": { "object": { "translation": { "field": "latest" } } },
	"expectation": { "object": { "withoutMark": true } },
	"recovery": "Drop the exclamation mark."
}
```

- **Fields.**
    - Required: `id`, `label`, `subject` (`line` or `line_culture`), `when`, `actual`, `expectation` and `recovery`.
    - Optional: `severity` (default `normal`), `scope`, `params`, `let`, `each`, `eachAs`, `counts`, `shadowed` and `enabled`.
    - The engine's, not the file's: `fix`, `affected`, `extra`, `translationOrigin`, `ruleId`, `family` and `kind`.
    - Any other key is `invalid_structure`.
- **Findings** are custom findings with check `rule`.
    - `LocalizationCustomFinding` gains a `rule` variant whose `actual` and `expectation` are JSON objects.
    - Identity is the `localization-finding:` formula, with kind `custom`.
    - Quality lists them under `custom.<id>` with the rule's label, and the list's problem text is the label.
- **References.** A rule may read other rules with `finding(…)` by their IDs, built-ins included. The compiler rejects cycles.
- **Validation.** The TS decoder checks the entry's keys; expressions are checked when the engine loads the program. `invalid_expression` and `rule_cycle` are reported as `GameTextRuleDocumentError` with the rule's ID, and Quality shows its rules-file error.
- **The overlay** patches complete rules as it patches project rules.
- **The rule editor** lists complete rules and says to edit them in the file. The design goes to the owner first.

## 9. Host adoption

- **Quality.** `localizationQualityReads` keeps its public reads (`gt/localization-workspace.ts:897-1340`): search, export, focus and changes call `findings_query`.
    - Its page is one query with `counts`.
    - Focus reads the finding by `id`, and the line through `localization_detail` with the selection's culture. `ranges()` and the summary text stay in TS; they format one finding.
    - Changes page through `fixable` findings, with today's limits (100 changes, 1 MB).
    - Export pages by 5,000.
    - Source findings come from the same query, so `sourceQuality(...).export("all")` (`gt/workspace-localization.ts:535-537`) goes.
- **`loc check`** reads the report through `findings_query` in `report` order, by 5,000, with `counts` for the accepted count. `IndexedPolicyData` leaves `localization-check-report.ts`.
- **The status report** reads the joined layer's metadata through the reader, asynchronously (`gt/index-context.ts:27-42`). `readIndexedLocalizationEvidence` uses the reader directly (`:63-67`).
- **The Quality worker** is deleted once in-process Quality is measured on both projects with a largest event-loop gap no worse than the worker's at Phase 2: 115 ms on 1× and 528 ms on the released project.
- **Browse.** The workspace evaluates findings for Browse (§6). The renderer adopts response parts, groups with first rows and the finding fields.

## 10. Deleted

| What                                                                                                                                                              | Notes                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The TS scans: `indexedLocalizationQuality`, `indexedSourceQuality`, and `LocalizationFindingList` with its groups, positions and hash checks                      | `gt/localization-quality-index.ts`, `gt/source-quality-index.ts`. The presentation helpers they share with reports move to their callers.                                                                                                                            |
| The Quality worker: `quality-worker.ts`, `quality-worker-node.ts`, `quality-worker-protocol.ts`, `worker-calls.ts`                                                | With their build, test-script, lint-baseline and README references (`apps/workbench/tsup.config.ts:15`, `scripts/check-effect-architecture.ts`, `scripts/test-public-packages.ts:177-178`, `packages/game-text/ADOPTING.md:89`, `packages/game-text/README.md:112`). |
| The second TS reader: `indexed-policy-data.ts`, `joined-query-reader.ts`, `hydrateJoinedTarget` and what only it uses, and the `shared-string-file.ts` sync reads | `readJoinedTarget`, `openJoinedTarget` and the public `result.joined` handle stay: they pin and describe the layer.                                                                                                                                                  |
| The native `shared`, `duplicate_source` and `long` signals, `lens` and `line.problems`                                                                            | §6.                                                                                                                                                                                                                                                                  |
| The per-facet re-match, `QueryCache` and `matched`                                                                                                                | §3.                                                                                                                                                                                                                                                                  |
| `text-problems.ts` in the renderer, `duplicate-sources.ts`, `review-signals.test.ts`                                                                              | Public exports that Electroswag imports stay until Phase 6; check its imports first.                                                                                                                                                                                 |
| The TS reference oracles' signal and problem code (`query.test-support.ts`, `columnar-query.test-support.ts`)                                                     | The oracles themselves go in Phase 4 (proposed decision 26).                                                                                                                                                                                                         |

## 11. Spans and profiles

Every new heavy operation reports bounded stages:

- **Search:** atoms evaluated and reused; text (index or scan, candidates, confirmed); facets; problems; groups; page; encode. They are returned as `profile` beside `stage_seconds`, and the TS client annotates them as `game_text.query.*`.
- **`findings_query`:** select, order, page, compose and counts, as `game_text.findings.query.*`.
- **Layer build:** the order and flag columns join the `Recorder` stages of `findings_evaluate` (`ix/rules/stages.rs`). The trigram build joins the join's stages.

## 12. Fixture

- The `manifest-notes-filter` and `detail-culture-scope` pins are removed. Both cases must be exact.
- Browse's planted `finding` problems follow §6: they come from the rules in the fixture's rules file. `shared` and the `duplicate_source` signal no longer raise them, and neither does `unresolved`. The probe file that lists `shared` and `long` checks Browse's finding fields on the planted cases.
- **New cases:**
    - a complete rule on each subject, with a reference to a built-in;
    - text search: one-, two- and three-byte terms, one CJK character, a lone surrogate, Greek final sigma, and translation search over a `not_synced` PO;
    - related lines: same key, same text, a conflict and a key change;
    - an accepted finding that is current, and one whose translation changed.

## 13. Proposed decisions, for the owner with the mockups

22. **Browse's findings are the project's rules.** Without a rules file, Browse has no finding fields. "Used in several places", "Same text, different keys" and "Long text" appear only when the file lists those rules. `unresolved` and the other facts move to a "Fact" field and stop raising the `finding` problem.
23. **Browse waits for evaluation.** Finding fields are `pending` while the layer evaluates, about 21 s on the generated 1× project. That happens after every change until Phase 5 makes it incremental.
24. **Accepted findings are hidden in Browse too**, as in Quality.
25. **The corpus CSV gains a Findings column.** Its "Review signals" column keeps the four facts.
26. **The TS reference oracles go in Phase 4**, when every request changes shape. Phase 3 deletes their signal and problem code; they stay the reference for facts.
27. **Complete rules report as custom findings** with check `rule`, and can't propose fixes.

## 14. Order of work, one commit per step at least

1. **Fact repairs** (§2), with their pins removed.
2. **Row sets** (§3): atoms, the cache, facets and counts from sets, and problems as a cached column. Answers stay byte-identical. Delete the re-match, `QueryCache` and `matched`.
3. **Response parts and groups with first rows.** The renderer's grouped results adopt them.
4. **The trigram index** (§4), with identical answers and its build cost recorded.
5. **Findings layer v2, acceptance in the join, and `findings_query`** (§5). Quality, `loc check` and the status report adopt it.
    - Quality's answer keeps the Phase 1 hash on both projects, and `loc check` stays byte-identical on both canonical corpora.
    - Then delete the scans and the second reader, and the worker once its measurement allows.
6. **Related lines** (§7). The ID repair adopts them.
7. **Findings in Browse** (§6), and the UI parts once the owner approves their mockups.
8. **Complete rules** (§8), and the editor part after its mockup.
9. **Parity:** the fixture exact, one 10,000-line fuzz run, and `loc check` byte-identical. Then the Phase 0 measurement set against Phase 2, plus:
    - the index's build time and store size;
    - a related-lines row: one `related` request against the 444-request probe.

    Then the owner review.

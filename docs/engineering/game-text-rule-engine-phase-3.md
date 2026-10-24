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
- **Fix:** `LocalizationDetailRequest` and the public `LocalizationFocusRequest` gain the list's culture scope, `culture` or `cultures` as its selection names them (neither means every culture), and, with §6, `findings` (a findings layer key). The reply gains `problems`: the line's problems computed natively with that scope and layer, exactly as the list row computes them. The line page shows `problems` and stops calling `textProblems`. Translations outside the scope are still listed; only problems are scoped. Until §6 lands, the detail counts the default findings, so it matches a list request that names none; after §6 it matches every list request.
- **The probe** (`scripts/compare-game-text-corpus.ts:395-417`) recomputes problems from every translation, so removing the pin alone keeps the disagreement. It passes the case's culture and asserts the returned `problems`. It also asserts them once with no culture, against the all-cultures answer.

## 3. The query core

### Row sets

- A **row set** is a bitset over a listing relation's row IDs: `line` rows when a localization target is selected, `raw` rows in corpus mode. At 583,507 lines a set is 72 KiB.
- A search request decomposes into **atoms**, each evaluated over every row of the relation into one set:

| Atom                            | From                                                                                              | Depends on                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visible`                       | `source_visible` for lines; every raw row                                                         | The joined layer.                                                                                                                                         |
| `text`                          | `query`, and whether translation search is active (below)                                         | The culture scope, when translation search is active.                                                                                                     |
| `picked`                        | `lines`, in localization mode only. Corpus mode ignores `lines` (`ix/engine_match.rs:984-998`).   |                                                                                                                                                           |
| `eligible`                      | `capability`, `withoutNotes`, `lens` and `where` together, with today's slice rule (`:1044-1074`) |                                                                                                                                                           |
| `review`, `keyChanged`, `state` | The localization scope (`:1075-1108`).                                                            | The culture scope.                                                                                                                                        |
| One per `filter` clause         | The clause.                                                                                       | The culture scope for `problem`, `translation` and `finding`. The counted findings for `problem` (below). The findings layer for `finding` and `problem`. |

- **`eligible` is one atom**, not one per input: a line is eligible when one slice meets every condition at once (`ix/engine_match.rs:1044-1063`).
- **Atoms are normalized by mode** before they are keyed:
    - the relation (`line` or `raw`);
    - whether translation search is active: `searchTranslations` is true and the request names `culture` or `cultures` (`:980-983`). Naming every culture searches translations; naming none doesn't, though both resolve to the same scope (`ix/engine_query.rs:562-580`);
    - the effective culture scope;
    - in corpus mode, `picked` is every row.
- The match is the AND of the atoms. An atom's set is cached by its normalized form and the keys of the layers it reads, so a keystroke re-evaluates only `text`. The cache is bounded by bytes (64 MiB) and evicts the least recently used. It replaces `matched` (`ix/engine_match.rs:934-950`).
- Paging walks the display order (`order` or `raw.order`) and tests membership. Keyset cursors are unchanged (`ix/engine_page.rs`).

### Problems

- A row's problems are computed once per (culture scope, counted findings, findings layer) into a `u32` column, cached like an atom. The `problem` clause and every problem tally read it.
- **Counted findings stay a dependency until §6 replaces them.** Today a `finding is` clause or the `lens` adds signals that raise the `finding` problem (`ix/engine_types.rs:454-467`, `ix/text_problem.rs:97-105`), so the same scope can need different columns. A derived selection keeps the request's counted findings, as `without_filter` does (`ix/engine_types.rs:429-440`). §6 replaces the counted signals with the rules' `counts`, and then the column depends on the scope and the layer only.

### Facets and counts, without a re-match

Every aggregate is a set built from atoms. One traversal walks the union of their sets, and each row updates every aggregate whose set holds it, so facets, counts and tallies take one pass (plan: "facets in one pass"). Their selections are today's, listed so nothing is re-matched:

| Aggregate                                                  | Selection                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A field facet: folder, asset, asset type, origin, audience | Every atom except that field's clauses (`ix/engine_search.rs:381-412`).                                                                                                                                                         |
| Problem counts                                             | Every atom except the `problem` clauses, with the request's counted findings (`:337-363`).                                                                                                                                      |
| Corpus chip counts                                         | `capability`, `lens`, `withoutNotes` and `where.kinds` relaxed, then each counter reapplies its own condition (`:90-155`). Each counter's condition that reads slices is its own `eligible` atom, so the same-slice rule holds. |
| Localization origin counts                                 | `where.kinds` relaxed (`:77-87`), as its own `eligible` atom.                                                                                                                                                                   |
| Culture facets                                             | The request without `localization.cultures` (`:282-294`). Every atom that depends on the culture scope is rebuilt for that scope: `text` with translation search, `problem`, `translation`, `state`, `review` and `finding`.    |
| Localization state and review counts, group aggregates     | The match.                                                                                                                                                                                                                      |

**Deleted:** the per-facet and per-count re-match (`ix/engine_search.rs:337-414`) and the serialized JSON `QueryCache` (`ix/query_cache.rs`). `counted` on derived requests (`ix/engine_types.rs:175-179`) goes with §6, when the rules' `counts` replace the counted signals; until then the atom and problem-column keys carry it.

**As built (decision 29):** each aggregate intersects its cached atoms and walks its own rows in display order, rather than all of them sharing one traversal. With the atoms cached, a walk is an AND over 72 KiB and one pass over the order, about a millisecond at 583,507 lines. The single traversal is built only if the step 9 measurement shows the walks matter.

### Response parts and groups

- `SearchRequest` gains `parts`: any of `rows`, `counts`, `facets` and `groups`. Omitted means all of them, today's answer. A part not asked for is not computed.
    - `rows`: the page's rows and the open groups' rows.
    - `counts`: `counts`, `total`, `problems`, `fileScope` and the localization tallies.
    - `facets` and `groups`: those keys.
- **Open groups.** `SearchRequest` gains `openGroups` (1–20 group keys) and `firstRows` (1–50, default 50), both needing `group`. `openGroups` excludes `openGroup`. `group` stays the field it is today.
    - The answer's `openGroups` lists each named group in the order given, with its first `firstRows` rows in display order as a rows page. The page's `nextCursor` reads the rest with `openGroup`. One walk of the display order fills them all. The page's own rows are empty.
    - At most 500 rows are returned in all. A group past that budget returns `rowsOmitted: true` and no rows, and the host reads it with `openGroup`. A key that names no matching group returns an empty page.
    - `openGroup` with a cursor stays for "more".
- **Two requests per keystroke (decision 28).** Which groups are open depends on the header's answer: the renderer opens the first group, or every group when they hold 50 lines or fewer, as well as those the user opened (`ext/game-text-grouped-results.tsx:82-87`). So the renderer sends the header, then one rows request naming its first 20 open groups in group order, instead of one search per open group (`:150-190`). Any group open past those 20, past the row budget or for "more" is read with `openGroup` and `parts: ["rows"]`. No rows read computes an aggregate.
- **TypeScript.** `TextCorpusSearchRequest` gains `openGroups` and `firstRows`.
    - `search` keeps returning every part.
    - A new `searchRows` sends `parts: ["rows"]` and returns a `TextCorpusRowsPage`: `units`, `nextCursor`, `localization` with `target`, `lines` and `nextCursor`, and `openGroups`. Each host routes it as it routes `search`.
    - Every read with a cursor, grouped or not, uses `searchRows`.

### Parity

Until §6 changes the finding fields, every answer is byte-identical to today's. The native query tests, the TS reference comparisons, the fixture and the benchmark's visible-page hashes (`a2c3e70e…` on 1×, `6b19c93a…` on the released project) must not change.

One exception, by design: from step 3 the benchmark reads open groups as the renderer does, with `searchRows`, so its group replies are rows pages and its answer hash covers the header and those rows. Step 9 hashes the Phase 2 answers through the same projection, the header plus each open group's units, lines and cursors, and compares the two.

## 4. Text search: the trigram index

- **Arenas.** `query.source.{ids,starts,folded}` exists today (`ix/join_query.rs:333-349`). Add `query.translation.{ids,starts,folded}`: every distinct archive translation and PO `msgstr` of every culture, folded as sources are (Rust `to_lowercase`, WTF-8 bytes).
- **Index.** For each arena, `*.tri.{keys,offsets,postings}` (store section names stay within 31 characters): the sorted distinct byte trigrams of the folded strings and, for each, the arena positions that contain it, as delta-encoded varints. They are written when the joined layer is published, next to the arenas.
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

| Column         | Contents                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f.rule`       | The rule index.                                                                                                                                                                                                                                                                                |
| `f.line`       | The line row, for `line` and `line_culture` findings.                                                                                                                                                                                                                                          |
| `f.unit`       | The raw unit row, for `unit_source` findings.                                                                                                                                                                                                                                                  |
| `f.culture`    | The culture index.                                                                                                                                                                                                                                                                             |
| `f.flags`      | `change`: it carries a suggested change. `fixable`: `eligibleLocalizationChange` accepts that change (`gt/localization-quality-index.ts:318-329`). `shadowed`: below. `keyless`: its identity is null, so it can't be accepted (`gt/localization-review.ts:160`).                              |
| `order.report` | Line findings in report order, below.                                                                                                                                                                                                                                                          |
| `order.line`   | Line findings by line, in step 1's line order, and within a line in `findings_lines` emission order: the order the CLI collects proposals and diagnostics in (`gt/localization-check-report.ts:169-189`).                                                                                      |
| `order.source` | `unit_source` findings in today's source report order: rules by ID with the host collator (`gt/quality.ts:80-99`), then units in `raw.order`, then each unit's emission order for that rule. The scan visits units first and then stable-sorts by rule (`gt/source-quality-index.ts:232-257`). |

**Report order** is today's, computed once when the layer is built:

1. Lines by line ID with the host collator, ties in join order (`gt/localization-quality-index.ts:198-233`).
2. Within a block of lines whose IDs compare equal: built-ins ordered by `compareLocalizationFindings`, then policy findings by rule order, then custom findings by the document's order, each stable. Then the block is stable-sorted by `compareReportedLocalizationFindings` (`gt/localization-checks.ts:45-69`, `gt/localization-quality-index.ts:263-294`). Comparisons use the host collator, and `JSON.stringify(actual)` is the stored evidence's `actual` in emission order.

**`shadowed`** is a new optional v4 rule field, a bool expression per finding. The catalogue's `placeholder_text` sets it to "`unreportedMatches` is present and empty": today's `reportedBySource` (`gt/localization-workspace.ts:816-823`). Only the `workspace` view hides shadowed findings, and only when it lists source findings, as today (`:961-970, :1085`). The CLI report keeps them.

A test pins `order.source` with several rules matching several units, so the rule-first order is observable.

The layer's evaluator version rises, so every existing layer rebuilds once.

### Review acceptance: `findings_accept`

A caller chooses the review file a read applies, or none: the scan and the CLI apply `options.review`, which may differ from the file the join read, and an omitted review filters nothing (`gt/localization-quality-index.ts:181-186`, `gt/localization-check-report.ts:191-194`, `gt/localization-quality-index.test.ts:567-606`). So acceptance is an input to reads, not part of the join.

- **`findings_accept {key, previous?, accepted}`** takes up to 5,000 of a review file's accepted findings (`check`, `culture`, `namespace`, `key`, `fingerprint`) and returns an `acceptance` key. A larger file is sent in chunks, each naming the `previous` key, so the set is their union.
- For each entry the engine resolves the line by (namespace, key) and computes `localizationLineFingerprint` for that culture, as the join computes review records' fingerprints (`ix/join_marks.rs:326-360`). It keeps the entries whose fingerprints match, as a set of (line row, culture, check).
- Acceptance sets are cached by (findings key, digest of the entries), like findings layers.
- A finding is **accepted** under an acceptance key when it isn't `keyless` and its (line row, culture, `ruleId`) is in the set. This is `lazyAcceptedFindingFilter` (`gt/localization-review.ts:151-178`), including keeping a finding whose line or culture is missing.
- The workspace and the CLI register the review they apply today (`gt/workspace-localization.ts:529`, `apps/cli/src/workflows/localization-check.ts:130`) once per evaluation, and pass its key. A read without a key hides nothing.

### `findings_query`

```jsonc
{
	"key": "…", // the findings layer
	"view": "workspace", // or "report"
	"culture": "de", // optional: one culture, as the selection
	"rules": ["…"], // optional: program rule IDs
	"severities": ["low"], // optional
	"fixable": true, // optional
	"change": true, // optional: only findings with a suggested change
	"acceptance": "…", // optional: hide what this review accepted
	"line": "…", // optional: one line's findings, for the line page
	"id": "localization-finding:…", // optional: one finding, for focus
	"order": "severity", // or "report" or "line"
	"after": "quality-finding:…", // optional: a finding-ID cursor
	"offset": 0,
	"limit": 50, // 0–5,000
	"counts": true, // optional
	"diagnostics": { "offset": 0, "limit": 5000 } // optional
}
```

**Views.** Today's two readers see different findings, so the view decides the base set before any filter:

| View        | Subjects                                 | Hidden                                                                                  | Today                                                  |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `workspace` | `unit_source`, `line` and `line_culture` | Accepted findings; shadowed findings when the program has an enabled `unit_source` rule | `gt/localization-workspace.ts:961-988, :1083-1101`     |
| `report`    | `line` and `line_culture`                | Accepted findings                                                                       | `loc check`: `gt/localization-check-report.ts:166-207` |

Accepted findings are hidden only under an `acceptance` key. The CLI's proposals are read without one, since it collects them before acceptance applies (`gt/localization-check-report.ts:184-189`).

**The cursor.** `after` names a finding ID. The rows start after the first finding with that ID in the request's order, and only if that finding is in the selection; otherwise they start at the first. This is the source search's cursor (`gt/quality-query.ts:529-545`): equal findings share an ID and a cursor names the first. The engine finds the position by the ID lanes (`r{r}.id0`, `r{r}.id1`), without paging through. Tests pin a duplicate ID, an unknown ID and an ID outside the filter.

**Selection.** Within the view, a finding is selected when its culture is the requested one, its rule and severity are listed, and it has a change or is `fixable` if asked. A `unit_source` finding has no culture and is always in the culture selection. These are today's culture filter (`gt/localization-quality-index.ts:270-271`) and workspace filter (`gt/localization-workspace.ts:1050`).

**Order.**

- `report`: `order.report`, the `loc check` findings order.
- `line`: `order.line`, the order of the CLI's proposals.
- `severity`: blocking, normal, then low. Within each, `unit_source` findings come first in `order.source`, then line findings in `order.report` (`gt/localization-workspace.ts:1012-1024`). A source finding's severity is its rule's, `normal` for both source kinds (`gt/localization-check-catalogue.ts:503-506`).

**Rows** are findings in today's host shapes, composed as `findings_lines` and `findings_units` compose them (`ix/rules/findings_read.rs`), each with its `id`, program rule ID, severity and line ID.

- A row also carries what the list summary reads from the line: `manifestSource` and the first manifest path (`gt/localization-workspace.ts:573-616`). TS never reads the line.
- Places are interned as today, with the 16 MiB spill.

**Counts** have three scopes, as `select` has today (`gt/localization-workspace.ts:1027-1126`):

| Scope                                       | Counts                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The view and the culture selection          | `all`, by rule, by severity, and `accepted`: the findings the acceptance key hid. These feed the filter list and the severity counts. |
| Every filter of the request                 | `total`, `fixable`.                                                                                                                   |
| The culture selection only, for diagnostics | `limits`: diagnostics by code, in first-seen order (`gt/localization-quality-index.ts:331-341`, `gt/localization-workspace.ts:1119`). |

**Diagnostics.** `diagnostics` pages the check diagnostics in the culture selection, in `order.line`'s line order and each line's emission order: the CLI's `checkDiagnostics` (`gt/localization-check-report.ts:169-174`).

The reply carries a `profile` of its stages.

Workspace filters map to rule IDs in TS, from the evaluation's rule list:

- a check to its rule;
- `character_budget` and `terminology` to every rule of that source or localization kind;
- `custom.<id>` to that rule.

Counts by filter sum the counts by rule.

**The CLI report** is these reads:

- `findings`: view `report`, order `report`, the review's `acceptance` key, by 5,000;
- `checkDiagnostics`: the `diagnostics` pages;
- `changes`: view `report`, rule `format_argument_renamed`, `change`, no acceptance key, order `line`;
- `rules` and `acceptedFindings`: the counts.

## 6. Findings in Browse

- **The layer.**
    - `SearchRequest` gains `findings`: a findings layer key.
    - The workspace evaluates the effective document, the project's file with the host overlay applied (`applyRuleOverlay`, `gt/game-text-rules.ts:473-508`), whenever it has an enabled rule and the index is ready. An overlay alone is enough; a file isn't required.
    - With a target selected, every rule runs. Without one, only `unit_source` rules run, as source rules do today (`gt/game-text-rules.ts:67-85`), so corpus mode keeps the source rules' findings.
    - The workspace passes the key once the layer is ready, with the `acceptance` key of the review it applies (§5). The page reports `findings: {status}`: `none` (no enabled rule), `pending` (evaluating) or `ready`.
- **Rows.** A finding belongs to a listed row when it isn't accepted under the request's acceptance key, it isn't hidden as `shadowed` (as the `workspace` view hides it), and:
    - for a `line` or `line_culture` finding, it is on that line and its culture is in the request's culture scope. Without a culture scope, every culture is.
    - for a `unit_source` finding, the line holds one of its affected occurrences.
    - in corpus mode, a line finding belongs to the raw units of the line's slices, and a `unit_source` finding to its unit.
- **`finding` clauses** name rule IDs as the layer lists them: a built-in check's `localization.<check>`, or a project rule's or complete rule's `id`. A rule not in the layer has no rows, so a saved pill naming a rule the project has since dropped matches nothing rather than failing every search (decided in step 7; the spec first had it invalid). Without a layer, `finding is` matches nothing. The engine keeps each rule's rows per culture scope used, in the atom cache.
- **The finding facet.** `facets.findings: true` returns every rule of the layer, in program order, with its label and the rows it has a finding on. The selection is every atom except the `finding` clauses, as other field facets select. Rules with no rows are returned with 0; the menu hides them unless chosen, as it does other values (`ext/game-text-filter-menu.tsx:113-114`).
- **The fact facet.** `facets.facts: true` counts the rows with each of the four facts. The selection is every atom except the `fact` clauses, as other field facets select. Today's chip counts don't serve: they count only `unresolved` and `conflicting` of the four (`ix/engine_search.rs:10-19, :147-151`), and `readOnly` is editing capability, not `evidence_only`. The chip counts keep their other members and lose `shared`, `duplicate_source` and `long`.
- **Grouping by finding.** `group: "finding"` makes one group per rule, keyed by the rule ID, in program order.
    - A row is in every rule's group it has a finding for, so a row can be in several groups. Rows without a finding are in no group.
    - A group's count is its rows. The page's `total` stays the number of distinct rows.
    - `openGroup`, `openGroups`, `firstRows`, `minGroupSize` and cursors work as for other groups, within the group's rows in display order.
- **The `finding` problem** is raised by a finding of a rule whose `counts` is true (the default). Rules with `counts: false` are still filter and facet values.
- **Facts** keep their native signals: `unresolved`, `conflicting`, `evidence_only` and `compiled_copy_differs`. They move to a new `fact` field. `unresolved` no longer raises `finding`; `conflicting` still raises `conflicting_source`.
- **Rows carry their findings.** Search previews, focus and detail gain `findings`: the IDs of the rules with a finding on the row in scope, the first 32 in program order, and `findingsOmitted`, the number left out. They replace the deleted signals in the row's suffix (`ext/game-text-result-rows.tsx:186`) and the line page's findings list (`ext/game-text-line-page.tsx:232-235`).
- **Deleted:**
    - the `shared`, `duplicate_source` and `long` signals (`ix/engine_types.rs:44-52`, `ix/join_query.rs:110-148, :199-211`, `ix/package_evidence.rs:82-122`, `ix/join_incremental_sources.rs:186-327`, `ix/summary_state.rs:17-27, :82-102`);
    - the request's `lens`, `counted_findings` and `TEXT_FINDING_SIGNALS`;
    - the persisted `line.problems` column (`ix/join.rs:900-941, :1263`, `ix/join_marks.rs:362-373`, `ix/join_incremental.rs:583, :707`), since problems are computed at query time.

    `TextReviewSignal` keeps the four facts.

- **The corpus CSV** keeps its "Review signals" column for the facts. It adds "Findings", the labels of the unit's rules, when the layer is ready (`gt/csv.ts:98-123`, `ix/engine_export.rs:226-227`).
- **The UI parts** are built as this section describes them: the Finding and Fact menus, row suffixes, the line page's findings and the pending state. The owner reviews them in the running app.

## 7. Related lines

`related {target?, selection: {kind: "line" | "unit", id}, pageSize}` returns `self` and four sections, each with at most 50 members and a `complete` flag.

**Members** are of two kinds, as selections are (`ix/engine_detail.rs:29-51`):

- **A unit member:** the unit's search result; its first `pageSize` places, with `complete`; and, with a target, the translations of its line per culture as `localization_detail` gives them, with `complete` when every culture is listed.
- **A line member**, with a target only: the line's preview; its unit IDs (none for a line only in gathered text, at most 50, with `complete`); and its translations as above.

**Sections**, by the selection's kind:

| Section     | Unit selection                                                                                               | Line selection                                              | Today                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `self`      | The unit                                                                                                     | The line                                                    |                                                                                 |
| `sameKey`   | Other units with the same gathered identity                                                                  | Empty: a line holds every unit of its key, listed in `self` | A `translation_key` search (`scripts/game-text-engine-stage.ts:510-531`)        |
| `sameText`  | Other resolved units with another identity whose consistent source equals this one's exactly                 | Other lines whose source equals this one's exactly          | The ID repair's text search and filter (`ext/game-text-id-repairs.tsx:264-280`) |
| `conflict`  | For a line with `conflicting_source`, the units of the unit's key whose source differs from the gathered one | The same, for the line's key                                | Cause pages (`scripts/game-text-engine-stage.ts:476-494`)                       |
| `keyChange` | The line paired with the unit's line by key-change pairing, a line member                                    | The line paired with this one                               | The detail's `keyChange`                                                        |

Without a target, only unit sections with unit members exist: `sameKey` and `sameText`.

The ID repair (`ext/game-text-id-repairs.tsx:251-321`) makes one `related` request in place of a search plus a focus and a detail per unit.

- Its list is `self` followed by `sameText`: today's search keeps the selected unit, and the survivor choice and the rewrite read that whole list (`:264-280, :335-354, :528-534`).
- It offers a merge only when `sameText` is complete and every member's places and translations are complete, with today's message for each case.
- Its "same text" check reads `sameText` instead of the deleted `duplicate_source` signal (`:103`).

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
	"expectation": { "object": { "withoutMark": { "lit": true } } },
	"recovery": "Drop the exclamation mark."
}
```

- **Fields.**
    - Required: `id`, `label`, `subject` (`line` or `line_culture`), `when`, `actual`, `expectation` and `recovery`.
    - Expressions are exactly the v4 IR: an object's values are expressions, and constants are `{"lit": …}` (`ix/rules/ir.rs:30-37`). `recovery` is a string in the file, as in the other entries, and becomes `{"lit": …}` when the entry expands.
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
- **Source quality.** `GameTextIndexRefreshResult.sourceQuality(document)` stays (`gt/index-contract.ts:135-143`); the workspace's source search and focus call it (`gt/workspace.ts:281-282, :740`). It returns an `AsyncTextQualityQuery` over `findings_query`: `unit_source` findings in `order.source`.
    - Its report's role totals, `matchedOccurrences` and `matchedTextUnits`, count places a role matches whether or not a finding does (`gt/source-quality-index.ts:179-187, :300-304`). The layer's metadata records them per role at evaluation, as the evaluator already matches roles.
    - Its diagnostics are the layer's metadata report, as today (`:291`).
- **`loc check`** is the reads listed under "The CLI report" (§5). Its output stays byte-identical. `IndexedPolicyData` leaves `localization-check-report.ts`.
- **The status report** reads the joined layer's metadata through the reader, asynchronously (`gt/index-context.ts:27-42`). `readIndexedLocalizationEvidence` uses the reader directly (`:63-67`).
- **The Quality worker** is deleted once in-process Quality is measured on both projects with a largest event-loop gap no worse than the worker's at Phase 2: 115 ms on 1× and 528 ms on the released project.
- **Browse.** The workspace evaluates findings for Browse (§6). The renderer adopts response parts, groups with first rows and the finding fields.

## 10. Deleted

| What                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The TS scans: `indexedLocalizationQuality`, `indexedSourceQuality`, and `LocalizationFindingList` with its groups, positions and hash checks                                       | `gt/localization-quality-index.ts`, `gt/source-quality-index.ts`. The presentation helpers they share with reports move to their callers. `indexedLocalizationQuality`, `indexedSourceQuality`, `LocalizationFindingList` and their signature types are public (`gt/entry-index.ts:85-94`, `gt/index.ts:542-546`, `gt/entry-corpus.ts:119-125`). Each goes with a changeset note if Electroswag doesn't import it, and otherwise stays as an adapter over `findings_query` until Phase 6. |
| The Quality worker: `quality-worker.ts`, `quality-worker-node.ts`, `quality-worker-protocol.ts`, `worker-calls.ts`                                                                 | With their build, test-script, lint-baseline and README references (`apps/workbench/tsup.config.ts:15`, `scripts/check-effect-architecture.ts`, `scripts/test-public-packages.ts:177-178`, `packages/game-text/ADOPTING.md:89`, `packages/game-text/README.md:112`).                                                                                                                                                                                                                      |
| The second TS reader, from production: `indexed-policy-data.ts`, `joined-query-reader.ts`, `hydrateJoinedTarget` and what only it uses, and the `shared-string-file.ts` sync reads | `readJoinedTarget`, `openJoinedTarget` and the public `result.joined` handle stay: they pin and describe the layer. The reference oracles and the join fuzz harness still read through it until Phase 4 (`gt/joined-query-data.test-support.ts:25-33`, `scripts/columnar-join-fuzz.test-support.ts:926-928`), so what they use moves into test support, and the fuzz comparison drops `line.problems`.                                                                                    |
| The native `shared`, `duplicate_source` and `long` signals, `lens` and `line.problems`                                                                                             | §6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The per-facet re-match, `QueryCache` and `matched`                                                                                                                                 | §3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `text-problems.ts` in the renderer, `duplicate-sources.ts`, `review-signals.test.ts`                                                                                               | Public exports that Electroswag imports stay until Phase 6; check its imports first. The tests of the deleted `duplicate_source` signal go with it (`gt/joined-duplicate-places.test.ts` and its support); `gt/joined-query-columns.test-support.ts:12` stops importing it.                                                                                                                                                                                                               |
| The TS reference oracles' signal and problem code (`query.test-support.ts`, `columnar-query.test-support.ts`)                                                                      | The oracles themselves go in Phase 4 (decision 26).                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

## 13. Decisions taken in Phase 3

The owner asked for these to be decided and built, and raised once seen (2026-10-24).

22. **Browse's findings are the project's rules.** Without a rule, from the file or the host's overlay, Browse has no finding fields. "Used in several places", "Same text, different keys" and "Long text" appear only when the rules list them. Without a target, only source rules run. `unresolved` and the other facts move to a "Fact" field and stop raising the `finding` problem.
23. **Browse waits for evaluation.** Finding fields are `pending` while the layer evaluates, about 21 s on the generated 1× project. That happens after every change until Phase 5 makes it incremental.
24. **Accepted findings are hidden in Browse too**, as in Quality.
25. **The corpus CSV gains a Findings column.** Its "Review signals" column keeps the four facts.
26. **The TS reference oracles go in Phase 4**, when every request changes shape. Phase 3 deletes their signal and problem code; they stay the reference for facts.
27. **Complete rules report as custom findings** with check `rule`, and can't propose fixes.
28. **Two requests per keystroke in grouped Browse:** the header, then one rows request for the first 20 open groups (§3). The header can't carry the open groups' rows, because the renderer's default-open rule needs the header's groups. Typing in the all-open state goes from 1 + N requests to 2.
29. **Each aggregate walks its own rows** from cached atoms, rather than sharing one traversal, unless the step 9 measurement shows the walks matter (§3).

## 14. Order of work, one commit per step at least

1. **Fact repairs** (§2), with their pins removed.
2. **Row sets** (§3): atoms, the cache, facets and counts from sets, and problems as a cached column. Answers stay byte-identical. Delete the re-match, `QueryCache` and `matched`.
3. **Response parts and groups with first rows.** The renderer's grouped results adopt them.
4. **The trigram index** (§4), with identical answers and its build cost recorded.
5. **Findings layer v2, `findings_accept` and `findings_query`** (§5). Quality, `loc check` and the status report adopt it.
    - Quality's answer keeps the Phase 1 hash on both projects, and `loc check` stays byte-identical on both canonical corpora.
    - Then delete the scans and the second reader, and the worker once its measurement allows.
6. **Related lines** (§7). The ID repair adopts them.
7. **Findings in Browse** (§6), with the UI parts as mocked.
8. **Complete rules** (§8), with the editor part.
9. **Parity:** the fixture exact, one 10,000-line fuzz run, and `loc check` byte-identical. Then the Phase 0 measurement set against Phase 2, plus:
    - the index's build time and store size;
    - a related-lines row: one `related` request against the 444-request probe.

    Then the owner review.

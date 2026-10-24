# Game Text rule engine: Phase 2 specification

This is the Phase 2 specification for [Plan 059](../../plans/059-game-text-query-and-rule-engine.md). It builds on the [Phase 1 specification](game-text-rule-engine.md), whose subjects, document, evaluation, findings layer and identity rules still hold. It decides the API, the formats and the module boundaries.

Behaviour is defined by today's TypeScript, cited as `file:line` under `packages/game-text/src/` (`gt/`) and `crates/game-text-index/src/` (`ix/`). The [fixture](game-text-corpus.md) is the oracle. Line numbers drift; re-check a citation before implementing it.

## 1. Scope

**Rules in Phase 2:**

| Rule                       | Subject        | Today                                                       | Reads across rows                         |
| -------------------------- | -------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `duplicate_source`         | `line`         | TS Quality check, `gt/localization-checks.ts:255-339, :617` | Lines grouped by source, and their places |
| `inconsistent_translation` | `line_culture` | TS Quality check, `:353-452, :633-663`                      | Translations grouped by (source, culture) |
| `culture_invariant_text`   | `line`         | TS Quality check, `:86-190, :553-588`                       | A project-wide census of properties       |
| `shared`                   | `line`         | Native signal only, `ix/join_query.rs:199-211`              | No: the line's own occurrences            |
| `long`                     | `line`         | Native signal only, `ix/join_query.rs:128-148`              | No: the line's own occurrences            |

**Also in Phase 2:**

- Group and corpus aggregates in the IR (§3).
- v4 becomes a public authoring format. No rule is on without a rules file, and hosts can pass an overlay (§5).
- Quality and `loc check` read every finding from the engine; the TS check engine, the Quality worker and the second TS reader are deleted (§6, §7).

**Decided for Phase 2** ([plan decisions 15 and 16](../../plans/059-game-text-query-and-rule-engine.md#decisions)):

- `duplicate_source` keeps the Quality check's behaviour: gathered-only lines take part, text with no letter doesn't, and each group reports once on its first key.
- Browse keeps its native `shared`, `long` and `duplicate_source` signals until Phase 3. Nothing in `ix/join_query.rs`, `ix/package_evidence.rs` or the signal bits changes in Phase 2.

**Not in Phase 2:** Browse chips and filters from findings, and sorting, paging and counting findings in the engine (Phase 3); incremental group re-evaluation (Phase 5); Electroswag's overlay contents (Phase 6).

## 2. New fields

### `line`

| Field            | Type        | Definition                                                                                                                                                                           |
| ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allOutside`     | bool        | Every culture of the line is `outside_target` (`gt/localization-checks.ts:260`).                                                                                                     |
| `conflicting`    | bool        | Any culture has the unknown reason `conflicting_source` (`:247-249`).                                                                                                                |
| `joinPosition`   | integer     | The line's position in the join. Ties in owner election fall back to it (`:306`).                                                                                                    |
| `duplicateSites` | string list | `localizationDuplicatePlaces` (`:342-351`): each saved occurrence's `duplicateOccurrencePlace`, or else each manifest path's `duplicateManifestPlace`. Empty when there are neither. |

`duplicateSites` normalises exactly as today: lower-cased paths and `(n)` mapped to `[n]` (`gt/localization-key-changes.ts:52-69`, `gt/text-origin.ts:34-36, :105-110`). It is a fact the engine computes, not a rule.

### `occurrences` (child of `line`)

| Field         | Type           | Definition                                                     |
| ------------- | -------------- | -------------------------------------------------------------- |
| `audience`    | string \| null | The occurrence's audience.                                     |
| `tableColumn` | string \| null | For a DataTable cell, the column; otherwise null.              |
| `tableObject` | string \| null | For a DataTable cell, the table's object path; otherwise null. |

### `corpus_occurrence` (new relation)

Every saved occurrence in the project: every unit and package shard, not limited to the target or its gather coverage (`gt/localization-checks.ts:100-153`). It has the `occurrences` fields plus:

| Field        | Type   | Definition                                                                           |
| ------------ | ------ | ------------------------------------------------------------------------------------ |
| `unitStatus` | string | `resolved`, `string_table_entry`, `string_table_reference` or the unresolved reason. |
| `hasKey`     | bool   | The occurrence's identity has a non-empty key.                                       |

Only corpus aggregates read it (§3.2). It is never a rule's subject.

## 3. Aggregates

An aggregate reads rows other than the current one. Every aggregate has an `among` predicate on its rows. It is computed once per evaluation, over **every** row of its relation where `among` is true, whatever the rule's `scope`, the request's culture or the rule's `when`. Scope and `when` decide only which rows report, as in `add()` today (`gt/localization-checks.ts:534-551`). A row where `among` is false or `by` is null gets null.

Arguments are named, as an object: `{"groupCount": {"by": …, "among": …}}`. `among` defaults to `{"lit": true}`. Keys compare as values: strings by code unit, lists element-wise.

### 3.1 Group aggregates over the subject relation

| Operator      | Arguments                                   | Result                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groupCount`  | `by`, `among`                               | Integer: the rows with this row's `by`.                                                                                                                                                                                          |
| `groupRank`   | `by`, `order` (a list), `among`             | Integer: this row's 0-based position in its group, ordered by each `order` expression in turn (strings with the host collator, Phase 1 decision 12), then by relation order. Rank 0 is the group's owner.                        |
| `groupTake`   | `by`, `order`, `value`, `n`, `among`        | List: `value` of the first `n` rows in `groupRank` order.                                                                                                                                                                        |
| `groupTally`  | `by`, `value`, `display`, `among`           | List of `{value, count, display}`, one per distinct non-null `value` in the group: `count` rows have it, and `display` is the code-unit-smallest `display` among them. Ordered by `count` descending, then `value` by code unit. |
| `existsOther` | `over`, `by`, `differing` (a list), `among` | Bool, below.                                                                                                                                                                                                                     |

`existsOther` is the anti-self-join `duplicate_source` needs (`gt/duplicate-sources.ts:32-42`).

- `over` is a list expression on the row: its elements are the row's sites. Each site is a tuple of `by` and the `differing` values, all evaluated with the element as `item`.
- Tuples are distinct across the relation: a repeated tuple counts once.
- The result is true when some site of this row has another tuple with the same `by` whose **every** `differing` value differs from the site's.
- It is computed by inclusion–exclusion over tuple counts, as the native signal does (`ix/package_evidence.rs:82-122`), not pairwise.

A rule can read an aggregate in `let`, `when`, evidence and `affected`. An aggregate's `among` may itself read another aggregate, so a group can be filtered and then re-grouped. The compiler orders them by dependency; a cycle is `rule_cycle`.

### 3.2 Corpus aggregates

| Operator      | Arguments                        | Result                                                                                                                                         |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpusCount` | `relation`, `by`, `key`, `among` | Integer: the rows of `relation` whose `by` equals `key`. `by` and `among` see the corpus row as `item`; `key` is evaluated on the current row. |

`relation` is `"corpus_occurrence"`, the only corpus relation in Phase 2. The engine builds one count table per distinct (`relation`, `by`, `among`) and reuses it across rules.

### 3.3 Other new operators

| Operator       | Arguments                    | Result                                                                                                                    |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `maxOf`        | list of integers             | The largest, or null for an empty list.                                                                                   |
| `regexReplace` | string, pattern, replacement | Every match replaced, with Phase 1's JS-compatible dialect, cap and budget. `$&` and `$1`…`$9` as in JS `String.replace`. |

## 4. The rules

Each rule is an example in the v4 catalogue (`gt/rules/catalogue.ts`), written with the operators above and no rule-specific native function. Labels, severities, parameters and recovery texts come from `localizationCheckCatalogue` (`gt/localization-check-catalogue.ts`), as in Phase 1.

### 4.1 `duplicate_source` (`line`, severity low)

- **Candidate** (`localizationDuplicateCandidate`, `:255-263`): `identity` not null; `trim(source)` not empty; `source` has a letter (`\p{L}`); not `allOutside`; not `conflicting`. Gathered-only lines are candidates.
- **Kept:** `existsOther` over the line's sites, by `source`, differing in identity and site, among candidates. A line with no site uses the site `unknown:<identity>` (`:313`).
- **Group:** kept lines by `source`, among kept lines. It reports when `groupCount ≥ 2` and `groupRank = 0`.
- **Order:** namespace, then key, with the host collator, then `joinPosition` (`:302-307`).
- **Evidence:** `actual {source, identityCount: groupCount, identities: groupTake(n 5) of JSON [namespace, key]}`; `expectation {reviewDistinctKeys: true}`.
- **Reported** under `sourceCulture` (`:616`), with today's `affected`, `manifestLocations` and `translationOrigin` (`:512-521, :598, :605-613`).

### 4.2 `inconsistent_translation` (`line_culture`, severity normal)

- **Lines:** the kept members of a `duplicate_source` group with at least two identities, recomputed in the rule's `let`. It doesn't depend on whether `duplicate_source` is enabled (`gt/localization-quality-index.ts:660-668`).
- **Candidate row** (`consistentTranslationCandidate`, `gt/localization-text-shape.ts:94-103`): the source has a letter, `visibleLength ≥ minimumLength` (3), `visibleWords ≤ maximumWords` (4); not native; `latest` not blank after `trim`.
- **Tally:** `groupTally` by (`source`, `culture`) of `translationGroupKey(latest)` (`:110-113`, already `groupKey` in the Phase 1 catalogue), with `display` = `latest`, among candidate rows.
- **Decision** (`gt/localization-checks.ts:418-452`): needs at least two variants; a tie at the top reports nothing. When the majority key equals the source's key, it reports only if `translated × 2 ≥ majorityLines`, and then reports the rows that match the majority. Otherwise it reports the rows that don't.
- **Evidence:** `actual {translation, variants (top 5 {translation, lines}), variantCount, untranslated?}`; `expectation {consistentTranslation: true}` (`gt/localization-quality-schema.ts:191-209`).

### 4.3 `culture_invariant_text` (`line`, severity low)

- **Census:** for an occurrence, `propertyKey` (`gt/localization-checks.ts:100-117`): an asset property gives `p\0classPath\0propertyPath` with `[..]`, `{..}` and `("..")` removed (`regexReplace`); a DataTable cell gives `d\0tableObject\0tableColumn`; a String Table entry gives null.
- **Invariant count:** `corpusCount` among culture-invariant occurrences where `invariantTextPlace` holds: not audience `editor`, not a String Table entry, no `/debug/i` in the package path, not a `TextRenderComponent` property (`:167-177`).
- **Localizable count:** `corpusCount` among occurrences with a resolved or String Table identity and a key, with no other filter (`:135-153`). The two filters differ; that is today's behaviour, not a typo.
- **When:** keyless line; `source` has a letter; every occurrence is unresolved culture-invariant, and there is one; some occurrence passes `invariantTextPlace` and its property's localizable count ≥ its invariant count (`:86-98, :125-132, :183-190, :553-560`).
- **Evidence:** `actual {source}`, `expectation {localizable: true}`, under `sourceCulture`, `translationOrigin "absent"`.

### 4.4 `shared` and `long` (`line`, severity low)

- `shared`: the line has more than one saved occurrence, with compiled copies folded, as Phase 1's `occurrences` already are. `actual {occurrences: count}`, `expectation {singleUse: true}`.
- `long`: `maxOf` the UTF-16 lengths of the line's distinct occurrence sources is at least `limit`, default 40 (`ix/join_query.rs:146-148`). `actual {length}`, `expectation {maximumLength: limit}`.
- Both are new kinds with new identities; no review file refers to them. Labels: "Used in several places" and "Long text" (`gt/csv.ts:13-18`).
- The v1–v3 translator never enables them, so existing rules files report exactly what they report today. A v4 document opts in.

### 4.5 Identity and order

- `duplicate_source`, `inconsistent_translation` and `culture_invariant_text` findings are byte-identical to today's, identity included (Phase 1 §7). A finding with a null identity still can't be accepted (`gt/localization-review.ts:147`).
- Finding order is unchanged: `compareLocalizationFindings` and `compareReportedLocalizationFindings`.

## 5. Documents, defaults and the overlay

- **v4 is public.** `decodeGameTextRuleDocumentJson` accepts version 4. The JSON Schema and the builder are published in `@ue-shed/game-text/rules`. v1–v3 still load through the one translator.
- **No file, no rules** (plan decision 1). Without a rules file the effective document is empty: Quality and `loc check` report no findings, only diagnostics. A v3 file keeps today's meaning: its preset and `checks` translate to exactly the rules it enables today.
- **The host overlay** is a v4 document passed with `findings_evaluate`:
    - A rule whose `id` is in the project document is patched: the overlay's `enabled`, `severity`, `params` and `scope` replace the project's.
    - Any other overlay rule is added.
    - The overlay's canonical hash keys the findings layer, beside the rule-set hash (Phase 1 §6).
    - UE Shed's Workbench and CLI pass no overlay. Electroswag's overlay contents are Phase 6.
- **The rule editor** (`extensions/game-text/src/game-text-rule-state.ts`) learns v4, and Quality gets an empty state for a project with no rules. Both are UI: their design is shown to the owner before they are built.

## 6. Host adoption

### The workspace quality index

- `check(lines)` takes every built-in finding from `findings_lines`, group rules included. The corpus passes are deleted: `duplicateSources`, the translation pass and the census (`gt/localization-quality-index.ts:351-602, :652-674`).
- The scan still reads lines page by page for presentation, review acceptance and `keep`, until Phase 3.
- The scan still pages, sorts and hydrates in TS until Phase 3, about 150 s on 1×. The Quality worker (`apps/workbench/src/main/workbench-live.ts:189-191`) is deleted only when the in-process scan is measured on both projects and its largest event-loop gap is no worse than the worker's: 121 ms on 1× at Phase 1. Otherwise the worker stays until Phase 3, and the plan records why.

### The CLI

- `loc check` reads findings and the lines it reports through the engine in pages. `assembleLocalizationCheckReport` stops hydrating the whole corpus and join (`gt/index-steps.ts:869-880`).
- On both the generated 1× and the released project, that hydration fails today: the corpus export is longer than a V8 string, and the line export is over 2 GiB (2.8 and 2.6 GB). After Phase 2, `loc check` runs on both.
- Its JSON output must be byte-identical to today's on both canonical fixture corpora, checked once as in Phase 1 §10.

## 7. Deleted

| What                                                                                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localization-checks.ts` group checks, `localization-text-shape.ts`, `duplicate-sources.ts`                                                                                                                                                                                                                                                                  | The comparators and the rule-selection helpers move to where their callers are, or to the translator.                                                                                                                                               |
| The public group helpers: `localizationDuplicateSources`, `localizationDuplicateCandidate`, `localizationDuplicatePlaces`, `localizationTranslationVariants`, `invariantTextPlace`, `reportableInvariantText`, `localizationLocalizableProperties`, `localizationPropertiesWhereLocalizable`, `localizationPropertyKey`, `localizationCultureInvariantUnits` | Exported from `gt/entry-checks.ts`, `gt/index.ts` and `gt/browser.ts`. Check Electroswag's imports first; any it uses stay until Phase 6.                                                                                                           |
| `quality-worker.ts`, `quality-worker-node.ts`, `quality-worker-protocol.ts`, `worker-calls.ts`                                                                                                                                                                                                                                                               | With their build, test-script, lint-baseline and README references, once the measurement in §6 allows it.                                                                                                                                           |
| `joined-target-reader.ts` hydration, `joined-query-reader.ts`, `indexed-policy-data.ts`, `shared-string-file.ts` sync reads                                                                                                                                                                                                                                  | `readIndexedLocalizationEvidence` (index open) and `indexedLocalizationStatusReport` (the CLI's status report, `apps/cli/src/workflows/localization.ts:204`) become engine reads first. `inspectJoinedTarget` stays for scripts only if still used. |
| `localization-policy.ts`, `localization-custom-checks.ts`, `quality.ts`                                                                                                                                                                                                                                                                                      | What remains of them is ordering and metadata; it moves into the translator or the catalogue.                                                                                                                                                       |

## 8. Fixture

- No expectation changes for `duplicate_source`, `inconsistent_translation`, `culture_invariant_text` or the Browse signals (decisions 15 and 16).
- A v4 probe enables `shared` and `long` and expects them on the planted cases: the 38–41 and surrogate `long` cases, and the `shared-identity`, String Table and `incremental-conflict` `shared` cases (`scripts/game-text-corpus-plan.ts:681-700, :930-933, :1099-1135, :1548-1549`).
- A near-miss case is added for `culture_invariant_text`, which has none: a property whose localizable count is below its invariant count.

## 9. Order of work, one commit per step at least

1. **The new fields and `corpus_occurrence`**, with tests against today's TS helpers on both canonical corpora.
2. **The aggregates** (§3), with unit tests, including `existsOther` against `DuplicateSources` on random tuples.
3. **The five rules** in the catalogue, matching today's TS per check on the existing check tests and both corpora.
4. **Host adoption** (§6): Quality and `loc check` read group findings from the engine. Then delete the TS group checks, and the worker if the event-loop measurement allows it.
5. **The second reader:** engine reads for evidence and status, then delete it.
6. **v4 public and the overlay** (§5). The UI parts wait for the owner's review of their design.
7. **Parity:** the fixture exact, `loc check` byte-identical on both canonical corpora, one 10,000-line fuzz run. Then the Phase 0 measurement set against the baseline, and the owner review.

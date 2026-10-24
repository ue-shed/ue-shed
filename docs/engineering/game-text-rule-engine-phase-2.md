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
- The rules file format restarts at version 1, a list of references to the engine's rules; v1–v3 and the translator are deleted. No rule is on without a rules file, and hosts can pass an overlay (§5).
- Quality and `loc check` read every finding from the engine, and the TS check engine is deleted (§6, §7). The Quality worker goes if a measurement allows it; the second TS reader waits for Phase 3.

**Decided for Phase 2** ([plan decisions 15 and 16](../../plans/059-game-text-query-and-rule-engine.md#decisions)):

- `duplicate_source` keeps the Quality check's behaviour: gathered-only lines take part, text with no letter doesn't, and each group reports once on its first key.
- Browse keeps its native `shared`, `long` and `duplicate_source` signals until Phase 3. Nothing in `ix/join_query.rs`, `ix/package_evidence.rs` or the signal bits changes in Phase 2.

**Not in Phase 2:** Browse chips and filters from findings, and sorting, paging and counting findings in the engine (Phase 3); incremental group re-evaluation (Phase 5); Electroswag's overlay contents (Phase 6).

## 2. New fields

### `line`

| Field            | Type        | Definition                                                                                                                                                                                                              |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allOutside`     | bool        | Every culture of the line is `outside_target` (`gt/localization-checks.ts:260`).                                                                                                                                        |
| `conflicting`    | bool        | Any culture has the unknown reason `conflicting_source` (`:247-249`).                                                                                                                                                   |
| `joinPosition`   | integer     | The line's position in the join, in the join rows Quality checks (`gt/index-context.ts:50`, `gt/localization-quality-index.ts:374`); null for a line outside the join. Ties in owner election fall back to it (`:306`). |
| `duplicateSites` | string list | `localizationDuplicatePlaces` (`:342-351`): each saved occurrence's `duplicateOccurrencePlace`, or else each manifest path's `duplicateManifestPlace`. Empty when there are neither.                                    |

`duplicateSites` normalises exactly as today: lower-cased paths and `(n)` mapped to `[n]` (`gt/localization-key-changes.ts:52-69`, `gt/text-origin.ts:34-36, :105-110`). It is a fact the engine computes, not a rule.

### `occurrences` (child of `line`)

| Field              | Type           | Definition                                                                                                         |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `audience`         | string         | `player`, `editor` or `unknown`.                                                                                   |
| `unresolvedReason` | string \| null | `culture_invariant` or `missing_key` when `unitStatus` is `unresolved` (`ix/engine_query.rs:456`); otherwise null. |

Rules read them by name. They are not part of a published place: places keep Phase 1's six fields, so finding output is unchanged. Phase 1's `unitStatus` already means "with a key": `resolved` and `string_table` both require one. The census key (§4.3) reads `location`.

### `corpus_occurrence` (new relation)

Every saved occurrence in the project: every unit and package shard, not limited to the target or its gather coverage (`gt/localization-checks.ts:100-153`). Its fields are the `occurrences` fields. It is the occurrence relation Phase 1 already builds from every package shard (`ix/rules/occurrences.rs`), read without a line.

Only corpus aggregates read it (§3.2). It is never a rule's subject.

## 3. Aggregates

An aggregate reads rows other than the current one. Every aggregate has an `among` predicate on its rows. It is computed once per evaluation, over **every** row of its relation where `among` is true, whatever the rule's `scope`, the request's culture or the rule's `when`. Scope and `when` decide only which rows report, as in `add()` today (`gt/localization-checks.ts:534-551`). A row where `among` is false or `by` is null gets null.

Arguments are named, as an object: `{"groupCount": {"by": …, "among": …}}`. `among` defaults to `{"lit": true}`. Keys compare as values: strings by code unit, lists element-wise.

### 3.1 Group aggregates over the subject relation

| Operator      | Arguments                                   | Result                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groupCount`  | `by`, `among`                               | Integer: the rows with this row's `by`.                                                                                                                                                                                                                                                                                                      |
| `groupRank`   | `by`, `order` (a list), `among`             | Integer: this row's 0-based position in its group, ordered by each `order` expression in turn (strings with the host collator, Phase 1 decision 12), then by relation order. Rank 0 is the group's owner.                                                                                                                                    |
| `groupTake`   | `by`, `order`, `value`, `n`, `among`        | List: `value` of the first `n` rows in `groupRank` order.                                                                                                                                                                                                                                                                                    |
| `groupTally`  | `by`, `value`, `display`, `among`           | List of `{value, count, display}`, one per distinct non-null `value` in the group: `count` rows have it, and `display` is the code-unit-smallest `display` among them. Ordered by `count` descending, then by that `display` by code unit (`gt/localization-checks.ts:393, :424`), so a list cut to its first entries keeps today's members. |
| `existsOther` | `over`, `by`, `differing` (a list), `among` | Bool, below.                                                                                                                                                                                                                                                                                                                                 |

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

| Operator       | Arguments                    | Result                                                                                                                                                                                                                     |
| -------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxOf`        | list of integers             | The largest, or null for an empty list.                                                                                                                                                                                    |
| `regexReplace` | string, pattern, replacement | Every match replaced, with Phase 1's JS-compatible dialect, cap and budget. In the replacement, `$&` is the match and `$$` a dollar sign; other `$` sequences are literal. Capture groups wait for a rule that needs them. |

## 4. The rules

Each rule is an example in the v4 catalogue (`gt/rules/catalogue.ts`), written with the operators above and no rule-specific native function. Labels, severities, parameters and recovery texts come from `localizationCheckCatalogue` (`gt/localization-check-catalogue.ts`), as in Phase 1.

### 4.1 `duplicate_source` (`line`, severity low)

- **Candidate** (`localizationDuplicateCandidate`, `:255-263`): in the join (`joinPosition` not null); `identity` not null; `trim(source)` not empty; `source` has a letter (`\p{L}`); not `allOutside`; not `conflicting`. Gathered-only lines are candidates.
- **Kept:** `existsOther` over the line's sites, by `source`, differing in identity and site, among candidates. A line with no saved place uses its identity as its one site, which no saved place equals (today's `unknown:<identity>`, `:313`).
- **Group:** kept lines by `source`, among kept lines. It reports when `groupCount ≥ 2` and `groupRank = 0`.
- **Order:** namespace, then key, with the host collator, then `joinPosition` (`:302-307`).
- **Evidence:** `actual {source, identityCount: groupCount, identities: groupTake(n 5) of identity}`, where each identity is the `{namespace, key}` object the public schema requires (`gt/localization-quality-schema.ts:115`, `gt/localization-checks.ts:326`); `expectation {reviewDistinctKeys: true}`. The `[namespace, key]` JSON today's code builds at `:310` is only a comparison key for the place test, never evidence.
- **Reported** under `sourceCulture` (`:616`), with today's `affected`, `manifestLocations` and `translationOrigin` (`:512-521, :598, :605-613`).

### 4.2 `inconsistent_translation` (`line_culture`, severity normal)

- **Lines:** the kept members of a `duplicate_source` group with at least two identities, recomputed in the rule. It doesn't depend on whether `duplicate_source` is enabled (`gt/localization-quality-index.ts:660-668`). A kept line always has another kept identity in its group, so `existsOther` alone selects them. On `line_culture` its tuples are distinct, so a line's cultures count once.
- **Candidate row** (`consistentTranslationCandidate`, `gt/localization-text-shape.ts:94-103`): the source has a letter, `visibleLength ≥ minimumLength` (3), `visibleWords ≤ maximumWords` (4); not native; `latest` not blank after `trim`.
- **Tally:** `groupTally` by (`source`, `culture`) of `translationGroupKey(latest)` (`:110-113`, already `groupKey` in the Phase 1 catalogue), with `display` = `latest`, among candidate rows.
- **Decision** (`gt/localization-checks.ts:418-452`): needs at least two variants; a tie at the top reports nothing. When the majority key equals the source's key, it reports only if `translated × 2 ≥ majorityLines`, and then reports the rows that match the majority. Otherwise it reports the rows that don't.
- **Evidence:** `actual {translation, variants (top 5 {translation, lines}), variantCount, untranslated?}`; `expectation {consistentTranslation: true}` (`gt/localization-quality-schema.ts:191-209`).

### 4.3 `culture_invariant_text` (`line`, severity low)

- **Census:** for an occurrence, `propertyKey` (`localizationPropertyKey`, `gt/localization-checks.ts:99-117`): an asset property gives `p\0classPath\0propertyPath`, a DataTable cell gives `d\0objectPath\0propertyPath`, and a String Table entry gives null. In both keys the whole `propertyPath` has its container indexes `[..]`, `{..}` and `("..")` removed with `regexReplace` (`PROPERTY_INDEX`, `:100`). The DataTable row is not part of the key.
- **Invariant count:** `corpusCount` among occurrences whose `unresolvedReason` is `culture_invariant` and where `invariantTextPlace` holds: `audience` not `editor`, not a String Table entry, no `/debug/i` in the package path, not a `TextRenderComponent` property (`:167-177`).
- **Localizable count:** `corpusCount` among occurrences whose `unitStatus` is `resolved` or `string_table`, with no other filter (`:135-153`). The two filters differ; that is today's behaviour, not a typo.
- **When:** keyless line; `source` has a letter; every occurrence is unresolved culture-invariant, and there is one; some occurrence passes `invariantTextPlace` and its property's localizable count ≥ its invariant count (`:86-98, :125-132, :183-190, :553-560`).
- **Evidence:** `actual {source}`, `expectation {localizable: true}`, under `sourceCulture`, `translationOrigin "absent"`.

### 4.4 `shared` and `long` (`line`, severity low)

- `shared`: the line has more than one saved occurrence, with compiled copies folded, as Phase 1's `occurrences` already are. `actual {occurrences: count}`, `expectation {singleUse: true}`.
- `long`: `maxOf` the UTF-16 lengths of the line's distinct occurrence sources is at least `limit`, default 40 (`ix/join_query.rs:146-148`). `actual {length}`, `expectation {maximumLength: limit}`.
- Both are new kinds with new identities; no review file refers to them. Labels: "Used in several places" and "Long text" (`gt/csv.ts:13-18`).
- A rules file opts in with `{"kind": "shared"}` or `{"kind": "long"}`; the starter file lists neither.

### 4.5 Identity and order

- `duplicate_source`, `inconsistent_translation` and `culture_invariant_text` findings are byte-identical to today's, identity included (Phase 1 §7). A finding with a null identity still can't be accepted (`gt/localization-review.ts:147`).
- Finding order is unchanged: `compareLocalizationFindings` and `compareReportedLocalizationFindings`.

## 5. The rules file, defaults and the overlay

No project uses a rules file yet, so the format is reset rather than extended ([plan decision 18](../../plans/059-game-text-query-and-rule-engine.md#decisions)). Version 1–3 files, `migrateGameTextRuleDocument` and the translator are deleted. The file restarts at `schemaVersion: 1` and lists the rules a project runs, by reference. The v4 program stays the engine's internal input: the effective document below is built from the file.

```jsonc
{
	"schemaVersion": 1,
	"roles": [
		/* TextRole, as before */
	],
	"rules": [
		{ "kind": "placeholder_text", "severity": "low", "params": { "markers": ["TODO"] } },
		{
			"kind": "terminology",
			"id": "menu.terms",
			"role": "menu",
			"caseSensitive": false,
			"terms": [{ "kind": "forbidden", "term": "OK" }],
			"recovery": "Use the glossary term."
		}
	]
}
```

Every entry has a `kind` and may set `enabled` (default true) and `scope`.

- **Built-in checks.** `kind` names one of the catalogue's checks, `shared` and `long` included. The rule's ID is that name, so each appears at most once. `severity` and `params` are optional; `params` merge over the catalogue's defaults key by key. `segment_separator` needs `params.separator`.
- **Project rules.** The other kinds are today's rule records with their fields, limits and checks, now in one list:
    - `character_budget` and `terminology`: subject `unit_source`, today's source rules.
    - `localization_character_budget` and `localization_terminology`: subject `line_culture`, today's localization rules, with an optional `severity`.
    - `pattern`, `length` and `forbidden_term`: today's custom checks, with `label`, `subject: "source" | "translation"` and an optional `severity`.

    Each has its own `id` and a `recovery`; the first four name a declared `role`. Their expressions are today's translator code, moved into the catalogue.

- **One namespace.** Rule IDs are unique across the file, built-in names included (`duplicate_rule_id`). Nothing is renamed to `family:id`.
- **Closed schema.** Unknown keys are rejected everywhere, and an entry whose `kind` is unknown is `invalid_structure`. The decoder keeps today's other checks: duplicate culture keys, unique role IDs, and declared roles in `role` and `scope.roles`.
- **Complete rules wait for Phase 3** (plan decision 19). A rule with its own expressions has no finding shape that reports can carry until findings become query fields; until then the file holds references only.
- **No file, no rules** (plan decision 1). Without a rules file the effective document is empty: Quality and `loc check` report no findings, only diagnostics. The starter file lists the checks that run by default today: every check but `segment_separator`.
- **Report versions.** `ruleDocumentVersion` is `1` in the localization report (`gt/localization-quality-schema.ts:386`), the source summary (`gt/quality-query.ts:59`) and the full source report, `TextQualityReport` (`gt/quality-schema.ts:397-413`).
- **The rule editor** (`extensions/game-text/src/game-text-rule-editor.tsx`) keeps its screens. It edits the same records, now in one list, so only where it reads and writes them changes. Its v1-to-v2 upgrade goes: there is nothing to upgrade. Without a rules file, Quality shows how to add one in place of findings: **Create rules file** writes the starter, and **Choose a rules file…** loads one (plan decision 20, approved on 2026-10-24).

### The effective document

It is built in TS before `findings_evaluate`, and the result is validated as a v4 program:

1. **Apply the overlay** (below) to the file's entries. Project rules write some settings into their expressions, so patches apply before expansion, not to the expanded rules.
2. **Expand** the entries. A built-in entry becomes its catalogue rule with the entry's settings, and a project rule becomes a complete rule. The program lists built-in rules in catalogue order, then source and localization rules by ID, then custom checks in entry order, as the translator did. Reports sort findings as before.
3. **Derive** the cross-rule parameters from the result:
    - `placeholder_text.params.sourceTerminology` from the enabled `terminology` rules. Each entry carries the rule's role, case sensitivity, terms and `scope`. The `placeholder_text` rule suppresses a placeholder only where that scope admits the line's occurrence (`gt/rules/catalogue.ts:159-177`), by role and path prefix as a rule's own `scope` admits occurrences (`ix/rules/evaluator.rs`, `Evaluator::scope`).
    - `placeholder_translation`'s markers and phrases from `placeholder_text`'s params, whether it is enabled or not; without it, from the catalogue's defaults.

    This is today's copying in the translator (`gt/rules/translate.ts:50-72`), moved to run on every effective document. An overlay that disables or narrows a terminology rule therefore also removes or narrows its placeholder suppression. Derived parameters are reserved: a file or overlay that sets them is `invalid_structure`.

### The host overlay

The overlay uses the file's own entries, plus patches:

```jsonc
{
	"schemaVersion": 1,
	"roles": [
		/* TextRole, added to the project's */
	],
	"patches": [{ "id": "…", "enabled": false, "severity": "low", "params": {}, "scope": {} }],
	"rules": [
		/* entries, as in the rules file, added */
	]
}
```

- **Patches.** A patch names a rule in the project's file: a built-in check by its kind, a project rule by its `id`. Any other `id` is `GameTextRuleDocumentError` with the new code `invalid_overlay`. Every field but `id` is optional. A field the patch leaves out keeps the project's value; `params` merge key by key into a built-in check's `params` or a project rule's own fields; `scope: {}` removes the project's scope. The patched file must still decode, or the overlay is `invalid_overlay`.
- **Rules.** Entries added after the project's, in overlay order. An `id` the project already uses is `invalid_overlay`.
- **Roles.** Added. A role ID declared by both is `invalid_overlay`.
- **The key.** The overlay is applied before the engine sees the program, and the program's canonical JSON keys the findings layer (Phase 1 §6), so it already covers the overlay.
- **Hosts.** `applyRuleOverlay(file, overlay)` returns the patched file, which the scans read as they read a project's file. UE Shed's Workbench and CLI pass no overlay. Electroswag's overlay, and where it applies it, are Phase 6.

### Source rules

- The source scan reads the effective document's `unit_source` rules, which only `character_budget` and `terminology` entries make. Source findings and summaries keep their two shapes (`gt/quality-schema.ts:344-368`, `gt/quality-query.ts:502-515`).
- Its role summaries come from the file's roles, its rule summaries from those rules' `id`, `kind`, `label` and `role`, and its counts from the findings layer. Today it re-prepares `document.rules` (`gt/source-quality-index.ts:139, :189`, `gt/quality.ts:85`).

## 6. Host adoption

### The workspace quality index

- `check(lines)` takes every built-in finding from `findings_lines`, group rules included. The corpus passes are deleted: `duplicateSources`, the translation pass and the census (`gt/localization-quality-index.ts:351-602, :652-674`).
- The scan still reads lines page by page for presentation, review acceptance and `keep`, until Phase 3. It and the source scan hydrate through `IndexedPolicyData` (`gt/localization-quality-index.ts:838, :1066`, `gt/source-quality-index.ts:128`), so the second TS reader stays until Phase 3 replaces both scans (plan decision 17).
- The scan still pages, sorts and hydrates in TS until Phase 3, about 150 s on 1×. The Quality worker (`apps/workbench/src/main/workbench-live.ts:189-191`) is deleted only when the in-process scan is measured on both projects and its largest event-loop gap is no worse than the worker's: 121 ms on 1× at Phase 1. Otherwise the worker stays until Phase 3, and the plan records why.
- **Measured** at `769f7503` (`quality-in-process` in the engine benchmark): in process, the largest gap is 741 ms on 1× and 882 ms on the released project; with the worker, 115 ms and 528 ms. The worker stays until Phase 3.

### The CLI

- `loc check` reads findings and the lines it reports through the engine in pages. `assembleLocalizationCheckReport` stops hydrating the whole corpus and join (`gt/index-steps.ts:869-880`).
- On both the generated 1× and the released project, that hydration fails today: the corpus export is longer than a V8 string, and the line export is over 2 GiB (2.8 and 2.6 GB). After Phase 2, `loc check` runs on both.
- Its JSON output must be byte-identical to today's on both canonical fixture corpora, checked once as in Phase 1 §10.
- It prints the report in parts, a top-level member and a finding at a time, with the same bytes: the released project's report is longer than a V8 string.
- `--rules <file>` checks with that file in place of the project's own (plan decision 21). Without either, nothing runs and one stderr line says so.

## 7. Deleted

| What                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `localization-checks.ts` group checks, `localization-text-shape.ts`                                                                                                                                                                                                                                                                                                                                                                                                       | The comparators and the rule-selection helpers move to where their callers are. `duplicate-sources.ts` stays until Phase 3: the reference tests of Browse's native `duplicate_source` signal use it (decision 16). |
| The public group helpers: `localizationDuplicateSources`, `localizationDuplicateCandidate`, `localizationDuplicatePlaces`, `localizationTranslationVariants`, `invariantTextPlace`, `reportableInvariantText`, `localizationLocalizableProperties`, `localizationPropertiesWhereLocalizable`, `localizationPropertyKey`, `localizationCultureInvariantUnits`, and their plumbing: `localizationConflictingSource`, `localizationSourceCulture`, `localizationRuleContext` | Exported from `gt/entry-checks.ts`, `gt/index.ts` and `gt/browser.ts`. Check Electroswag's imports first; any it uses stay until Phase 6.                                                                          |
| `quality-worker.ts`, `quality-worker-node.ts`, `quality-worker-protocol.ts`, `worker-calls.ts`                                                                                                                                                                                                                                                                                                                                                                            | With their build, test-script, lint-baseline and README references, once the measurement in §6 allows it.                                                                                                          |
| `localization-policy.ts`, `quality.ts`'s `prepareTextQualityRules`                                                                                                                                                                                                                                                                                                                                                                                                        | Reports read rule metadata from the effective document.                                                                                                                                                            |
| The v1–v3 rules file: its schemas and decoders, presets, `migrateGameTextRuleDocument`, `localization-custom-checks.ts`, the translator (`rules/translate.ts`, now `rules/effective.ts`), the v1 and v2 fixtures and their compatibility tests                                                                                                                                                                                                                            | The reset (§5). The translator's rule code moves into the catalogue.                                                                                                                                               |

The second TS reader (`joined-target-reader.ts` hydration, `joined-query-reader.ts`, `indexed-policy-data.ts`, the `shared-string-file.ts` sync reads) is not deleted in Phase 2. Both retained scans hydrate through it (§6), so it goes in Phase 3 with them (plan decision 17).

## 8. Fixture

- No expectation changes for `duplicate_source`, `inconsistent_translation`, `culture_invariant_text` or the Browse signals (decisions 15 and 16).
- The fixture's rules files are rewritten in the new format with unchanged expectations. A probe file lists `shared` and `long` and expects them on the planted cases: the 38–41 and surrogate `long` cases, and the `shared-identity`, String Table and `incremental-conflict` `shared` cases (`scripts/game-text-corpus-plan.ts:681-700, :930-933, :1099-1135, :1548-1549`).
- A near-miss case is added for `culture_invariant_text`, which has none: a property whose localizable count is below its invariant count.

## 9. Order of work, one commit per step at least

1. **The new fields and `corpus_occurrence`**, with tests against today's TS helpers on both canonical corpora.
2. **The aggregates** (§3), with unit tests, including `existsOther` against `DuplicateSources` on random tuples.
3. **The five rules** in the catalogue, matching today's TS per check on the existing check tests and both corpora.
4. **Host adoption** (§6): Quality and `loc check` read group findings from the engine. Then delete the TS group checks, and the worker if the event-loop measurement allows it.
5. **The rules file reset and the overlay** (§5). The UI parts wait for the owner's review of their design.
6. **Parity:** the fixture exact, `loc check` byte-identical on both canonical corpora, one 10,000-line fuzz run. Then the Phase 0 measurement set against the baseline, and the owner review.

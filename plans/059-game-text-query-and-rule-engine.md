# Plan 059: One query and rule engine inside the Game Text index

> **Executor instructions**: Read this plan fully before starting. Also read `AGENTS.md`,
> `docs/README.md`, `docs/vision-and-architecture.md` (especially
> [Base, not constraints](../docs/vision-and-architecture.md#base-not-constraints)),
> `docs/engineering/native-game-text-index.md`, `docs/engineering/game-text-corpus.md` and Plan 057.
> Run targeted checks while you iterate. Honour the STOP conditions.
> At the end of every phase, measure, compare with the baseline and review the plan with the owner
> before you start the next phase.
>
> **Drift check (run before each phase)**:
> `git diff origin/main...HEAD -- crates/game-text-index packages/game-text packages/unreal-assets apps/cli apps/workbench extensions/game-text`.

## Status

- **State**: In progress. Phase 0 is complete: the fixture merged in #162, and the baseline and
  transport decision are recorded.
- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH. This replaces how every finding is produced and how every Game Text query runs.
- **Depends on**: Plan 057's native engine and the Game Text fixture (Phase 0).
- **Supersedes**: Plan 057 Phase 8 (quality checks read the index) and Plan 057's open query targets.
- **Category**: direction
- **Planned at**: `test/game-text-fixture`, 2026-10-22

## Context

Static analysis of 0.21.0 and measurements on a released 10-culture project with about 172,000
lines found the following.

1. **The quality pass spends its time moving rows, not checking them.**
    - On the released project the pass takes about 196 s.
    - Rust returns line numbers only. A second, TypeScript snapshot reader then rebuilds every line
      as a JS object, with its manifest, archive and PO entries per culture. It also builds every
      occurrence of the line's units whenever the line has a finding.
    - Plan 057's profiles put line hydration at 69% of the pass, and shared-string lookups at 37%
      after the rewrite. The checks themselves take 1–6%.
    - The same evidence is already built natively (`engine_evidence.rs`).
2. **Findings come from four families, in two languages, and they disagree.** The families are:
    - native signals and states;
    - 25 built-in TS checks;
    - 7 kinds of rule-file rules;
    - derived gates and suppression.

    The disagreements:
    - **`duplicate_source`** exists as both a native signal and a TS check, with different candidate
      filters and grouping units. The same text can be a finding in Browse and not in Quality.
    - **"Same key, different text"** is computed in four places.
    - **"Characters"** means UTF-16 units for `long` and budgets, code points for custom length,
      and visible length for `length_outlier`.
    - **Policy is hard-coded in several places:**
        - in Rust (`long ≥ 40`, twice);
        - in the TS catalogue;
        - in host code (Electroswag disables three checks and hard-codes a token separator).
    - **The active rules live in renderer `localStorage`**, so the app and `ue-shed loc check` can
      report different findings for the same project.

3. **Rules never reach the engine.** The only rule-like inputs Rust receives are the audience
   policy and the generated problem table. There is no rule evaluator in the crate.
4. **Queries are interpreted one row at a time.**
    - The matcher walks the display order row by row. It keeps no bitsets, and it re-runs a full
      match for every facet, count and problem tally.
    - Text search is a linear scan.
    - The transport:
        - Requests and responses are JSON strings nested inside NDJSON frames on a child process's
          stdin and stdout, so they are encoded twice.
        - Each process answers one request at a time, and nothing can be cancelled.
        - Interactive replies carry at most 50 rows. Bulk reads go through temp JSON files that
          TypeScript decodes whole.
5. **Callers work around the API.**
    - Every keystroke sends 1 + N searches, and each one recomputes every facet.
    - Selecting a row in Electroswag can cost up to about 444 requests.
    - Every write triggers a reload cascade.
    - Renderers assemble places, chips, facets and related-line groups in JS.
    - Electroswag forked the workspace. The fork differs from 0.21.0's `workspace.ts` by
      1,148/1,266 lines (removed/added).
6. **What a SQLite spike showed, on the same project:**
    - **What worked:** relational semantics, a planner, a text index and a thin request path made
      every rule easy to express (exact parity on five rules) and made 3+ character searches take
      7–19 ms.
    - **What didn't:**
        - the file was 2.0–2.3 GB against our 118 MB;
        - loading took 107 s;
        - 1–2 character searches took 0.7–3.7 s;
        - big live facets took 1–4.7 s.

    The decision is to keep the native store and add the pieces the spike proved valuable.

## Decision

The Game Text index becomes one engine that owns facts, rules, findings and queries.

1. **Facts are built in; judgment is a rule.**
    - Unreal's behaviour is computed natively as built-in columns and is not configurable:
        - identity, resolution and String Table references;
        - gather coverage;
        - localization states, facts and unknown reasons;
        - each translation stage per culture (PO, archive, compiled `.locres`), and whether a stage
          is behind the one before it;
        - key changes;
        - `unresolved`, `conflicting`, `evidence_only` and `compiled_copy_differs`.
    - Everything that is judgment is a rule in a project-authored document. That includes today's
      `long`, `shared` and `duplicate_source` signals, every built-in check, thresholds, word lists,
      severities, scopes, and which findings count as problems.
    - This applies [Base, not constraints](../docs/vision-and-architecture.md#base-not-constraints)
      to the engine itself.
2. **One expression language for rules and queries.**
    - It is a typed intermediate representation (IR), built from TypeScript and stored as JSON.
    - A rule is a named predicate over a relation that emits findings.
    - A query filter is the same kind of expression, and a query can filter on findings.
    - There is no SQL and no SQL text parser. Rules are not tied to SQL semantics or to a database.
3. **Findings are columns.** Each active rule produces a column over its subject rows, with evidence
   stored beside it. Browse chips, the Quality tab, counts, facets and exports all read the same
   columns. "Findings" and "quality checks" stop being two things.
4. **Today's rules become opt-in examples.**
    - UE Shed ships every current check and rule as an example rule definition, written in the same
      language a studio uses.
    - Anything a built-in does, a studio can rebuild from scratch.
    - No rule is on by default. A project opts into the examples it wants. A host can ship its own
      default overlay.
5. **Callers ask for exactly what they need, and results stream.**
    - Rows, counts, facets and groups are separate parts of a request.
    - Results arrive as column batches.
    - Requests can be cancelled and can run concurrently.
6. **Incremental by construction.** The engine knows from the IR which columns and groups each rule
   reads, so a package delta re-evaluates only the affected rows and groups.
7. **One implementation.**
    - No TypeScript mirror of engine logic and no reference oracle.
    - The fixture's planted right answers are the oracle.
    - Code that a phase replaces is deleted in that phase.

## Design

### Relations and built-in columns

- **Relations:**
    - `occurrence`: a saved place;
    - `unit`;
    - `line`;
    - `line_culture`;
    - the evidence relations `manifest_entry`, `archive_entry` and `po_entry`, joined by (namespace,
      key) and carrying multiplicity;
    - `finding`.

    These already exist as columns in the joined layer and the file layers (`join.rs`,
    `join_columns.rs`, `join_query.rs`).

- **Built-in projections:**
    - **Translation stages per culture.**
        - Each stage is its own fact: the PO `msgstr`, the archive translation and the compiled
          `.locres` value. Each one also records whether it is behind the stage before it: an
          import or a compile is pending.
        - `latest` is today's projection: the PO when `not_synced`, otherwise the archive.
        - UE Shed doesn't decide which stage is the right one to check; the rule does. A
          pre-submit rule checks `latest`, and a release rule can check `compiled`. The example
          rules use `latest`, as the checks do today.
    - the source culture;
    - `sourceVariants` for conflicting saved sources;
    - gather coverage;
    - key-change pairing (bipartite matching across tiers).

    These stay native code because they are Unreal facts or structural joins, not policy.

- **Columns rules need that are only built as JSON today** must become real columns:
    - manifest notes and metadata;
    - PO and archive translations, and their extras;
    - occurrence `object`, `property`, `class` and `row`;
    - copies (`engine_evidence.rs`, `engine_query.rs`);
    - compiled `.locres` values, through a native `.locres` reader. Nothing reads them today.
- **The audience policy** stays a policy input passed at `open`, unchanged.

### The expression IR

Expressions are typed: bool, integer, string (WTF-8, with UTF-16 offsets), string list, token list.
They are built from these parts:

- **Column reads** on the subject relation, and on its parent and child relations:
    - `any`, `all` and `count` over a line's occurrences, including nested copies;
    - evidence fields through the joins.
- **Comparison, boolean and arithmetic operators**, and parameters (`param("minimumLength")`).
- **String measures, each with an explicit name:**
    - `utf16Length`, `codePoints` and `visibleLength`;
    - the word counts `wordsWhitespace`, `wordsVisible` and `lineBreakWords`;
    - interior line breaks;
    - trim and CRLF normalisation.
- **Character classes:**
    - Unicode general categories and scripts;
    - JS `\s`;
    - Unreal's `FTextChar` whitespace set;
    - East Asian wide ranges.
- **Regex and terms:**
    - regex with JS-compatible syntax, Unicode case folding, UTF-16 offsets and a match cap;
    - term matching with both word-boundary sets, case-sensitive or not.
- **Unreal tokenizers:**
    - the format pattern, with arguments, modifiers and issues, parameterised by culture through the
      ICU plural tables;
    - Slate rich-text tags;
    - the raw `<…>` counter that Unreal's compile validator uses;
    - brace balance.

    These are Unreal facts, so they are base functions, not rules.

- **Comparing tokens:** multiset and ordered-set comparison of tokens between source and
  translation, including pairing dropped and added tokens in order.
- **Group aggregates** over a key expression:
    - `groupCount`;
    - `groupCountDistinct`;
    - `groupMajority`, with a tie flag;
    - `groupFirst` by ICU collation, for owner election;
    - `existsOther(by, differing)`, the anti-self-join `duplicate_source` needs;
    - corpus-wide aggregates for two-pass rules such as `culture_invariant_text`.
- **Rule references:** `finding("format_arguments")` reads another rule's column. Suppression and
  reuse become ordinary expressions, and the engine orders rules as a dependency graph that must
  not contain cycles.

Left out on purpose:

- arbitrary joins between unrelated relations;
- user-defined functions;
- recursion.

When a studio needs logic the IR can't express, a **host rule** consumes a streamed batch of
subject rows and returns findings by row ID. It is slower, but it uses the same contract.

### Rules

A rule has:

- `id`;
- a `subject` (`line` or `line_culture`);
- `scope`, as an expression over cultures, roles and path prefixes;
- `when`;
- evidence (`actual`, `expectation`);
- `severity`;
- `params`;
- optional `fix` and `counts` (whether it raises the `finding` problem).

The subject decides how often a finding is reported:

- A check of the source text has subject `line`. It is reported once per line, under the line's
  source culture, as source checks are today.
- A check of a translation has subject `line_culture`.

Illustrative syntax:

```json
{
	"id": "long",
	"subject": "line",
	"params": { "limit": 40 },
	"when": { "gte": [{ "utf16Length": { "column": "source" } }, { "param": "limit" }] },
	"actual": { "utf16Length": { "column": "source" } },
	"severity": "low"
}
```

- **Rule documents v4:**
    - a JSON IR with a published schema, plus a builder in `@ue-shed/game-text/rules`;
    - documents v1–v3 translate to v4 when loaded, through one translator, with no second engine;
    - the examples ship as a v4 catalogue that a starter file can copy from.
- **One authority for the active rules:** the project's rules file plus a host overlay document.
  Electroswag's three disabled checks, its default audience filter and its token separator move
  into that overlay. Rules are never read from renderer storage.

### Findings layer

- **Key and contents:**
    - It is content-keyed by (joined key, canonical rule-set hash, host overlay hash).
    - For each rule, it stores a bitset over the subject rows.
    - A sparse evidence table holds row, culture, `actual`, `expectation` and fix.
    - Counts are kept by rule × culture × severity.
- **Lifetime:** like the joined layer, it is published atomically, pinned by readers and remapped by
  compaction (`store.rs`).
- **Finding identity** keeps today's definition: a hash of line, culture, rule, kind and canonical
  `actual` and `expectation`. Severity isn't part of it. Review files that record accepted findings
  therefore keep working. The definition is written down as a spec rather than left to an
  implementation.

### Query engine

- **Predicates.**
    - Filters use the same IR. Each clause evaluates to a bitset, cached per clause and generation.
    - Combining clauses is word-wise AND, OR and NOT. At 583,000 lines a bitset is 73 KB.
- **Facets and counts.** Each facet ANDs every other clause's bitset, then counts in one pass. All
  facets, counts and problem tallies come from the same pass instead of a re-match each.
- **Order and paging.** The existing rank vectors and keyset cursors stay (`engine_page.rs`).
- **Groups.** One request returns the groups with their first K rows.
- **Related lines.** A built-in shape returns the lines with the same key, the same text, a conflict
  cause or a likely key change, with their members, places and translations. This replaces the
  renderer's fan-out.
- **Text.**
    - A trigram index over distinct folded dictionary strings, for sources and translations, maps
      trigrams to string-ID postings. A query becomes a string bitset, then a row bitset.
    - One- and two-character queries keep the native `memchr` scan, unless measurement says
      otherwise.

### API and transport

- **Requests.** A request is typed IR, encoded once. It names the parts it wants: `rows` (columns
  and range), `counts`, `facets[...]`, `groups`, `related` and `detail`.
- **Responses** are a stream of frames: header, column batches (`u32` columns plus a string arena),
  counts, facets, progress and end.
- **Behaviour.**
    - Requests carry IDs, can be cancelled and run concurrently on one reader.
    - Bulk export is the same stream written to a sink by the engine (CSV, JSONL) and returns a count.
    - Quality jobs report progress on the stream, which replaces the 250 ms polls.
- **Transport options**, decided by the Phase 0 measurements:
    - **(a)** keep the child process, with binary frames over its pipe;
    - **(b)** the child process writes batches to shared memory;
    - **(c)** an in-process N-API module.

    Phase 0 chose (a). Small-request pipe delivery is 0.52 ms on the generated project and
    0.60 ms on the released project. Engine compute and column construction dominate.

### Incremental updates

- **Rules that read only their own row** re-run on the rows the overlay patched (`join_incremental.rs`,
  `patchRows`).
- **Group rules.** They keep group aggregates by subtracting the old and adding the new, as
  `summary_state.rs` does. They re-run on the members of every group that changed.
- **Corpus aggregates** are recomputed, and their dependents are compared against the previous
  result.
- **The findings layer** gets overlays like the joined layer.

### Hosts

- **UE Shed workspace.** There is one, with hooks for host policy:
    - progress;
    - rules caching;
    - polling-safe state;
    - Perforce.

    These are the gaps that kept Electroswag from using it.

- **Electroswag** deletes its forked workspace and its vendored oracle, and calls the published one.

## What gets deleted

| Item                                                                                                                                             | Phase                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| **TS check engine:** `localization-checks.ts`, `localization-policy.ts`, `localization-custom-checks.ts` and `quality.ts` evaluation             | 1–2                             |
| **Quality worker and its sync channel:** `quality-worker*.ts`, `worker-calls.ts`                                                                 | 2                               |
| **Second TS snapshot reader:** `joined-target-reader.ts`, `joined-query-reader.ts`, `indexed-policy-data.ts`, `shared-string-file.ts` sync reads | 2                               |
| **TS mirrors of engine logic:** `joinLocalizationTarget`, `text-problems.ts` in the renderer, the reference `*.test-support.ts` oracles          | 2–3, as the fixture covers them |
| **Dead native code:** `join_overlay::publish`, `localization_page`, `localization_focus`                                                         | 1                               |
| **The per-facet re-match** and the serialized JSON response cache                                                                                | 3                               |
| **Electroswag:** the workspace fork and `ue-shed-oracle`                                                                                         | 6                               |

`line.problems` is either read by queries or removed in Phase 3.

## Phases

### Phase 0: fixture and baseline (complete)

- **The fixture.**
    - The corpus generator plants every case with its right answer, and writes localization files and
      an expectations file.
    - It runs as a fuzzer at any seed and scale.
    - Known defects of today's engine are listed per case.
- **The baseline.** Measured on the generated corpus at 1× and, read-only, on the released project:
    - build, open and cached reopen;
    - the quality pass;
    - a keystroke search with facets;
    - row selection with detail and related lines;
    - the per-request overhead, broken down into serialize, pipe, parse and decode.
- **The transport spike.** Chose (a), binary frames over the existing child-process pipe, after
  three generated-project rounds and two released-project rounds.

Baseline medians, except the keystroke p95:

| Path                                            | Generated 1× | Released 10-culture project |
| ----------------------------------------------- | -----------: | --------------------------: |
| Cold build to visible page                      |     66.999 s |                   108.189 s |
| Open to visible page                            |      1.897 s |                     1.812 s |
| Cached reopen                                   |      2.957 s |                     6.068 s |
| Quality, captured defaults                      |     94.110 s |                   176.291 s |
| Workbench matching 1–2-character keystroke, p95 |    598.98 ms |                   389.44 ms |
| Saturated related-line probe, 444 requests      |    784.24 ms |                   638.17 ms |

The [measurement record](../docs/engineering/game-text-engine-measurements.md) has the request
mix, commands, complete tables and probe coverage. Engine compute and column construction,
especially for all rows, are the Phase 3 and 4 work.

### Phase 1: facts, the IR and rules that read only their own row

- Split the facts from policy.
- Implement the IR evaluator and the base functions (measures, character classes, regex, terms,
  tokenizers).
- Write the 19 localization checks, the source checks that read only their own row, and the custom
  kinds as v4 example rules.
- Write the v1–v3 translator.
- Persist the findings layer.
- The Quality tab and Browse chips read it.
- **Parity:** the fixture is exact for these rules, except for the known defects this phase fixes.
  Those entries are removed.

### Phase 2: group rules and rule references

- Add group aggregates, corpus aggregates and rule references.
- `shared`, `duplicate_source`, `long`, `inconsistent_translation`, `culture_invariant_text`,
  `string_table_key_collision` and `length_outlier` become rules.
- There is one `duplicate_source`. Today the fixture records two behaviours:
    - the native signal leaves out lines that are only in gathered text;
    - the Quality check leaves out text made only of digits or punctuation.

    Decide what the single rule does with each case, and update the fixture's expectations in the
    same change.

- Delete the TS check engine, the worker and the second reader.

### Phase 3: the query engine

- Bitset predicates over the IR.
- Findings as filter, group and facet fields.
- Facets in one pass.
- Separate response parts, groups with their first rows, and related lines.
- The trigram index.

### Phase 4: streaming API

- Frames, column batches, cancellation, concurrency and progress.
- Engine-side export sinks.
- The Workbench and CLI adopt the API.
- The CLI streams `loc check` instead of building a full report.

### Phase 5: incremental findings

Package deltas re-evaluate only affected rows and groups. The fuzzer covers scan, change and rescan.

### Phase 6: Electroswag

- Electroswag deletes its fork and its vendored oracle.
- Rules come from the file plus the host overlay.
- Its fixture runs on the same generator.

## Measurement and acceptance

- **Correctness is the gate.** The fixture must be exact for every case, at the canonical seed and
  in fuzz runs. A disagreement that isn't shown to be a fixture error stops the phase.
- **Performance is measured, not targeted.** Each phase records the Phase 0 measurement set against
  the baseline, and the owner reassesses the direction with those numbers. Plan 057's targets are a
  reference point, not a gate.

## STOP conditions

- **A fixture disagreement** that isn't shown to be a fixture error.
- **A rule the IR can't express** without a rule-specific native function. Stop and decide whether
  that function is an Unreal fact (add it as a base function) or policy (change the IR).
- **A regression against the baseline** on any measured path. Record it and reassess.
- **A change to finding identity** that would invalidate review files without a migration.

## Decisions

Decided on 2026-10-22:

1. **Defaults.**
    - No rule is on by default, in UE Shed or in Electroswag. Every current check and rule is an
      example a project opts into.
    - A host may still ship a default overlay.
2. **Regex.**
    - Custom patterns keep JavaScript syntax through `fancy-regex`, which hands patterns without
      lookaround or backreferences to `regex`. Existing v3 patterns keep working.
    - Each match has a cap and a time budget.
3. **Authoring.**
    - Rules are written as the JSON IR, with the TS builder.
    - Revisit a compact text syntax after Phase 2, once real studio rules exist. It must not be
      SQL.

Decided on 2026-10-23, from the fixture's triage of today's engine:

4. **A String Table reference to a missing entry** is `unknown` with a new reason,
   `string_table_entry_missing`. The table exists and its namespace is known, so today's
   `string_table_namespace_unavailable` is wrong.
5. **"No translator notes"** means no effective notes, manifest notes included. Today the filter
   ignores manifest notes on lines with saved places, so it disagrees with
   `missing_translator_notes`.
6. **The line page keeps the list's culture scope.** Today it recomputes problems over every
   culture, so it can show work the list doesn't.

Decided in Phase 0:

- **Transport:** (a), binary frames over the existing child-process pipe. Delivery is a small
  part of the round trip; retain the process boundary.

UE Shed doesn't have to decide these, because the design leaves them to the rule:

- **Which translation stage a check reads.** Each stage is a fact, and a rule picks `latest`,
  `archive` or `compiled` (see [Relations and built-in columns](#relations-and-built-in-columns)).
- **Whether a finding is reported once per line or per culture.** The rule's `subject` decides.
  Source checks already report once per line under the source culture, so Plan 057's note on this
  is out of date.

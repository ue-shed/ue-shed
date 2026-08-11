# Game Text product

## Product promise

UE Shed makes player-facing text in saved Unreal packages searchable and reviewable without
requiring a running editor. The product preserves Unreal text identity, authored occurrence
evidence, and parser coverage instead of presenting strings as an unexplained flat list.

Saved game text is read-only. UE Shed discovers it through the shared saved-project index and
compact text extraction path, builds one `TextCorpus`, and exposes scan, search, focus, and quality
review through public package and CLI surfaces. Workbench is a bounded client of the same query
model; it is not a second corpus or policy authority. Project-authored quality rule documents are
the one editable artifact in this slice: users may inspect, preview, and save them without changing
game text or localization resources.

## Shipped read-only corpus

The corpus includes decoded String Table entries, DataTable `FText` cells, and supported asset
properties. Every text unit retains its resolved or unresolved Unreal identity and one or more
occurrences with package, object, row/entry/property, and edit-capability evidence.

Coverage is part of every corpus result. Complete and partial results distinguish discovered,
inspected, partial, and failed packages; resolved and unresolved occurrences; and unsupported text
properties. Unsupported evidence and diagnostics remain visible in search/focus and downstream
reports. A zero-finding report never implies complete project coverage unless its attached corpus
coverage does.

The compact corpus path is governed by Plan 033:

- the shared project index performs the only project-wide enumeration;
- text extraction opens only explicit candidates from that index;
- `@ue-shed/game-text` owns normalized text meaning and queries;
- Workbench main owns the active query instance and returns bounded pages over validated IPC;
- renderer state never receives a complete project corpus.

## Project-authored quality contract

Quality rules evaluate the existing `TextCorpus`. They do not scan files, persist another corpus,
or reinterpret parser coverage. The first versioned rule document supports:

- user-defined roles selected through generic occurrence evidence;
- character budgets assigned to roles;
- forbidden terminology and preferred replacements assigned to roles; and
- deterministic structured findings with recovery guidance.

A role contains one or more explicit scopes. Each scope contains one or more evidence matchers, all
of which must match the same occurrence. Scopes are alternatives: an occurrence belongs to the role
when any complete scope matches. Matchers may use location kind, object path, DataTable row/property
evidence, asset class/property evidence, or String Table identity. Empty roles, empty scopes, empty
path values, unknown matcher kinds, duplicate IDs, and rules referencing unknown roles are invalid.
Invalid configuration fails as a typed, actionable decode/validation error and never falls back to
an unscoped or whole-project role.

Rules are deliberately project-authored. UE Shed ships no studio roles, paths, terms, cultures, or
budgets. Matching behavior is versioned with the rule document. Version 1 uses JavaScript string
length consistently and reports that measurement explicitly; rendered width is not inferred.

Terminology rules identify the exact matched term and offsets in the evaluated source. A forbidden
entry explains that the term must not be used. A preferred entry maps one or more discouraged
alternatives to the project-authored preferred term. Matching is deterministic, non-mutating, and
case sensitivity is explicit in the rule.

## Report and finding contract

A quality report retains:

- its schema and rule-document versions;
- corpus complete/partial status, coverage counters, and corpus diagnostics;
- deterministic role and rule summaries; and
- findings in stable rule, role, text-unit, evidence order.

Every finding retains the rule ID, role ID, `TextUnitId`, affected occurrence evidence, structured
actual evidence, a structured expectation, and recovery guidance. Findings explain what was
observed; they do not mutate source text or localization files. Explicit CLI JSON reports may
contain source excerpts and project evidence because review output is their purpose. Ordinary logs,
spans, metrics, and error telemetry must not contain source text, project paths, identities, rule
contents, or project-authored terms.

## Existing review lenses

Configured character-budget findings coexist with the existing hardcoded `long` review lens. The
`long` lens remains a lightweight browsing heuristic for sources of 40 or more JavaScript string
characters. It is not a project rule, does not assign a role, and does not produce a quality
finding. Project-authored budgets are the only authoritative budget checks in quality reports.

Changing or removing the `long` heuristic requires a separate explicit contract change. Loading a
rule document must not silently redefine its threshold or counts.

## Headless and Workbench surfaces

The supported headless quality journey is:

```text
explicit project root + rule file -> existing TextCorpus scan -> pure evaluation -> JSON report
```

The CLI surface is `ue-shed text review <project-root> --rules <file>`, with the existing optional
reader selection. Rule-file IO and decoding are typed boundary failures with safe recovery text.
The evaluator itself is a pure exported function over a decoded rule document and `TextCorpus`.

Browser-safe rule, report, finding, and query schemas live in `@ue-shed/game-text/browser` for
trusted host presentation. Workbench exposes quality review through the existing `GameTextClient`
and corpus query boundary. Its trusted main process retains the active corpus, decoded rules,
evaluated report, and rule-file path; the renderer receives the bounded decoded rule document, a
summary, bounded finding pages, and bounded focused occurrence evidence. It never receives
filesystem authority, the rule-file path, a complete report, or a complete corpus.

The renderer may submit a rule draft for preview or save through schema-validated IPC. The trusted
main process performs semantic validation and evaluation against its retained corpus. A valid
preview replaces the active decoded rules and report but does not write a file. Save atomically
overwrites only the explicitly loaded rule document after the same validation succeeds. Invalid
drafts produce typed recovery guidance and leave the prior valid rules and report intact, so a bad
scope cannot broaden a role to the whole project. Choosing a new corpus clears the retained rule
file and quality review.

The Workbench quality view presents character-budget and terminology queues, authored role/rule
summaries, actual and expected evidence, recovery guidance, `TextUnitId`, affected saved-package
occurrences, and the unchanged complete/partial corpus coverage. Its rule editor exposes rule IDs,
assigned roles, role scopes, character limits, terminology entries, case sensitivity, and recovery
guidance, with explicit Preview changes and Save rules actions. Text browsing remains available
beside quality review, including the independent hardcoded `long` lens.

## Agent operation and adoption

Headless quality review is a read-only agent operation, so it requires no durable mutation proposal.
An agent supplies the project root and rule file explicitly, receives schema-versioned JSON, and can
distinguish invalid rules, scan failure, partial coverage, and completed evaluation without parsing
human prose. No ambient Workbench selection is required. Workbench rule-file Save is an explicit
user action against the already selected rule document; it does not grant agents or the renderer
ambient filesystem mutation authority.

Package-mode adopters continue to follow `packages/game-text/ADOPTING.md` and its manifest. A host
may expose quality review only by keeping corpus and rule-file authority in its trusted process and
transporting bounded schema-validated results to browser code.

## Verification contract

The first quality slice must prove:

- valid version-1 rule documents decode and evaluate deterministically;
- malformed documents and semantic errors produce typed failures with recovery guidance;
- invalid or empty role configuration cannot broaden matching to the whole corpus;
- character budgets and forbidden/preferred terminology retain role and occurrence evidence;
- complete and partial corpus coverage and diagnostics survive unchanged in reports;
- the CLI uses the existing `TextCorpusService` scan and emits the public report schema;
- browser imports remain free of Node, filesystem, process, Electron, and Workbench dependencies;
- invalid Workbench drafts leave the prior valid rules and report active;
- Workbench preview and atomic Save evaluate through the trusted host without mutating game text;
- ordinary telemetry contains no source, path, identity, or rule contents; and
- `pnpm check` passes.

## Explicitly out of scope

- another filesystem enumeration, scanner, corpus, or persistence adapter;
- direct package, source-text, localization, PO, manifest, archive, or compiled-resource mutation;
- translation editing, source/localization Apply or Save, PO import/export, or localization
  compilation;
- rendered-width estimation or engine-specific font/layout simulation;
- built-in studio terminology, roles, paths, cultures, or budgets;
- full-corpus renderer IPC, renderer filesystem authority, or UI-owned rule evaluation; and
- telemetry containing authored text or rule evidence.

The broader localization and authoring direction remains in
[`docs/ideas/game-text-workbench.md`](../ideas/game-text-workbench.md), which is vision rather than
the shipped implementation contract.

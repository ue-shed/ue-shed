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

## Saved investigations and exports

The public browser entry point exposes version-1 `GameTextInvestigationPreset` and
`GameTextInvestigationExport` schemas, `exportGameTextInvestigation`, and
`gameTextInvestigationCsv`. Corpus and quality query models also provide `export` methods that
retain all matching units or findings and their full evidence. Existing search page limits remain
unchanged. A capability filter selects units; exported units retain all their occurrences for
context. Coverage, role counts, rule counts, and diagnostics retain whole-scan scope.

A preset stores the corpus/quality view, search text, capability and review lens, finding-type
filter, existing domain sort order, and optional quality rules. Quality mode requires a rule
document, including semantic validation of rule and role identities. Workbench captures the
current corpus, rules, project, and catalog generation before opening an export dialog. The
renderer receives only file-operation feedback. Opening a preset uses the selected project's
corpus, and exposes failures without applying invalid rules.

The CLI command `investigations run <project-root> --preset <file> --format json|csv` uses the
same public scan and export APIs. Add `--output <file>` to save the result or omit it for stdout.
It requires an explicit project and rescans its current saved files. See
[Showcase](../showcase.md#take-an-investigation-away) for CSV layout, replay commands, and limits.

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

## Localization workspace (planned)

> Status: planned by [Plan 051](../../plans/051-localization-workspace.md) under accepted
> [ADR 0009](../decisions/0009-localization-change-sets-and-review-state.md). Nothing in this section
> is shipped yet; each part becomes a product promise when its phase completes.

Game Text grows into a localization workspace that a writing and localization team can use all
day. For every line it shows the source text, each culture's translation, and that translation's
state. It finds work that is missing or stale, validates translations, runs Unreal's localization
steps, edits translations through a reviewed change set, and records review progress.

### Evidence levels

| Level             | Needs                             | Gives                                                                                                 |
| ----------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Project files  | Nothing                           | The live corpus joined with target settings, manifest, archives and PO files: states, checks, reports |
| 2. Unreal process | An engine install                 | Unreal's own answer: gather, import, export, compile, word counts and conflicts                       |
| 3. Running editor | Unreal open with a UE Shed plugin | Immediate translation writes through Unreal's own APIs (optional, later)                              |

Level 1 is the default experience and needs no engine. Each later level adds a capability; none is
required to browse, search or check text.

### Unreal stays authoritative

- A localization target is the unit of work. UE Shed reads the project's target settings and the
  files Unreal generated for them: `<Target>.manifest`, `<culture>/<Target>.archive` and
  `<culture>/<Target>.po`. The compiled `.locres` and `.locmeta` are evidence only.
- Translations join text in the corpus by Unreal namespace and key only, never by matching source
  text. Text that exists only in the manifest, such as C++ `LOCTEXT` or config text, is shown as
  gathered-only evidence with its manifest source location.
- UE Shed never writes a manifest, archive, `.locres` or `.locmeta` itself. The current PO file is the
  translators' working copy and the only localization file UE Shed's own code writes. Unreal
  imports and compiles it.
- Unreal's gather, import, export and compile run as Unreal processes. UE Shed runs the configs the
  project already has; it does not reimplement Unreal's gather or PO mapping.

### Translation states

States are computed per line and culture from evidence. Each one names its evidence and is never
guessed.

| State                    | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| Translated               | The archive has a translation whose recorded source matches the manifest     |
| Not translated           | No translation, or an empty one, for the culture                             |
| Needs update             | The translation was written for a different source than the manifest now has |
| Not synced               | The PO file holds a translation Unreal has not imported and compiled yet     |
| Not gathered yet         | In the project and inside the target's gather paths, but not in the manifest |
| Changed since gather     | The project's current source differs from the manifest source for the key    |
| Not found in the project | In the manifest, and its package was fully read, but the key was not found   |
| Gathered only            | In the manifest from a source the asset scan does not read, such as C++ code |
| Outside this target      | In the project but excluded by the target's include or exclude paths         |

"Not gathered yet" and "Not found in the project" are claimed only when scan coverage proves them.
If the relevant package was partially read or not read, the line says so instead.

### Checks and reports

Localization checks are quality findings over the same corpus and report model:

- built-in Unreal syntax checks: format arguments missing or added against the source, plural,
  ordinal and gender forms, rich text tags, escapes that will not survive a PO round trip, and
  leading or trailing whitespace;
- missing translations, missing translator notes, and the same source under different keys;
- project-authored character budgets and glossary rules, extended per culture.

Reports give per culture the share of lines and words translated, reviewed and proofread, and the
words that are new or changed since a chosen baseline. Every report carries corpus and gather
coverage, as quality reports already do.

### Editing and review

A translation edit is a staged change set. Each change names the target, culture, namespace and key,
the source it translates, and the translation it replaces. A host shows the diff before anything is
written. The change set is applied by the strongest available writer:

- **PO writer (headless default):** rewrites only the changed `msgstr` values of the culture's PO
  file atomically and preserves everything else in the file. Level 1 shows the result at once as
  "Not synced". A separate, batchable sync asks Unreal to import and compile.
- **Editor writer (optional, Level 3):** a UE Shed editor plugin applies the same change set
  through Unreal's localization APIs, then exports and compiles, without a separate process.

Before writing, every change is checked against current evidence. If the source or the replaced
translation has changed, the change is rejected as stale rather than applied.

Edits that Unreal has not imported are always visible. A translation in the PO file that differs
from the archive is "Not synced", whether UE Shed or another tool wrote it:

- its row carries a "Not synced" mark for that culture;
- the detail pane shows both the PO translation and the translation the game currently uses;
- the toolbar shows how many translations are not synced, beside a "Sync with Unreal" action;
- a "Not synced" filter lists them, and the CLI status and reports count them; and
- checks evaluate the PO translation, because that is what the next sync will ship.

Synced means Unreal imported the PO and compiled the target; a rescan after sync clears the mark.

Review state (reviewed, proofread, approved, machine translated, accepted duplicate) is not
stored by Unreal. It lives in a versioned, project-owned review file per target.
Each record keeps a fingerprint of the source and translation it was given for, so a later edit
shows as "Changed since review" instead of silently keeping the old state.

### Source control

Manifests, archives and PO files are usually checked in. The core reports which files an operation
may write before it runs, so a host can check them out. UE Shed never passes Unreal's source control
switches and never submits. Hosts own source control.

### Workbench presentation

The Game Text route uses one toolbar row (view tabs, one coverage line, Rescan) and gives the rest of
the window to a list and detail workbench. Rows keep the user's words: the text first, then where it
lives. When a culture is selected, each row adds that culture's translation and state. The detail
pane stacks every culture with its translation, state, checks and edit field. A side-by-side grid
for bulk work is a later, optional mode. Counts are computed through the same query as search, so
every count agrees with the list it describes.

## Explicitly out of scope

Out of scope for the shipped product today:

- another filesystem enumeration, scanner, corpus, or persistence adapter;
- direct package, source-text, localization, PO, manifest, archive, or compiled-resource mutation;
- translation editing, source/localization Apply or Save, PO import/export, or localization
  compilation;
- rendered-width estimation or engine-specific font/layout simulation;
- built-in studio terminology, roles, paths, cultures, or budgets;
- full-corpus renderer IPC, renderer filesystem authority, or UI-owned rule evaluation; and
- telemetry containing authored text or rule evidence.

Under Plan 051, the following move into scope as its phases complete. Each is bounded as described
above:

- reading localization target settings, manifests, archives and PO files as evidence;
- running Unreal's gather, import, export, compile and report steps;
- translation editing through staged change sets, with atomic PO writes as the only file writes
  made by UE Shed's own code;
- a project-owned review state file; and
- per-culture checks and localization reports.

The following remain out of scope even under Plan 051:

- UE Shed writing manifests, archives, `.locres` or `.locmeta` itself;
- linking text to translations by matching source strings;
- translation memory, machine translation services, vendors, assignment and billing;
- voice lines and dialogue; and
- source control operations inside the core.

The broader localization and authoring direction remains in
[`docs/ideas/game-text-workbench.md`](../ideas/game-text-workbench.md), which is vision rather than
the shipped implementation contract.

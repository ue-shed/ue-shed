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

Tagged-property text extraction supports classic, uncooked, versioned editor packages from UE 4.27
and UE 5.0–5.3, alongside the existing UE 5.4+ reader. The legacy window includes String Tables,
DataTable and CompositeDataTable rows, data assets, and generic UObject text with nested containers.
UE 4.26 and older tagged properties require resaving in 4.27 or later. UE 4.27 and 5.3 are verified
against engine-saved fixtures and fresh-process Unreal evidence
([Plan 050](../../plans/archive/050-legacy-property-tags.md)). UE 5.0–5.2 have synthetic
version-boundary coverage only. On UE 4.27, packages usually store `None` as their package name, so
text locations use the bare asset name rather than a mounted `/Game/...` path.

Blueprint pins, Sequencer, animation/Skeleton, property bags, InstancedStruct, and actor/component
native records retain their current version gates. Legacy native struct map/set elements without
type information report `legacy_container_element_without_type_information`; unsupported histories
and unavailable engine features retain their own gap reasons. Partial coverage stays visible in
the corpus.

The corpus includes decoded String Table entries, DataTable `FText` cells, and supported asset
properties. Every text unit retains its resolved or unresolved Unreal identity and one or more
occurrences with package, object, row/entry/property, and edit-capability evidence.

Coverage is part of every corpus result. Complete and partial results distinguish discovered,
inspected, partial, and failed packages; resolved and unresolved occurrences; and unsupported text
properties. Unsupported evidence and diagnostics remain visible in search/focus and downstream
reports. A zero-finding report never implies complete project coverage unless its attached corpus
coverage does.

Workbench searches source text as you type. **Editable**, **Read only**, and **No translator notes**
filter the lines; **No translator notes** requires blank notes, after trimming, at every saved
location.

**Where…** narrows the list by where text comes from. It is one compact control; while a filter
is on it reads like "Where: C++ · Source/ · 12 files". It holds three filters:

- **Origins** (String table, Data table, Asset, C++, Other source) keep lines from any selected
  origin. A String Table reference inside an asset counts as the asset. Gathered-only lines take
  their origin from Unreal's manifest path: C++ source files, `/Game` assets, or other gathered
  sources such as config files. Each origin's count ignores the origin filter itself, and an origin
  at zero is hidden unless it is selected.
- **Path starts with** keeps lines whose object path, package file or gathered source path starts
  with the given prefix, such as `/Game/UI/`, `Content/UI/` or `Source/`. The match ignores case
  and slash direction.
- **Changed files** takes a pasted list, one path per line, from any version control tool
  (`p4 opened`, `git diff --name-only`, and so on) and keeps the text those files hold.
    - Saved packages match by asset, whatever the extension (`.uasset`, `.umap`, `.uexp`); an
      Unreal package path such as `/Game/UI/WBP_Menu` names the same asset.
    - Gathered-only C++ and config lines match their source file.
    - Absolute paths inside the project work; blank lines and `#` comments are ignored.
    - The summary reads "12 files · 5 with text · 2 not scanned · 1 outside the project". With the
      localization states, it answers whether a change touches text and needs a gather.

The origin and path filters are saved with the project's view; a changed-file list lasts for the
session. All three are carried by presets and exports. Review chips
highlight reused lines, duplicate wording, long text and localization problems. The detail pane keeps keys, translator notes, exact Unreal names and **Where it appears**
together. **Show in Unreal** reports success only when the editor confirms asset navigation.

Every displayed text count in the toolbar, search and filter chips comes from the same query and
filtering path. Empty or whitespace-only source lines are excluded from those counts and from role
line counts. `TextCorpus.coverage` keeps raw scan provenance counts, including empty text; the query
summary's searchable counts describe the lines shown to people. Read-problem and asset counts
continue to describe scan coverage. Partial reads and unsupported text fields remain inspectable
from either view, with related read problems available in the selected line's details.

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

Create a starter document with `ue-shed text rules init <project-root>`. Its default path is
`Config/UEShed/GameTextRules.json`; `--output <file>` chooses another destination. Creation is
exclusive and refuses to overwrite an existing file. The examples are neutral starting points for
a project's own roles, limits and terminology. Workbench's **Create rules file** uses the same
starter and offers to load an existing file.

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
scope cannot broaden a role to the whole project. Choosing another project clears the retained rule
file and quality review; rescanning the same project retains its rules and reevaluates the checks.

The **Quality checks** tab presents character limits and terminology findings. With nothing
selected, its rules and roles overview shows findings and lines in scope, warning when a role has
none. Selecting a finding highlights the matched term and explains **How to fix** it. **Show key
and translator notes** opens the line in Text. **Edit rules** retains character limits, forbidden
and preferred terms, alternatives, case sensitivity and recovery guidance, with **Preview** and
**Save** actions. Rule IDs, assigned roles and scopes remain inspectable beside the editable
fields. Scan coverage and read problems remain available throughout.

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

Workbench's **Export → CSV** produces a spreadsheet for people: one row per saved location in
**Text**, or one row per finding and affected location in **Quality checks**. Columns retain exact
Unreal names, keys, translator notes where applicable, and package files. Every cell is quoted,
embedded quotes are doubled, and text starting with optional whitespace then `=`, `+`, `-` or
`@` receives a leading apostrophe. Output has a UTF-8 BOM and CRLF endings, including the last row.
Character counts use the same JavaScript string-length measurement as the detail pane. JSON keeps
the existing provenance document; `gameTextInvestigationCsv` keeps its documented metadata layout.

Use **Presets → Save preset… / Open preset…** to retain or restore the current settings.
A preset stores the corpus/quality view, search text, capability, **No translator notes**, origin and path filters and review lens, finding-type
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

## Localization workspace

> Status: shipped by [Plan 051](../../plans/archive/051-localization-workspace.md) under accepted
> [ADR 0009](../decisions/0009-localization-change-sets-and-review-state.md): read-only formats,
> corpus joins, bounded queries, CLI status, Workbench localization views, checks, reports,
> Unreal processes, PO editing and review state. [Plan 052](../../plans/052-text-identity-and-scope-tools.md)
> adds origin and changed-file filters, a Perforce file-list bridge, key-change detection with
> translation carry-over, and an all-languages CSV. Plan 051's Phase 8 extensions remain proposals.

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

The Level 2 headless capability is `ue-shed loc run <operation> <project-root> --target <name>`.
Operations are gather/import/export/compile/reports and sync (Import then Compile in one owned
`GatherText` process). `--plan` returns config files, exact arguments and possible localization
writes without launching. `--engine-root` selects an explicit installation; discovery otherwise
uses the project. UE 4.27 and UE 5.7/5.8 use their respective commandlet executables. `--timeout`
bounds the run; interruption stops its owned process tree. `--json` emits versioned NDJSON step
progress and a receipt. Config-only targets execute their entire supported recipe, with its full
write list, and do not offer operations absent from that recipe. The separate Unreal lane tests
plans, write coverage, cancellation and a PO-to-archive sync in disposable copies.

Receipts audit durable project files by hash, with build/scratch exclusions recorded in the plan.
An unplanned changed file is a planning-defect diagnostic. Private commandlet logs and bounded
failure excerpts are explicit evidence, never telemetry. Failed or interrupted runs may have
partial output and require a fresh plan before retrying. Editor locks are reported when Unreal
provides a sharing-violation message; editor presence alone does not prove a lock. Platform splits,
custom commandlets and asset-repair settings are rejected until their writes can be planned.

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
| Unknown                  | Available evidence cannot prove a more specific state                        |

"Not gathered yet" requires an observed identity inside the target's gather scope and a readable
manifest without that identity. "Not found" requires explicit completion of the manifest's named
package, including packages with no remaining text. Partial, failed and unscanned packages produce
typed unknown reasons. Older corpora without per-package completion cannot prove absence.

The primary state precedence is `outside_target`, `not_gathered`, `not_found`, `gathered_only`,
`changed_since_gather`, `unknown`, `not_synced`, `needs_update`, `not_translated`, `translated`.
Structural state and current-source drift precede culture translation work, matching the fixture
intent. Uncertainty blocks unsupported translation claims. Non-empty PO text differing from the
archive takes precedence over archive staleness. Secondary facts retain every applicable state,
so a changed source can also have an unsynced translation. Native cultures use their native archive
with the same rules; gathered native translations normally equal the source.

Missing manifest/archive/PO evidence, duplicate identities, unresolved corpus identities or String
Table namespaces, conflicting current sources, unavailable gather settings, non-project paths and
unavailable asset classes or excluded-class ancestry are explicit unknown reasons. DataTable cell
locations do not distinguish DataTable subclasses, so class exclusions can require unknown coverage.
Namespace-collapsed PO identities
without keys cannot support an exact join. Crowdin identity PO marks reduced source checking because
it has no source; archive-to-manifest comparisons still determine staleness.

A file confirmed missing supplies absence: a non-empty PO translation with a missing archive is
not synced, while a missing PO does not invalidate a proven archive translation. File failures
remain visible in diagnostics and coverage reasons. Unreadable files cannot supply that proof.

`ue-shed loc status <project-root> --target <name> [--culture <c>] [--state <s>] [--kind <origin>]... [--path <prefix>] [--limit 50]`
reports schema-versioned per-culture counts of lines and source words, coverage and unknown reasons,
file provenance and diagnostics, and a bounded page of matching lines. Localization-aware
`ue-shed text search` accepts the same selection; translation search additionally requires
`--search-translations` and a culture. `--kind` (`string_table`, `data_table`, `asset`, `cpp`,
`other_source`, repeatable), `--path` and `--files <list-file>` filter both commands, including
`text search` without a target. The page's `counts.origins` excludes the origin filter itself, and
`fileScope` summarizes a file list (files, with text, outside the project, not scanned). A list
file holds one path per line, at most 5,000. Counts intersect the same filters as the returned lines
before pagination, including a dedicated `not_synced` count. Gathered-only rows use distinct
evidence IDs, and focus exposes every culture, PO context and manifest source locations.

Every page also counts lines by **problem**, worst first: key changed, same key with different
text, not gathered yet, changed since gather, translation work, finding (reused, the same text
under different keys, long, not localizable) and up to date. A line counts once for each problem
it has; the counts leave out problem filters so each one equals what its own filter returns.
Gathered only, outside the target and origin are facts, not problems.

`--filter` takes a clause, repeatable, such as `problem is key-changed,not-gathered`,
`folder is-not Content/Prototype/` or `translation is missing`: a field (`problem`, `finding`,
`translation`, `origin`, `folder`, `editing`, `notes`), `is` or `is-not`, and comma-separated
values. Every clause must match; `is` matches any of its values and `is-not` none of them.
`--cultures de,fr` limits states, counts and translation work to a culture set. Both work on
`loc status`, `loc export` and localization-aware `text search`; a malformed clause fails with
`invalid_selection` and the expected form.

### Checks and reports

Localization checks are quality findings over the same corpus and report model:

- built-ins now check case-sensitive format argument names, plural/ordinal/gender/Hangul modifiers,
  rich text tags, unsafe PO escapes, boundary whitespace and line-break counts, existing empty
  translation entries, missing translator notes, and the same source under different keys;
- missing translation evidence is a check diagnostic rather than a claim that a translation is empty;
- version-2 project rules add role budgets and glossary terms per culture, evaluated on that
  culture's shipped translation with the same substring and UTF-16 offset evidence as source rules.

`checkLocalizationTarget` is pure and available from both Game Text package entries. It checks the
non-empty pending PO translation when a `not_synced` fact exists, even if source drift or gathered-only
evidence has primary state; otherwise it checks the archive translation. Empty archive/PO entries
are reported independently. The manifest supplies the translation source, including for Crowdin PO;
without a manifest, current corpus source is a fallback with `source_unavailable` diagnostic.
Reports retain corpus coverage unchanged, file provenance and failures, affected saved locations,
identity and culture, structured actual/expectation evidence, and recovery guidance. Unsupported
cultures and bounded syntax parsing produce diagnostics, never assumed English validation.

Grammar follows the supported engines' backtick escapes and modifier lexer. Culture form categories
are fixed to the ICU 64 data used by UE 5.7/5.8, avoiding different results from a host's newer ICU.
Rich text uses Unreal's compile validator: balanced counts pass, and imbalance passes if opening and
closing counts match the source. Self-closing tags and lowercase `<br>` do not count; this check does
not impose tag-name or nesting symmetry beyond Unreal's validator.

UE Shed adds checks the compile validator does not perform: source/translation argument and modifier
comparison, malformed modifier parameters that Unreal treats as literals, whitespace and line-break
drift relative to source, PO escape safety, empty entries, notes, and duplicate source identities.
These are evidence-based built-ins; no rule file is required. Existing version-1 project rule files
may add `disabledLocalizationChecks`, an array of built-in IDs, without changing their source rules.

```sh
ue-shed loc check <project-root> --target <name> [--culture <c>] [--check <id>]...
ue-shed loc check <project-root> --target <name> --changes suggestions.json
```

Check output is schema-versioned JSON. A single missing and single added argument can produce a
rename proposal, including names inside modifier forms. Proposals are version-1 change sets with
source and previous-translation preconditions and evidence provenance. `--changes` exclusively
creates a new JSON proposal; it never overwrites a file or writes PO, manifests, archives, locres or
locmeta. Applying proposals and Workbench check views are later slices.

Version-2 rules derive from v1 and retain source rules and roles. `localizationRules` contains
`localization_character_budget` rules with an explicit culture-to-maximum map and optional default
for unlisted cultures, or `localization_terminology` rules with culture-to-term lists. There are no
implicit expansion multipliers or glossary defaults. Unknown target cultures are warning diagnostics
because a project rule file may serve several targets. Duplicate culture keys, empty terms,
non-positive budgets and invalid role references are typed failures. V1 decoding/evaluation and the
v1 starter remain available unchanged; source review in the CLI also accepts v2. Rules only assign
roles from saved occurrences, so gathered-only evidence cannot acquire an asset role.

```sh
ue-shed loc report <project-root> --target <name> [--baseline <file>] [--save-baseline <file>]
```

Reports give per culture every primary state's line/source-word counts, independent unsynced totals
including secondary facts, and the share of non-optional manifest lines/source words with a current
archive translation. Pending PO edits and source drift remain visible in state counts but do not
increase archive progress. Progress follows Unreal's CSV commandlet, which creates its
helper with an empty native culture: every culture needs a non-empty archive translation recorded
against the full manifest source, without runtime native fallback or foreign native-text overrides.
Reviewed and proofread shares count lines whose current review includes that flag. They are
`not_tracked` until the target has a review file, rather than zero percent. Missing/ambiguous archives make progress unknown; uncountable source words make
word percentages null.

Unreal uses ICU line-break spans for word counts, not whitespace splitting or `Intl.Segmenter` word
tokens. The portable UAX #14 iterator is tested against both committed UE 5.7/5.8 CSVs, requiring
total/de/en/fr of 62/59/62/54 without adjustments. Its Unicode 13 rules are not a claim of complete
ICU 64 parity across locale tailoring or dictionary scripts. Thai/Lao/Khmer/Myanmar source yields
`dictionary_line_breaking_unavailable` and null word totals; billing baselines reject it.

`--save-baseline` exclusively creates version-1 JSON with manifest identities, SHA-256 source
fingerprints (including metadata), word counts, target, timestamp and corpus/evidence provenance.
`--baseline` reports added, source-changed and removed identities with counts for every culture.
Changed words use the current complete source word count, as a vendor's new workload, rather than
the numeric difference from the old count. Removed means absent from the new manifest; it does not
prove absence from an unscanned asset. Every report retains corpus/package coverage, gather file
provenance/failures and unknown reasons. Baseline JSON is the only file this command writes;
Workbench policy/report views remain a later slice.

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
translation has changed, the change is rejected as stale rather than applied. By default a change
set with any stale change writes nothing, so a reviewed set is never half applied.

The PO writer and its CLI are shipped (Plan 051 Phase 6):

- `ue-shed loc apply <project-root> --changes <file>` writes a version 1 change set.
    - `--review` reports each change's outcome and the PO files a write would replace, without
      writing.
    - `--skip-stale` writes the changes that are still current.
    - `--sync` then runs Unreal's import and compile.
    - Change sets come from `loc check --changes` suggested fixes or from any host.
- In Workbench, a non-native culture's translation can be edited in the detail pane, starting
  from the translation that ships next. Edits are staged.
- A "N staged" panel lists them with the old and new text, checks them against the project's
  files, names the PO files to check out first, and offers "Write to PO" after a clean check.
  Staged edits stay in memory until written or discarded.
- Only `msgstr` values change. A PO file that changed after it was read is never overwritten. A
  translation that Unreal's PO import would alter (a backslash before `n`, `r` or `t`) is
  rejected with guidance.
- The editor writer is not built yet.

Edits that Unreal has not imported are always visible. A translation in the PO file that differs
from the archive is "Not synced", whether UE Shed or another tool wrote it:

- its row carries a "Not synced" mark for that culture;
- the detail pane shows both the PO translation and the translation the game currently uses;
- the toolbar shows how many translations are not synced, beside a "Sync with Unreal" action;
- a "Not synced" filter lists them, and the CLI status and reports count them; and
- checks evaluate the PO translation, because that is what the next sync will ship.

Synced means Unreal imported the PO and compiled the target; a rescan after sync clears the mark.

Review state (reviewed, proofread, approved, machine translated, accepted findings) is not
stored by Unreal. It lives in a versioned, project-owned review file per target, at
`Config/UEShed/Localization/<Target>.review.json` by default.
Each record keeps a fingerprint of the source and translation it was given for, so a later edit
shows as "Changed since review" instead of silently keeping the old state.

Review is shipped (Plan 051 Phase 7):

- The file is sorted by culture, namespace and key, tab-indented, and written atomically while it
  still hashes to what was read, so diffs stay one line per change and concurrent writers are
  refused rather than merged. Unreal's gather, import, export and compile leave it untouched.
- Review is tracked once the file exists. Until then lines are not "Not reviewed" and reports say
  `not_tracked`; the first review creates the file.
- Lenses: Reviewed, Not reviewed, Not proofread, Changed since review and Machine translated, with
  counts from the same query as the list. They apply to translated, not synced and needs update
  translations.
- The fingerprint covers the manifest source and the translation that ships next, so a written
  but not synced edit already reads as changed since review.
- An accepted check finding is hidden from checks and counts until its source or translation
  changes, then it returns.
- `ue-shed loc review set|clear|accept|unaccept <project-root> --target <name> --culture <code>
--line <Namespace,Key> [--flag <flag>] [--check <rule>] [--by <name>]`, and
  `ue-shed loc status --review <lens>`.
- In Workbench, the detail pane shows "Review <culture>" toggles for each flag, and a check
  finding offers "Accept as intended".

### Key changes

A small edit, a reference change or a cherry-pick can give text a new key. Unreal then treats it
as new text, and its next gather drops the earlier key's translations from the archives. Game Text
pairs the earlier key with the new one, strictly one to one, in this order:

1. **Same place**: the same asset property or DataTable cell (Unreal's manifest path is the object
   path followed by the property chain).
2. **Same text in the same asset**, for example a renamed String Table entry.
3. **Same text, unique in the project**, for text that moved.

When more than one candidate matches, nothing is paired and the change is counted as ambiguous.
Before a gather this works for saved asset text: the earlier key still in the manifest is "Not
found in the project" and the new key is "Not gathered yet". C++ and config text is not in the
saved scan; it pairs across a gather UE Shed runs.

- In Workbench, **Key changed** lists the new keys. The detail pane shows the earlier key, how it
  was paired, any text change, and the translations the earlier key shipped.
- **Carry translations** stages those translations for the new key, as hand edits are staged. The
  staged panel then guides the steps: gather, export, **Write to PO**, then sync. When the text
  changed too, the action reads **Carry anyway**, because the translations were written for the
  earlier text.
- A change's previous translation matches whether it was absent or empty, so an edit staged
  before the gather is still current after it (ADR 0009 addendum).
- **Gather and export** (`ue-shed loc run prepare`) runs Unreal's gather, then its PO export, in
  one GatherText process. Dashboard targets run their Gather and Export configs; a config-only
  target needs one recipe that gathers, writes the manifest and exports.
- When UE Shed runs a gather, it keeps the target's translations from before the run and pairs
  keys that left the manifest with keys that joined it. This covers C++ and config text, such as
  a cherry-picked `LOCTEXT` change. Workbench shows those pairs under **Key changed** until the
  next gather.
- `ue-shed loc run gather|prepare <project-root> --target <name> --carry <new-file.json>` writes
  the carried translations as a change set for the new keys, then prints a `carry` summary (keys,
  changes, keys whose text also changed and were left out, ambiguous keys). Apply it with
  `loc apply --changes <file> --sync`, after an export if only gather ran.
- A gather run outside UE Shed loses those translations: Unreal trims them from the archives and
  the next export drops them from the PO files. Baseline comparison still reports the key change.
- **Compare with baseline** pairs keys the same way, by manifest place and then by identical
  source, and reports them as key changes rather than new and removed lines. Reports reads
  "since then N new · N removed · N key changed · N source changed".
- `ue-shed loc status --key-changed` lists them from the CLI; each line carries `keyChange`.

### One spreadsheet with every language

Teams that keep a spreadsheet beside Unreal often keep one file per language, with lines missing
or sorted differently. The all-languages CSV replaces those files:

- one row per line, with Namespace, Key, Source, Where (the first location, plus a count of the
  others) and Kind (String table, Data table, Asset, C++ or Other source);
- then, native culture first and then the target's culture order, each culture's translation that
  ships next and its state, in writer language;
- missing translations as empty cells, so every language lines up by key;
- rows in a stable order by namespace and key, the same on every machine.

It exports what the list shows, with the same state, review, key-change, origin, path and
changed-file filters. In Workbench it is **Export → All languages (CSV)** while a target is
selected; from the CLI, `ue-shed loc export <project-root> --target <name> --output <new.csv>`
takes the `loc status` filters and never overwrites a file. The CSV is for reading and sharing,
with the usual spreadsheet protections (UTF-8 BOM, CRLF, a leading apostrophe before formula
characters). Edits still go through PO change sets.

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

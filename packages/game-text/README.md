# `@ue-shed/game-text`

The application must provide `effect@^4.0.0` as a peer dependency. Reuse one compatible
Effect installation across the application and UE Shed libraries.

Headless saved-package corpus discovery and search for player-facing Unreal Engine text. The
package keeps Unreal namespace/key identity distinct from occurrence identity, reports scan
coverage, and returns bounded search and focus results. Saved packages are evidence only; this
package does not mutate assets.

Each occurrence retains saved translator notes as `devNotes`. UE 5.8 keyed text and StringTable
entries can supply them; older packages and empty notes produce `""`. Notes stay separate from the
source string and localization identity.

## Install

The Node entry point requires Node 22.15.x or later in the 22.x line, or Node 23.8.0 and newer,
including Node 24 and 26. Earlier runtimes lack the built-in Zstd APIs used by the compact index.

Pin the package and the host's Effect runtime exactly:

```sh
npm install --save-exact @ue-shed/game-text "effect@^4.0.0"
```

`@ue-shed/unreal-assets` is a normal package dependency. It remains a separate artifact and is not
bundled into Game Text. A saved-asset reader executable is also required at runtime, but it is not a
JavaScript dependency of this package. Install the default launcher separately:

```sh
npm install --save-exact @ue-shed/uasset
```

Alternatively, configure `assetReaderLayer({ executable })` with another compatible `uasset-io`
producer. The reader library never downloads an executable or falls back to a source checkout.

## Host usage

For persistent indexing, compose `GameTextIndexBuilderLive` from `@ue-shed/game-text/index` with
the host's source and localization evidence layers. CLI and Workbench use the complete TypeScript
builder and query implementation. The separate `AssetReader` still supplies native saved-package
extraction. The native writer is experimental and requires explicit `nativeIndexBuilderLayer`
selection; it is not a complete native query engine. See the
[native preparation guide](../../docs/engineering/native-game-text-index.md).

Compose `TextCorpusServiceLive` with one scoped `AssetReader` layer in the trusted Node host. Keep
the resulting corpus and `textCorpusQuery(corpus)` model in that host, and send only bounded summary,
search, and focus results over the host's validated transport.

Use `scanFromProjectIndex` when the host already maintains a saved-project header index. Otherwise,
`scan` performs its own bounded project scan. Both paths preserve coverage and typed recovery
guidance.

## Entry points

Import from a focused entry point. Each lists its exports by name; modules no entry point names
are private to the package.

| Entry point                    | Runtime      | Contents                                                                                      |
| ------------------------------ | ------------ | --------------------------------------------------------------------------------------------- |
| `@ue-shed/game-text/schema`    | browser-safe | Wire schemas, identifiers, check and rule ids, operation requests                             |
| `@ue-shed/game-text/rules`     | browser-safe | Rule documents, starter rules, audience and origin policy, word counting                      |
| `@ue-shed/game-text/checks`    | browser-safe | Check catalogue and scopes, custom checks, the gate, text problems, Unreal text syntax        |
| `@ue-shed/game-text/labels`    | browser-safe | Display labels for states, problems, audiences, origins and quality                           |
| `@ue-shed/game-text/corpus`    | browser-safe | Corpus queries, search, localization join, reports, CSV, edits and package text diffs         |
| `@ue-shed/game-text/index`     | Node         | `TextCorpus`, index layers/builders, workers, rules-file IO, progress and Unreal text actions |
| `@ue-shed/game-text/workspace` | Node         | Workspace and localization operations with selected-project and file hooks                    |

The browser-safe entry points do not expose filesystem, process, Electron, Perforce, or Unreal
authority. The root `@ue-shed/game-text` and `@ue-shed/game-text/browser` aggregates still re-export
the public names for one release and are deprecated. The compact snapshot codec, `SnapshotStore`,
`SharedIndex`, joined-target readers, package-text storage/columns and cold-pool modules are private;
`SnapshotStoreError` and `SnapshotFormatError` stay exported from `/index` because public index
signatures name them.

The index keeps its data in a compact snapshot format behind a private `SnapshotStore`; neither is
part of the public API. Compact-index hosts use
persistent package, localization and joined layers, bounded queries and lazy object projections;
the in-memory corpus API remains available for batch consumers. See the
[snapshot engineering guide](../../docs/engineering/game-text-snapshots.md) for the format, caps,
immutable publication and recovery behavior. `reader.domain()` bulk-loads one source, identity,
translation or path domain; `reader.strings()` keeps page reads limited to touched blocks.
The private shared index shares package extraction and one deduplicated string ID space across
explicit source and localization views. Each view keeps
independent joined pointers; omitting `projectView` retains the separate-store behavior.
Localization imports use independent content keys, immutable string segments and atomic
generation publication; compaction remaps active layers while existing readers retain their handles.
Strings use immutable A64 segments: byte-sorted ranks, front coding in 64-string blocks, a sparse
index and binary GUIDs with exact case recovery. Refresh reuses the previous file's string IDs and
probes only unresolved strings. `reader.range(prefix)` returns matching ID ranges per segment.

Search pages include fixed-size `counts` for the current source query, capability, review filter,
and `withoutNotes` toggle. `counts.all` equals the page's full `total`, independent of pagination.
Review counts intersect every active filter; a toggle's count excludes that toggle itself so callers
can show how many lines are available when it is enabled. Notes match only when every saved location
has empty notes after trimming. An omitted `withoutNotes` means false.

Compact-index hosts can select worker search with
`gameTextIndexRefreshLayer(cacheRoot, { searchWorker: true })`. The retained result's
`search(request)` returns an Effect and keeps scans off the caller's thread. Its scope closes
the worker and pinned reader together. `latestSearchOnly: true` cancels replaced pages and older
filter selections while preserving concurrent group pages;
independent callers should leave it false. Cancellation does not evict completed query results.
The synchronous `query.search(request)` API remains available. With a search worker, the worker
prepares the generation's query once, off the caller's thread, and the synchronous `query`
methods borrow it: each call blocks the caller until the worker answers, and can wait behind a
running search. A synchronous call waits at most 100 ms for the worker (configurable through
`syncCallTimeoutMs` on the refresh and steps layers). If that deadline expires, the worker is
retired and the call uses a local query over the model's pinned generation. Later synchronous
calls reuse that local query. This also covers worker loss before its exit callback can run;
a busy worker can take the same fallback. Asynchronous searches retain their 30-second deadline.

`qualityWorker: true` runs `localizationQuality` scans in a worker per opened model, started by
the first scan. The caller keeps the findings' facts and groups; `items`, `find`, `lineOfUnit`
and `sourceKeyOfUnit` block the caller while the worker reads them, and the worker keeps a scan
until both its `findings` and `metadata` objects are collected. Interrupting a scan cancels it in
the worker. If the worker cannot start or fails, the scan runs on the caller's thread instead.

For host-owned composition, use `GameTextIndexSteps` from `gameTextIndexStepsLayer(cacheRoot)`:

```ts
const steps = yield * GameTextIndexSteps;
const project = yield * steps.refreshProject({ projectRoot });
const imported = yield * steps.importTarget(project, { targetName });
const target = yield * steps.buildTarget(project, imported);
const model = yield * steps.openTarget(target);
```

Reuse `project` for additional targets; target preparation does not enumerate or extract packages.
`openProject({ projectRoot })` creates a project handle without discovery, so localization can be
imported and validated before `refreshProject`. Pass the resulting verified revision to
`buildTarget`. The steps layer requires `GameTextIndexSource`, `LocalizationEvidence`, and
`GameTextIndexBuilder`; the Node source and TypeScript builder layers provide the default backends.
Project/import/build handles are trusted, process-local values, not transport or durable job schemas.
Each write step owns and releases its lease. Stale package revisions or superseded localization
publications fail with recovery guidance; opening a model pins its reader in the caller's scope.
The compatibility `GameTextIndexRefresh.refresh()` composes these same steps.

Hosts can replace `typeScriptIndexBuilderLayer` with
`nativeIndexBuilderLayer(readerConfiguration)` to opt into native dictionary, publication and
join construction through uasset-io protocol 1.13. Package extraction, localization import and
JavaScript queries keep their existing interfaces. See the
[native preparation guide](../../docs/engineering/native-game-text-index.md) for composition,
incremental eligibility, limits and measurement scope. The default builder remains TypeScript.

Retained desktop models separate preparation from publication. `makeRetainedGameTextIndex()`
returns `refresh` and `release`; prepare inside an operation scope, publish the result and run
its `retain` effect together, then borrow it in each operation that reads lazy projections.
`makeRetainedGameTextIndexWith(prepare)` accepts the host's composition with the same ownership rules.
Active borrowers keep the previous reader and worker alive through replacement. Rejected
preparations leave the published model usable. See `ADOPTING.md` for the ownership contract.
The raw indexed corpus includes empty-source units; searchable exports keep their visibility rules.

Validated target handles and opened models may supply `queryRevision`. Treat it as opaque and
compare it only within the same project, cache and backend after validating current target inputs.
Never construct or parse it, persist it as a durable ID, or assume its encoding survives a release.
Adapters without the identity retain the normal preparation path.

`summary().counts` uses that same query path with no active filters. `summary().searchable` counts
only lines with searchable source and their saved locations. `TextCorpus.coverage` retains raw scan
provenance, including empty FText values; it is not a count of writer-visible lines. Character counts
in search, checks and human CSV use JavaScript string length (UTF-16 code units).

`gameTextCsv(corpus)` produces one human-readable row per saved location of each searchable line.
Pass the full scan as its optional second argument when exporting a filtered corpus to retain the
same review signals shown in search.
`gameTextQualityCsv(report, corpus)` produces one row per finding and affected location. Both are
browser-safe, quote every cell, protect spreadsheet formulas, and include a UTF-8 BOM and final CRLF.
`gameTextInvestigationCsv` keeps its provenance-oriented layout, and `exportGameTextInvestigation`
remains the JSON provenance document.

Localization quality investigation presets and exports use schema version 2 and retain
`workspaceFilter`, target and culture. Older readers reject these documents instead of dropping
the finding selection. Version-1 corpus and source quality investigations remain readable and
keep their version when replayed. A version-1 preset cannot carry `workspaceFilter`, and an export
uses the same version as its preset.

### Source quality over the index

`evaluateGameTextSourceQuality(corpus, ruleDocument)` evaluates source rules over a corpus in
memory, and `textQualityQuery(report)` pages it. An opened index model's
`sourceQuality(ruleDocument)` returns that same `TextQualityQuery` from the index,
without building the corpus's units: the same summary, role and rule counts, pages, cursors,
focus, export and finding IDs. Hosts with an index replace
`textQualityQuery(evaluateGameTextSourceQuality(result.corpus, document))` with
`yield* result.sourceQuality(document)`. Every index result has `sourceQuality` and
`localizationQuality`; an adapter without an index implements them with the in-memory functions.
`indexedSourceQuality(joined, corpus, ruleDocument)` is the same scan over a pinned joined reader.

The scan reads text units in report order, in pages of up to 256 units or 1,024 occurrences, and
yields between pages, so it can be interrupted. Roles match each occurrence's stored location;
only occurrences a rule's role selects have their source read. Each finding is kept as its rule,
unit, place among the unit's findings and ID hash, 18 bytes. Search pages, focus and export
rebuild only the findings they return from their units and check each against its hash; `export`
rebuilds every matching finding, in batches. The scan reports `source_quality` events to
`GameTextIndexProgressReporter` (`{ phase, completed, total, findings }`): once before the scan
with nothing checked and `total` already known, then after each page, the last with every unit
checked and the scan's finding count.

Roles match a place by its own location, in memory and over the index alike. A folded Blueprint
place's copies (`occurrence.copies`) never match by their compiled paths (`X_C`, `X_C.Name_INST`,
`Default__X_C`, `SKEL_X_C`): the place is the authored site and holds the line's text. Write roles
against authored paths. A site saved only under a generated class has no authored site and stays a
place at its compiled path, where object path roles match it.

`textQualityQueryOf(report, list)` builds the query over any `TextQualityFindingList`, a report's
findings by position that may be rebuilt on demand.

`STARTER_GAME_TEXT_RULES` contains neutral v1 examples to customize. A trusted Node host can use
`createStarterTextRules(projectRoot, output?)` to create it exclusively, or use the CLI:

```sh
ue-shed text rules init <project-root> [--output <file>]
```

The default is `Config/UEShed/GameTextRules.json` under the project root. Relative output overrides
also resolve under the project root. Existing files produce `TextRulesFileError` and are never
overwritten.

See [ADOPTING.md](ADOPTING.md) and [adoption.manifest.json](adoption.manifest.json) when integrating
Game Text into an established trusted host.

## Player and editor text

Every `TextOccurrence` from a scan or the index carries `audience` (`player`, `editor` or
`unknown`), `audienceReason` and, for policy matches, `audienceRule`. The reader's gather-table
editor-only bit (uasset-io 1.11 `gather_editor_only`) decides first; otherwise the first matching
row of `TEXT_AUDIENCE_POLICY` does; otherwise the text is `unknown`. Units, search results
(`TextUnitSearchResult.audience`) and localization lines (`LocalizationLine.audience`) roll their
visible occurrences up: player if any is, else unknown if any is, else editor.

```ts
// Hide editor text, and count lines by audience.
query.search({
	query: "",
	capability: "all",
	pageSize: 50,
	filter: [{ field: "audience", op: "is_not", values: ["editor"] }],
	facets: { audiences: true }
});
```

`group: "audience"` groups by it, and `gameTextCsv` and `localizationLinesCsv` have an Audience
column. With a target that does not gather editor-only data (`ShouldGatherFromEditorOnlyData`,
false by default), a line that would be `not_gathered` and whose every in-scope place is editor
text is `outside_target` with `outOfScope: "editor_only_data_not_gathered"`; developer-folder text
stays in scope. `classifyTextAudience`, `classifySavedTextAudience`, `occurrenceTextAudience`,
`lineTextAudience`, `textGatherScope` and `localizationGathersEditorOnlyData` are exported for
hosts.

The policy table, first match wins, editor rows first:

| Rule                                                                               | Audience | Match                                                                                    |
| ---------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `developers_folder`, `dev_folder`                                                  | editor   | package under `/Game/Developers/` or `/Game/Dev/`                                        |
| `uobject_tooltips`, `uobject_display_names`, `uobject_categories`                  | editor   | namespace `UObjectToolTips`, `…DisplayNames`, `…Categories`                              |
| `k2_node`, `anim_graph_node`, `anim_state_node`, `ed_graph`, `scs_node`            | editor   | object or class `K2Node_*`, `AnimGraphNode_*`, `AnimStateNode*`, `EdGraph*`, `SCS_Node*` |
| `niagara_node`, `niagara_graph`, `material_expression`, `material_graph`           | editor   | object or class `NiagaraNode*`, `NiagaraGraph*`, `MaterialExpression*`, `MaterialGraph*` |
| `editor_module`, `unreal_ed_module`, `blueprint_graph_module`, `anim_graph_module` | editor   | class module `*Editor`, `UnrealEd`, `BlueprintGraph`, `AnimGraph`                        |
| `property_tooltip`, `tooltip`, `pin_tooltip`                                       | editor   | property leaf `PropertyTooltip`, `ToolTip`, `PinToolTip`                                 |
| `category`, `category_name`, `palette_category`                                    | editor   | property leaf `Category`, `CategoryName`, `PaletteCategory`                              |
| `niagara_version_data`, `niagara_cached_script_vm`                                 | editor   | module `Niagara`, inside `VersionData` or `CachedScriptVM`                               |
| `objects_to_display_names`, `niagara_signature_description`                        | editor   | property `ObjectsToDisplayNames`, path ending `Signature.Description`                    |
| `movie_scene_display_name`, `movie_scene_tracks_display_name`                      | editor   | module `MovieScene` or `MovieSceneTracks`, leaf `DisplayName`                            |
| `string_table`, `data_table`                                                       | player   | String Table entry, DataTable cell                                                       |
| `user_defined_enum_display_name`                                                   | player   | class `UserDefinedEnum`, leaf `DisplayNameMap`                                           |
| `widget_tree`                                                                      | player   | object `WidgetTree` in the outer chain                                                   |
| `script_bytecode`                                                                  | player   | property `ScriptBytecode` (a compiled Blueprint function's text literals)                |

See [player and editor text](../../docs/products/game-text.md#player-and-editor-text) for each
row's reason and evidence. Changing the table re-encodes stored index shards from their saved
evidence; packages are not read again.

## Read-only localization

`joinLocalizationTarget(corpus, evidence, target)` joins Unreal namespace and key only. String Table
references resolve through the corpus's table namespace. Equal source strings never link identities.
Each line has every culture's primary state, secondary facts, typed unknown reasons, archive
translation, differing PO translation, PO context, and manifest locations and metadata. Native
cultures use their archive as evidence. String Table `Comment` metadata and 5.8 developer notes
both reach `devNotes`; distinct notes are separated by a blank line.

Supply the join as `textCorpusQuery(corpus, scannedAt, joined)`'s optional third argument. Search
requests accept `localization: { target, culture?, state?, searchTranslations? }`. Translation
search requires a selected culture and explicit opt-in. `page.localization.lines` is the unified,
bounded page, including gathered-only evidence and compact culture marks. `page.units` retains
corpus-only previews for existing hosts. Pass `page.localization.nextCursor` as `localizationCursor`
for subsequent pages. `localizationFocus(lineId)` returns every culture and full evidence for either
kind of line; ordinary corpus `focus` also includes localization details. Evidence-only IDs have a
distinct `LocalizationEvidenceLineId` brand and never masquerade as `TextUnitId`.

Precedence: `outside_target`, `not_gathered`, `not_found`, `gathered_only`, `changed_since_gather`,
`unknown`, `not_synced`, `needs_update`, `not_translated`, `translated`. Structural facts come first;
uncertainty blocks unsupported translation claims. A non-empty PO translation differing from the
archive precedes an outdated archive. All applicable facts remain available. Crowdin identity PO
retains its reduced source-checking mark.

Optional package completion records preserve compatibility with older corpora. Without them,
absence is unknown. Missing/duplicate file evidence, unresolved identities, conflicting sources,
unavailable gather settings/class ancestry and unscanned or partial packages have typed reasons.
Unreal wildcard matching and ranked path filters determine scope. Native archives are never
synthesized.

`localizationStatusReport` exposes schema-versioned counts, coverage, file provenance and diagnostics.
State counts and source word counts intersect every search filter, including the state filter,
before pagination. Every culture receives zero counts when no lines match. Diagnostics are capped at 200, with
`diagnosticCount`, `diagnosticCounts` by code and `diagnosticsOmitted` retaining whole-scan totals.
`packageCoverage` contains `counts` by status, at most 200 non-complete `packages`, and `omitted`.
Progress reports share both bounds; quality reports and investigations share the diagnostic bound.
`--limit` controls only the matching-line page. `text scan` returns the entire corpus by design.

```sh
ue-shed loc status <project-root> --target <name> [--culture <c>] [--state <s>] [--limit 50]
ue-shed text search <project-root> <query> --target <name> [--culture <c>] [--state <s>] [--search-translations]
```

Both entries export the pure schemas and functions. Node IO stays in `@ue-shed/localization` and
the saved-package reader. These surfaces never write project files or run localization commandlets.

## Built-in localization checks

`checkLocalizationTarget(corpus, joined, evidence, options?, ruleDocument?)` is browser-safe and
pure. It returns `LocalizationQualityReport`, an additive variant of the existing quality report
with culture and identity findings, structured evidence, saved occurrences, manifest locations,
file provenance/diagnostics and unchanged corpus coverage. Source-quality reports share the bounded corpus diagnostics and their totals. Gathered-only findings have empty saved-occurrence lists and evidence line IDs.

Check IDs are stable string literals: `LocalizationCheckId` for checks of a translation against its
source and `SourceCheckId` for checks of the source itself; `BuiltInCheckId` is both. Review files
record them as `localization.<id>`. Pass `{ culture?, checks?, disabledChecks? }` to select them.
They need no rule document. A version-3 `Config/UEShed/GameTextRules.json` sets each check's
policy under `checks`, keyed by check ID: `enabled`, `severity` (`blocking`, `normal` or `low`),
`scope` and `params` (the catalogue's parameters; unlisted fields keep their defaults). `preset`
is `default` (every check runs with its catalogue severity) or `none` (only the checks the file
enables run). Version 3 rejects unknown keys, so a misspelt check or parameter is an
`invalid_structure` error rather than ignored. Version 2 adds per-culture project policy and
progress reports, described below, and version 3 keeps them.

```json
{
	"schemaVersion": 3,
	"roles": [],
	"rules": [],
	"checks": {
		"length_outlier": { "severity": "low", "params": { "maximumRatio": 4 } },
		"segment_separator": { "params": { "separator": "//" } },
		"missing_translator_notes": { "enabled": false }
	}
}
```

V1 and v2 files keep loading: their `disabledLocalizationChecks` (any built-in ID),
`segmentSeparator`, `optionalTags` and `optionalArguments` read as the equivalent v3 settings
(`enabled: false`; `segment_separator`'s `separator`; the `optionalTags` of `rich_text_tags` and
`rich_text_tags_added`; the `optionalArguments` of those two, `format_arguments`,
`format_argument_renamed` and `rich_text_tag_case`). `migrateGameTextRuleDocument(document)`
writes a v1 or v2 file as v3 with the same behaviour, and `resolveLocalizationChecks(document)`
returns each check's resolved `enabled`, `severity`, `scope` and `params`. Every check is on by
default, except `segment_separator` until it has a separator. The host's `checks` and
`disabledChecks` options still narrow what runs.

A check's `scope` limits where its findings are reported. Every listed dimension must hold: the
finding's culture is one of `cultures`, and one saved place of its line is both at a place of one
of `roles` (the file's roles) and under one of `pathPrefixes` (object paths, compared as written).
A finding without a saved place, such as gathered-only text, is outside any `roles` or
`pathPrefixes` scope. Scope is applied after a check finds something, so a line's saved places are
read only for scoped findings. Where one check's finding takes the place of another's (a
placeholder translation instead of its length, missing tags instead of added ones, a rename
instead of a dropped and an added argument), the first check takes it only when it runs and is in
scope for the line and culture; otherwise the second reports it.

A version-3 file can define its own checks in `customChecks` (up to 512), reported beside the
built-in ones with the same evidence, review and workspace model. Each has an `id` (its rule ID,
unique among the file's rules and not starting with `localization.`), a `label`, an optional
`severity` (`normal` when absent) and `scope`, a `recovery` text and a `subject`: `source` checks
a keyed line's source once, under its source culture; `translation` checks each culture's shipped
translation, the native culture aside. The kinds are:

- `pattern`: text a JavaScript regular expression (Unicode mode; `caseSensitive: false` adds the
  `i` flag) matches, or with `report: "no_match"` text it does not match. A pattern that does not
  compile is an `invalid_structure` error.
- `length`: text shorter than `minimum` or longer than `maximum` (at least one, in order), in
  `visible` characters as `length_outlier` measures them or code point `characters`.
- `forbidden_term`: text using one of `terms`, matched as the terminology rules match terms.

Custom checks evaluate present text, including empty and whitespace-only strings; absent
translations are skipped. Zero-width regex matches count as matches without highlight spans.
Pattern evidence examines at most 16 matches, including zero-width matches; `no_match` stops at
the first match.

```json
{
	"customChecks": [
		{
			"id": "no-wip",
			"label": "Work in progress",
			"kind": "pattern",
			"subject": "source",
			"pattern": "\\bWIP\\b",
			"severity": "blocking",
			"recovery": "Replace the marker with final text."
		}
	]
}
```

Their findings are `LocalizationCustomFinding`s (`kind: "custom"`, with `check`, `label`,
`subject`, `actual.text` and its `matches` or `length`). Reports list the checks in
`customChecks` and count them in `rules`. A custom check's workspace filter is `custom.<id>`
(`customQualityFilter(id)`); `WorkspaceQualityFilter` accepts it beside the built-in filters
(`BuiltInQualityFilter`), pages list the file's checks in `customFilters` and count each under
`counts["custom.<id>"]`, and `workspaceQualityLabel(filter, labels)` names one. Indexed scans keep
each finding's rule in its own column, so the number of rules and custom checks is no longer
limited by the packed facts.

`localizationCheckCatalogue` describes every built-in check: its `basis` (`unreal` when the
finding states what Unreal does with the text, so only its severity and whether it runs are the
project's; `heuristic` when it is a judgment with thresholds or word lists), its `label`, its
default `severity`, its parameter schema (`params`, every field defaulted, so `{}` decodes to
`defaults`) and a `condition` text generated from its parameters. `localizationRuleId(id)` and
`parseLocalizationRuleId(ruleId)` convert between a check and the `localization.<id>` rule ID its
findings and review marks record. The table below is generated from the catalogue.

Every localization finding has a `severity`: the rule file's `severity` for its check, or the
catalogue's (the table's column) when the file sets none: `blocking` (players see wrong or
untranslated text), `normal` or `low`. Version-2 and version-3 `localizationRules` may set their
own `severity` too (`normal` when absent). Severity is never part of the finding's ID. Indexed
scans store each finding's severity beside its other facts, so workspace pages list blocking
findings first, then normal, then low, each in report order, and count findings by severity in
`severityCounts` from what the scan reported, not from the check's default; summaries, focus and
CSV exports carry the severity.

<!-- check table: generated from localizationCheckCatalogue; do not edit -->

| Check                         | Basis     | Severity | Reports                                                                                                                                            |
| ----------------------------- | --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format_arguments`            | unreal    | normal   | Source arguments the translation drops, or arguments it adds                                                                                       |
| `argument_modifiers`          | unreal    | normal   | Plural, ordinal, gender and Hangul modifier syntax and forms                                                                                       |
| `rich_text`                   | unreal    | normal   | Unbalanced tags, as Unreal's compile validator counts them                                                                                         |
| `po_escape_safety`            | unreal    | normal   | Literal `\n`, `\r`, `\t` that Unreal's PO round trip turns into control characters                                                                 |
| `whitespace`                  | unreal    | normal   | Leading or trailing whitespace that differs from the source, or unsafe edge spaces                                                                 |
| `empty_translation`           | unreal    | normal   | An existing empty PO or archive entry                                                                                                              |
| `missing_translator_notes`    | heuristic | low      | No translator notes on any occurrence or manifest entry                                                                                            |
| `duplicate_source`            | heuristic | low      | The same source text under different keys                                                                                                          |
| `format_argument_renamed`     | unreal    | normal   | A dropped and an added argument paired in order, as `{qty}` → `{qté}`; one rename stages a change                                                  |
| `rich_text_tags`              | unreal    | normal   | Tags (`<b>…</>`, `<Name>…</>`, `<img/>`) the translation drops, compared without case                                                              |
| `rich_text_tag_case`          | heuristic | low      | The same tag in another case, as `<italic>` for `<Italic>`; Slate matches names without case                                                       |
| `line_breaks`                 | heuristic | normal   | A different number of line breaks inside the text than the source; edges are `whitespace`'s                                                        |
| `segment_separator`           | heuristic | normal   | The `separator` parameter used a different number of times than in the source; off until it is set                                                 |
| `length_outlier`              | heuristic | normal   | A translation under a third (zh, ja, ko, th: a quarter) or over three times the source's length, for a source of 20 or more visible characters     |
| `outdated_translation`        | unreal    | blocking | An archive translation recorded for older source text; Unreal ships the source instead                                                             |
| `inconsistent_translation`    | heuristic | normal   | Short shared source text (3 or more visible characters, up to four words) translated differently in one culture                                    |
| `rich_text_tags_added`        | heuristic | low      | Tags the translation adds and drops none                                                                                                           |
| `source_line_endings_changed` | unreal    | low      | An archive translation recorded for the same source with other line endings (`\r\n`, `\n`)                                                         |
| `placeholder_translation`     | heuristic | normal   | A translation that is only one of 13 placeholder words (such as "skip" or "TODO"), or only punctuation ("...") for a source of three words or more |
| `culture_invariant_text`      | heuristic | low      | Culture-invariant player text in a property that is localizable elsewhere: never translated                                                        |
| `placeholder_text`            | heuristic | normal   | `TODO`, `TBD`, `FIXME` (as written), "lorem ipsum", "to be translated", "placeholder" (any case)                                                   |
| `source_whitespace`           | heuristic | low      | Whitespace at either end of a gathered source, or doubled spaces inside it                                                                         |
| `source_markup`               | unreal    | normal   | Unclosed rich-text tags, `</Name>` closings or unpaired format braces in the source                                                                |
| `number_only_text`            | heuristic | low      | Localizable text with digits and no letters or arguments, which could be culture invariant                                                         |
| `string_table_key_collision`  | unreal    | normal   | One namespace and key declared by more than one String Table                                                                                       |

<!-- end of check table -->

`missing_translator_notes`, `duplicate_source` and the `SourceCheckId` checks are facts about the
source line. Each reports once per line, under the target's native culture (or the line's first
culture in the target by code), so a selected non-native culture does not show them.
`duplicate_source` reports once per shared text, on the line whose identity sorts first, and leaves
out text without letters. `culture_invariant_text` findings have no identity (`identity: null`), so
they cannot be accepted in a review file. Most culture-invariant text is invariant on purpose, so it
is reported only for a saved place that is not editor text (by its audience), not in a package
whose path has "debug" in it and not a text render component (world-space labels, mostly debug
names and distances), and only in a
property (a class's property path, or a DataTable's column, without container indexes) that holds
at least as much keyed or String Table text in the project as invariant text in such places. A
column of backer names with a few localized headings, or a label no one localizes, is left alone.
The localization report keeps every placeholder: it never holds source findings, and `loc check`
prints only it. A workspace that lists both (`localizationQualityWorkspace(Of)` with a source
report) shows a placeholder once: a `placeholder_text` finding whose every placeholder a source
terminology finding already marks in the same text of one of its places is left out of pages,
counts and exports, and one with others left names only those in its summary. The starter rules
forbid "placeholder", so without this such text appeared twice. The check records this on the
finding (`unreportedMatches`: the placeholders the rule file's terminology leaves, empty when it
leaves none), and the indexed scan keeps it as a fact, so building a workspace reads no finding;
the workspace expects its source report to come from the same rule document. `placeholder_translation` leaves
out the native culture, a translation equal to its source, a
source that is itself a placeholder, and punctuation-only answers ("...") to a source under three
words, which can be a silent reply. The source checks skip Blueprint bytecode fragments (manifest entries
`… [Script Bytecode]`, the pieces of joined text the gather records); `source_whitespace` also skips
lines the gather does not collect. `source_markup` reads tags as Slate does: attributes are
`name="value"` pairs, `<{Argument}>` opens a tag, and a tag right after an ASCII letter, digit or
underscore is code (`GetSubsystem<UMySubsystem>()`).

Shape checks leave an empty translation to `empty_translation`. The tag checks take
`optionalTags`, tag names a translation may add or leave out (compared without case), and the
argument and tag checks take `optionalArguments`, argument names the game always supplies: a
translation may add them, and the tags that wrap only such an argument
(`<PlayerName>{ParentLabel}</>`), without a finding. An optional argument does not pair with a
dropped one as a rename.

`length_outlier` measures visible length: rich-text tags, argument modifiers and `{arguments}`
removed, whitespace runs counted once; East Asian wide characters count two. A source shorter than
20 visible characters is not checked. `inconsistent_translation` groups lines by source text, like
`duplicate_source`, but only sources with letters, at least three visible characters and at most
four words. Per culture other than the native one it counts each line's shipped translation,
grouping translations that differ only in case, whitespace, punctuation or symbols, and reports,
once per line, every line whose translation is not the single most used one. When most lines ship
the source untranslated, it reports those lines instead (`untranslated: true`), unless fewer than
half as many lines translate it: then the culture keeps the text untranslated on purpose, as
internal labels often are, and nothing is reported. When the most used translations tie, it reports
nothing. The finding lists the five most used translations with their
line counts. An indexed scan counts them in a second pass over the shared lines only, before the
main pass. A translated source whose recorded text differs from the current one only in line
endings is `source_line_endings_changed`, not `outdated_translation`.

A key with conflicting saved texts (`conflicting_source`) is never checked or grouped as the join's
joined text: its findings carry the distinct texts in `sourceVariants`, workspace summaries and
focus list them, and without a manifest source its translation is not compared.

Checks use the pending non-empty PO text when the culture has a `not_synced` fact, otherwise archive
text. They compare with manifest source, falling back to corpus source with a diagnostic. Crowdin
uses manifest source too. Empty PO/archive entries are reported independently of missing files.
`checkDiagnostics` retain the join's unknown reasons and Crowdin's reduced checking, and explain
unavailable source/translation, unsupported cultures and syntax limits.
Syntax is capped at one million code units and 16 nested modifier forms. Coverage is not upgraded
when a syntax check succeeds on a partial corpus.

An opened index model's `localizationQuality(ruleDocument?, options?)` runs the same checks over the
index in pages of 256 lines, yielding between pages. Like `sourceQuality`, it takes the rule
document first. It reports `localization_quality` events to `GameTextIndexProgressReporter`: once
before the scan with `completed: 0` and `total` already known, then after each page, the last with
every line checked and the scan's finding count. Progress does not change findings, their order
or IDs.

**Progress.** Every Game Text operation reports progress the same way: provide
`GameTextIndexProgressReporter` around the operation with `Effect.provideService`. Index refreshes
report their build phases, `TextCorpusService` scans report `corpus` and quality scans report
`localization_quality` or `source_quality`, all as `{ phase, completed, total, findings? }`. The
reporter runs inside the operation, so keep it cheap and do not throw from it.

`parseUnrealFormatPattern`, `unrealPluralForms`, and `unrealRichTextCounts` expose the verified
Unreal grammar helpers. Required plural categories come from the identical ICU 64 category data
in the supported engines, rather than host `Intl.PluralRules`. Rich-text validation mirrors compile
tag counts, including tolerated source imbalance, self-closing tags and `<br>`. Unreal does not
validate matching argument names against source, missing/added modifiers, malformed parameters
that become literals, source-relative whitespace/line-break drift, empty entries, notes, duplicates
or PO escape safety; those additional checks are UE Shed findings.

Exactly one renamed argument, with nothing else dropped or added, can stage a rename in
`report.changes`; nested form renames preserve the grammar and revalidate the argument set. Each change records target, culture,
namespace/key, manifest source, current PO translation (archive fallback when absent), and proposed
translation. The report carries version-1 provenance. No check applies or writes a proposal.

```sh
ue-shed loc check <project-root> --target <name> [--culture <c>] [--check <id>]...
ue-shed loc check <project-root> --target <name> --changes suggestions.json
```

The CLI's optional `--changes` exclusively creates a new JSON proposal. It rejects existing files
and non-JSON destinations and never edits localization evidence. Engine-recorded validator tests
compare each shipped translation against both committed fixture oracles.

## Culture rules and progress reports

`TextQualityRuleDocumentV2` derives from the v1 document. `decodeGameTextRuleDocumentJson` accepts
both versions; the original v1 decoder and `evaluateTextQuality` retain their contracts.
`evaluateGameTextSourceQuality` and `text review` evaluate either version's source rules. `loc check`
combines translation policy and built-ins in the same report. The starter stays v1: choosing budgets
and glossaries for a culture requires project knowledge.

V2 adds `localizationRules`, an array of role-scoped rules. A `localization_character_budget` rule
has `cultures: { "de": 32, "fr": 36 }` and optional `defaultMaximumCharacters`. Without a default,
unlisted cultures have no budget. There are no multipliers. A `localization_terminology` rule has
`caseSensitive` and `cultures: { "de": [{ "kind": "forbidden", "term": "..." }] }`; preferred entries
reuse v1's `term` and `alternatives`. An unlisted culture has no glossary. Both check the shipped
translation selected by `localizationShippedTranslation`, count UTF-16 code units, and report the
same case-sensitive/insensitive substring matches and UTF-16 offsets as v1. Only occurrences
matching the role appear in policy evidence; gathered-only lines cannot acquire an asset role.

Unknown target cultures appear in `ruleDiagnostics` as warnings because rules are project-wide.
Duplicate culture keys (including escaped JSON keys), duplicate role/rule IDs, undeclared roles,
empty terms and non-positive budgets fail with typed recovery guidance. Both versions support
`disabledLocalizationChecks`, `segmentSeparator` (1–16 characters), `optionalTags` and
`optionalArguments`. See
[the v2 example](fixtures/quality-rules.v2.json) for an authored document; its limits and terms are
examples, not built-ins.

`localizationProgressReport(corpus, joined, evidence, baseline?)` is pure and browser-safe. It
reports every primary state's line/source-word counts, independent `notSynced` counts including
secondary facts, unknown reasons, reduced checking, corpus/package coverage and gather file
provenance/failures. `total`, `upToDateArchive` and `translatedPercent` describe non-optional manifest
identities, independent of current corpus source drift and pending PO edits. Source words are
counted once per identity/source, not once per location. Missing or ambiguous archive evidence
makes archive progress and percentages null. Reviewed/proofread are `not_tracked` until review
state exists; empty targets have null percentages.

Unreal's `FLocTextHelper::GetWordCountReport` counts ICU **line-break spans**, including punctuation
and format syntax. `localizationWordCount` uses the MIT [linebreak UAX #14 implementation](https://github.com/foliojs/linebreak),
exactly pinned to 1.1.0 and confined to `localization-words.ts`. Its published iterator and tables
use no Node APIs or file IO. In both UE 5.7 and 5.8, `GetWordCountReport` uses
`FBreakIterator::CreateLineBreakIterator` / `FICULineBreakIterator`: UAX #14 line-break opportunities
differ from `Intl.Segmenter` word tokens. `GenerateTextLocalizationReport` creates its helper with
an empty native culture: CSV progress requires a non-empty archive translation recorded against
the full manifest source for every culture. It does not use runtime native fallback or foreign
native-text overrides. Tests
compare both committed UE 5.7/5.8 CSVs directly (total/de/en/fr: 62/59/62/54), with no adjustments.
The portable iterator uses Unicode 13, whereas the engines use ICU 64; this is fixture parity,
not a claim of exhaustive parity for every Unicode version or ICU locale tailoring. Thai, Lao,
Khmer and Myanmar source require ICU dictionary breaking: they produce explicit
`dictionary_line_breaking_unavailable` diagnostics and null word totals instead of estimates.
They cannot be saved in a billing baseline until a matching dictionary counter is available.

`createLocalizationBaseline(corpus, evidence, createdAt)` creates a version-1 document containing
each non-optional identity, its SHA-256 fingerprint of canonical full manifest source (including
opaque metadata), and word count. Provenance names the target, time, corpus/evidence generation
fingerprints and input files. `decodeLocalizationBaselineJson` validates it;
`diffLocalizationBaselines(previous, current)` returns added, changed and removed entries/counts.
Changed-word billing uses the **current complete source** count, not the word difference. The same
source delta applies to each current target culture, regardless of translation progress. Removed
means absent from the current manifest; coverage accompanies the report and does not prove deletion
from an unscanned project. A mismatched target or conflicting manifest source fails explicitly.

```sh
ue-shed loc report <project-root> --target <name>
ue-shed loc report <project-root> --target <name> --save-baseline baseline.json
ue-shed loc report <project-root> --target <name> --baseline baseline.json
```

Only `--save-baseline` writes, exclusively to a new JSON file. Existing files are retained. These
APIs never write PO, manifests, archives, locres or locmeta. Workbench policy/report UI is a later slice.

## Capabilities

- Required: a project root containing saved packages and a configured saved-asset reader.
- Optional: a separate host capability may locate a selected occurrence in Unreal.
- Not required: Workbench, Perforce, a running editor, or any UE Shed Unreal plugin.

Plan 057's opt-in package-text reader preserves today's occurrence fields and aggregated coverage.
`textCorpusFromExtractionEvents` can hydrate either legacy events or v1.8 package records for
small callers and semantic oracles. `packageTextRecordsFromEvents` is a small-input migration/test
adapter; it retains pending occurrences and must not replay the 10× stream in memory. Production
native aggregation happens before transport. TextCorpusService still uses the legacy reader.
`importColdPackageTextLayer` prepares bounded record shards in workers and sorts their strings once
with the other shared-store inputs. `refreshPackageTextLayer` takes a complete, sorted signature
inventory and a selected-package reader stream. The caller supplies the Project Index's exact opaque
package-and-sidecar signature and header evidence from the same generation. It reads changed/new
eligible packages, reuses unchanged records, drops removed paths, and updates exclusions when
eligibility changes. All affected shards publish under one shared root. Occurrences and coverage
samples use shared source, identity and path IDs; excluded packages retain `not_gatherable` status.
`textCorpusFromPackageTextLayer` is the bounded fixture/Phase 5 oracle adapter.

`refreshJoinedTarget({ projectRoot, target, review?, fileErrors? })` runs under `SharedIndex` and
merges package and localization identities as shared IDs. It publishes line/culture state, review,
key-change, problem and facet columns. A matching dependency key returns `rebuilt: false`. Stable
source/PO edits update at most 8,192 affected lines in one flat overlay over a retained full layer;
this includes creating, editing and resolving source conflicts. Variable query source lists use
bounded row replacements (at most 8,192 rows and source IDs per raw/slice projection). Readers
reconstruct packed numeric columns without hydrating the whole join. These overlays use joined
metadata v4; full layers and older fixed-size overlays retain supported metadata v3. The physical
snapshot's WTF-8 format v4 is unchanged. Short-source, visibility and split-unit edits still use
a full merge, as do edits that exceed the overlay bounds.
The shared refresh service also reuses immutable query buffers by physical layer key across
incremental generations and decodes only newly needed source IDs for its eager search arena.
Patched values remain private to each query, and dictionary compaction or a changed full base
resets reuse. The source arena rebuilds when retained obsolete IDs or bytes exceed their bounds.
Identity, coverage, manifest/archive, review, generation and absence-candidate changes use a full
merge. `force: true` requests a full rebuild for validation. No authored file is written.
`openJoinedTarget` rejects stale inputs; `hydrateJoinedTarget(reader, start, maximum)` reconstructs
at most 10,000 oracle-shaped lines from their original file row references. `inspectJoinedTarget`
checks column references, culture completeness, key-change pairs and folder coverage. These APIs
are independent of Workbench. Existing host queries migrate in Phase 6.

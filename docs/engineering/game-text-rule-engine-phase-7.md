# Game Text rule engine: Phase 7 specification

Plan 059 Phase 7: findings become rows of the query engine. The Quality tab asks the same engine,
in the same filter language, as the Text tab. A host composes any filter, count and group from
fields, and UE Shed changes only when a new field is added.

Status: design. The owner settled §9's decisions on 2026-11-07. Nothing is built yet.

## 1. Why

Plan 059 decided that findings and quality checks stop being two things (decision 3). Phase 3
put findings in the engine, but as `findings_query`, a function with one option per filter
(`ix/rules/findings_query.rs`): `rules`, `severities`, `fixable`, `change`, `acceptance`, `line`,
`id`, and counts fixed to rule, severity and fixable. So every new Quality filter or count is a
UE Shed change and a release:

- #209 added a search (`lines: { text, where }`);
- #212 added pills (`lineFilter`) and fixed folder, asset, asset type, origin and audience counts.
  It is closed in favour of this phase.

The Text tab's query (Phase 3 §3, Phase 4 §6) is already the shape this needs: rows, a `where`
in the rule IR's grammar with facet marks, and parts. It isn't fully general either: its facets
are a fixed struct (`Facets` in `ix/engine_types.rs`) and its groups a fixed enum (`GroupBy`), so
a "count by namespace" is a UE Shed change too.

## 2. What doesn't change

- **The scan, the join and the index.** No new columns are stored, nothing is rescanned, and the
  store format is unchanged.
- **Rules.** Authoring, the rule IR, the three subjects, evaluation, incremental evaluation and
  the findings layer's contents are unchanged. **Finding identity is unchanged**, so review files
  keep working (Plan 059 STOP condition).
- **The Text tab's path.** Line and unit queries compile and run as today. The row-set compiler
  (`ix/engine_where.rs`), its atom cache and its 64 MiB budget are untouched. Every Text tab
  answer stays byte-identical (the fixture's Browse cases and the benchmark's page hashes), and
  its timings must not move (§7).
- **Custom rules keep their freedom.** A rule decides what it matches and what it reports. The
  query side sees what every finding has: its rule, severity, culture, subject, flags and text
  row. A rule's message and evidence stay its own and are never parsed. A filter names a rule by
  its ID, so a new rule needs no engine change. What would cost freedom is hard-coding rule kinds
  into queries; the check list's grouping of rules (`character_budget`, `terminology`) stays in
  TypeScript, outside the engine.

## 3. One list of fields

Fields are declared in three places today: `FIELDS` (what a `where` can test), `GroupBy` (what
rows group by) and `Facets` (what a page counts). They become one registry. Each field declares:

- its name and value type;
- the rows it belongs to: `line`, `unit`, `place`, `culture` or `finding`;
- whether it can **filter**, **group** and **count**.

| Field                                                    | Rows                | Filter | Group and count |
| -------------------------------------------------------- | ------------------- | ------ | --------------- |
| `paths` (folder)                                         | line, unit, place   | yes    | yes, by level   |
| `files` (asset), `assetTypes`, `origins`, `audience`     | line, unit, (place) | yes    | yes             |
| `namespace`                                              | line, unit          | yes    | yes (new count) |
| `sources`, `problems`, `findings`                        | line, unit          | yes    | yes             |
| `facts`, `editing`, `notes`, `translationKey`            | line, unit, (place) | yes    | as today        |
| `state`, `notSynced`, `review`                           | culture             | yes    | as today        |
| `keyChanged`, `id`                                       | line                | yes    | no              |
| **`rule`**, **`severity`**, **`culture`**, **`subject`** | finding             | yes    | yes             |
| **`fixable`**, **`change`**                              | finding             | yes    | yes             |

The finding fields are new. Their values come from the layer's columns (`f.rule`, `f.culture`,
`f.flags`) and the rule's metadata, so they cost no storage. `rule` takes the layer's rule IDs, as
the Text tab's `findings` field does.

Adding a field later means one registry entry, and the field can then be filtered, grouped and
counted everywhere it is marked, with no host-specific option.

**Facet marks name fields.** Today a mark names a fixed `Facet` (`ix/engine_where.rs`). It becomes
a field name from the registry, so counting by any field drops the marks on that field, and a
host can mark any filter it builds.

**One name per field.** A field's registry name is the name everywhere: a `where` tests
`{ "field": "paths" }`, a mark is `{ "facet": ["paths", …] }`, and rows group and count
`{ "by": "paths" }`. The contract generates `QueryField`, the union of the names, from the
registry. Hosts keep their own words for them: Electroswag's "Folder" is `paths`, "Asset" is
`files`. The count-only `cultures` field is each culture's line states, as today's culture facet.

The counts' tabs (`editable`, `readOnly`, `withoutNotes`, `origins` in `counts`) drop the marks
on `editing`, `notes` and `origins`. Today's `kinds` mark (a place's origins) and `origin` mark
(a row's) both become `origins`, so counting origins drops both: each is a filter on origins.

## 4. Finding rows

A selection names its rows: `lines` (with a target, as today), `units` (without one, as today) or
**`findings`**. Finding rows need a target, and the selection's findings layer and acceptance with
a view (`findings.view`):

- `workspace`: source and line findings, shadowed ones hidden when the program has an enabled
  `unit_source` rule;
- `report`: line findings.

Accepted findings are hidden under an acceptance key, as today (Phase 3 §5). The selection's
`culture` keeps that culture's findings and those without one, as Quality's culture picker does
today; the `culture` field tests a finding's own culture.

### Testing a finding

A `where` over findings tests finding fields directly, and its **text row** through `row`:

```jsonc
{
	"and": [
		{ "facet": ["severity", { "in": [{ "field": "severity" }, { "lit": ["blocking"] }] }] },
		{
			"row": {
				"facet": ["paths", { "any": [{ "field": "paths" }, { "pathHasPrefix": ["…"] }] }]
			}
		}
	]
}
```

- **`row`** takes a body in the Text tab's grammar: the same pills, the same builder
  (`gt/native-query-ir.ts`). The Text tab's filter means the same thing on Quality.
- **Line and `line_culture` findings**: the row is the finding's line.
    - A `line_culture` finding is tested with the culture scope narrowed to its own culture, so a
      translation test reads the culture the finding is about.
    - A `line` finding (a source check) is tested with the selection's culture scope.
    - This is #209's search semantics, generalised to every field.
- **`unit_source` findings**: the row is the finding's raw unit, tested as the Text tab tests units
  without a target. Line-only fields and culture quantifiers are false. Today a source finding
  matches no `where`; this keeps source findings filterable by folder, asset and origin.
- **Facet marks** work inside `row` as they do at the top level: counting `paths` drops the
  `paths` marks wherever they stand.
- A finding's own fields are `rule`, `severity`, `culture`, `subject`, `fixable`, `change` and
  `id` (its finding ID). A `line` filter is `row` over the line's `id`.

### Text

`text` keeps #209's meaning on finding rows: each word in the line's source or the finding's
culture's translation, ignoring case; a source finding's own source.

### Evaluation

- A `row` body compiles with the existing row-set compiler into a line set, or a unit set, per
  culture scope it needs. The sets are the Text tab's atoms, keyed the same way, so a filter the
  Text tab just ran is already cached.
- A finding passes a `row` test when its line's bit is set in its culture's set.
- Finding-field tests read the layer's columns per finding, compiled once per request: a rule
  test is a mask over the program's rules, a flag test a bit. At Coral's 156,637 findings this is
  a scan of four `u32` columns, so nothing is cached for it.
- **Cache budget.** Line sets narrowed to one culture are new entries the Text tab never uses.
  They get their own 16 MiB budget, so finding queries can't evict the Text tab's sets.

## 5. Parts, for every kind of row

- **`rows`**: a page in an order, after a cursor.
    - Finding orders are today's: `severity`, `report`, `line`, `source`, by default the view's
      (`severity`, `report`). The cursor is a finding ID, and `offset` skips rows after it, as
      today's pages do. The `source` order lists only source findings, as today; a host says so
      with `subject` so its counts agree.
    - Finding rows travel in today's composed shape (`ix/rules/findings_read.rs`): the `places`
      and `findings` batches.
- **`counts`**: `total`. For findings also `accepted`, what the acceptance key hid from the rows
  every filter selects, `fixable` among `total`, and `limits`, the diagnostics by code. Today's
  `all` is the sum of the `rule` facet.
- **`facets`**: a list, `[{ "by": "paths", "under": "/Game" }, { "by": "severity" }, …]`, each
  field at most once. The answer holds each under the field's name, in today's shape. Each
  counts the query's rows over the selection with that field's marks dropped: counts follow every
  filter but their own, as today. Finding rows count findings, so a line with three findings
  counts three under its folder. This replaces the fixed `Facets` struct and `findings_query`'s
  counts by rule, severity and fixable.
    - A finding field's facet lists every value, `{ key, label, count }`: rules in program order,
      rules sharing an ID once.
    - A text-row field's facet (`paths`, `files`, `origins`, `audience`, `namespace`,
      `assetTypes`, `sources`) counts findings under their line's values and their unit's, in
      today's group shape, the units' entries added to the lines' by key.
- **`groups`** and **`openGroups`**: by any groupable field, with today's meaning and budgets.
  Finding rows refuse them until a host lists findings in groups.
- **`diagnostics`**: stays, for finding rows, as today: a page, `{ offset, limit }`.
- **`write`**, finding rows only: a `findingJson` sink in the report view takes every selected
  finding, as today's findings sink, rather than a page.

## 6. TypeScript and hosts

**Requests carry filters, not pills.** A pill is how a host shows a filter. The query takes the
filter itself, so a new kind of pill over existing fields needs no UE Shed change.

- **Both tabs' requests take `where`**, the rule IR's expression with facet marks:
    - `WorkspaceQualityRequest` keeps its target, culture and check, and takes `query` (the
      search), `where` and `facets` (§5). `severities` and `fixable` go: severity and suggested fix
      are fields like any other.
    - `TextCorpusSearchRequest` takes `where` in place of its pill list (`filter`) and of the
      fields that only built one: `capability`, `withoutNotes`, the localization `state`,
      `review` and `keyChanged`, and today's location `where` (`kinds`, `pathPrefix`, `files`).
      The changed files the counts report on stay their own field, `fileScope`.
      `TextFacetRequest` becomes the facet list.
- **Pills become filters on the host**, through a published converter: today's builder
  (`gt/native-query-ir.ts`), exported from a browser-safe entry. It turns the Text tab's pills,
  and the severity and suggested-fix pills, into marked expressions. A host may build its own
  expressions for its own pills; to count by a field, it marks what it builds with that field.
- **One Effect Schema for `Expr`**, so hosts validate a filter at their own boundary (Electroswag's
  RPC) before it reaches UE Shed. The engine validates again, as today.
- **Saved filters.** Investigation presets, which the CLI also runs, save what the list sends: the
  Text tab's `where` and `fileScope`, and Quality's search and `where`. The host's own controls
  ride beside them as `controls`, JSON that UE Shed saves and never reads, so opening a preset
  shows the pills again. A report matches a preset when its `where` is the preset's. The owner
  chose the new format over converting old pills (2026-11-08): presets are version 3, and
  earlier versions are refused, since nobody keeps presets yet. Browse preferences are the
  host's, and keep whatever the host shows.
- **The in-memory Quality list** (`localizationQualityWorkspace`), which only tests and the
  Workbench harness read, stays as their double: it reads severities and the suggested-fix filter
  back from `where` (`qualityPillsOf`) and refuses any other filter.
- **`findings_query` is deleted** (Plan 059: code a phase replaces is deleted in that phase). The
  queried workspace, `ue-shed loc check` and its sink read finding rows instead.
- **Electroswag** gives Quality the Text tab's toolbar: search, Filter menu and pills, with
  severity and suggested fix as menu fields, converted to `where` before it sends them. The
  Workbench and the CLI convert their pills the same way.

## 7. Performance

### Baseline

Coral (265,791 lines, 156,637 findings, ten cultures), isolated Electroswag on published
UE Shed 0.27.1, 2026-11-07. Server RPC times; the engine's stages where it records them.

| Path                                                            | Time         | Where it goes                                     |
| --------------------------------------------------------------- | ------------ | ------------------------------------------------- |
| Text tab, full list with facets                                 | 247–285 ms   | Engine (no stage breakdown recorded)              |
| Text tab, a search ("lantern" cold, "qq", no match)             | 16–30 ms     |                                                   |
| Text tab, broad pills (folder, asset type)                      | 144–274 ms   |                                                   |
| Text tab, next rows                                             | 17–36 ms     |                                                   |
| Quality, first page after opening                               | **2,825 ms** | `compose` 2,791 ms, cold                          |
| Quality, the same page requested again at once by the tab badge | 2,834 ms     | Electroswag sends it twice                        |
| Quality, a page                                                 | 31–48 ms     | `compose` 18–20 ms                                |
| Quality, first search ("eggs")                                  | **2,478 ms** | stages 741 ms (`lines` 720); 1.7 s outside stages |
| Quality, a search after that, or adding a severity              | 39–62 ms     |                                                   |
| Quality, a new word with no match                               | 149 ms       | `lines` 140 ms                                    |

### Rules

- **The Text tab must not move.** Its path is unchanged, so its timings stay within run-to-run
  noise on Coral and the released project. A regression is a STOP.
- **Quality must not get slower** on any baseline path.
- **Attribute the cold costs the baseline found** in step 1, before changing anything:
    - the first page's 2.8 s `compose`, cold;
    - the 1.7 s of the first search that no stage covers. A `layer` stage (opening the findings
      layer) and a wait stage go in first.

    Those in the path this phase replaces are fixed here. The others are recorded for their own
    change.

- Electroswag stops sending the badge's duplicate request (its own change, with the toolbar).

## 8. Out of scope

- **Filtering or counting by a rule's own outputs**, such as "length over 40". Today nothing can.
  If a studio wants it, a rule could name an output in the rules file and make it a field. It must
  stay optional, so rules keep their freedom.
- **Showing accepted findings** as a filter value. `accepted` stays a count.
- **`aggregate`'s dimensions.** The multi-dimension rollup reports and the CLI read keeps its own
  list (`ix/engine_rollup.rs`): per-culture marks and measures are its own. Folding it into the
  registry is its own change.
- **Arbitrary expressions in `row`** beyond what the row-set compiler compiles today (Phase 4 §6).
  The compiler refuses them, as it does for the Text tab.

## 9. Decisions

Settled by the owner on 2026-11-07:

1. **Requests carry filters, not pills** (§6). Pills are converted to a marked `where` on the
   host; UE Shed publishes the converter for the pills the tabs share.
2. **Source findings are tested through their unit** (§4), rather than matching no filter.
3. **Severity and suggested fix are pills** in the Filter menu. Quality's row of check chips stays
   as it is.
4. **`findings_query` is deleted** rather than kept as a wrapper.

## 10. Steps, one commit each at least

1. **Attribute and baseline.** The `layer` and wait stages, the cold `compose` and the 1.7 s,
   attributed on Coral. The measurement record gets §7's baseline. Found: the cold `compose` is
   the whole corpus's occurrence order, built for a 50-line page; the 1.7 s didn't reproduce, and
   nothing queues.
2. **Page reads order only their lines.** Reading a page's places orders the members of its own
   lines, not every line's; evaluations keep the shared corpus order. Measured on Coral: the first
   Quality page without the 2.2 s, later pages and the Text tab unchanged.
3. **The field registry.** `FIELDS`, `GroupBy` and `Facets` become one list; facets become a list
   for lines and units; the `namespace` count. Until step 5 the builder maps the Text tab's group
   names and facet object to fields and back, so its answers are byte-identical, except that a
   request with both an origin pill and a location kind counts origins without either. Timings
   unchanged.
4. **Finding rows.** Selection `rows: findings`, the finding fields, `row`, text, orders, cursors,
   facets, diagnostics and writes. A parity test sends every request the queried workspace, the
   source report and `loc check` send today, through both `findings_query` and finding rows, and
   compares the answers on the fixture and on Coral. A second test checks what is new against the
   Text tab's own answers: a culture finding's row test in its culture, a source finding's
   through its unit, and counts by the row's fields.
5. **TypeScript.** The `Expr` schema and the exported converter (`@ue-shed/game-text/query`).
   Quality's request takes `where` and `facets`; the workspace, the source report and the CLI
   read finding rows; `findings_query` is deleted, and the
   parity test becomes one that checks finding rows' pages, counts and writes against each other.
   Then the Text tab's request takes `where`: its pills, capability, translator-notes filter,
   location and localization lens arrive as one expression, and a pasted changed-file list as
   `fileScope`. The Workbench, the CLI and the corpus tools convert their controls with
   `textWhere`; stored view settings keep their format and convert on load. Presets then save
   the `where` they run, with the host's controls beside it (version 3).
   The Text tab's facet request keeps its shape for now.
6. **Electroswag.** Both tabs convert their pills and send `where`; Quality gets the Text tab's
   toolbar; the badge's duplicate request goes.
7. **Measure** on Coral and the released project against §7, and the owner reviews.

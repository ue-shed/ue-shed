# Game Text product

## Product promise

UE Shed makes player-facing text in saved Unreal packages searchable and reviewable without
requiring a running editor. The product preserves Unreal text identity, authored occurrence
evidence, and parser coverage instead of presenting strings as an unexplained flat list.

Saved game text is read-only. UE Shed discovers it through the shared saved-project index and
compact text extraction path, refreshes a persistent column index, and exposes scan, search, focus,
and quality review through public package and CLI surfaces. Workbench is a bounded client of the same query
model; it is not a second corpus or policy authority. Project-authored quality rule documents are
the one editable artifact in this slice: users may inspect, preview, and save them without changing
game text or localization resources.

## Shipped read-only corpus

Localization evidence defaults to 320 MiB and 1,000,000 entries per file, 2,560 files per target
read, and nesting depth 64. Library hosts can pass explicit `LocalizationLimits` through the
evidence request's `limits` field. Entry counts are independent for the manifest and each culture
file. The saved-asset reader allows 10 GiB of cumulative protocol output and defaults catalog
scans to 50 minutes. A failed read names its cause and recovery; only a missing manifest asks for
an Unreal gather.

Game Text and localization hosts compose the public `GameTextIndexSteps` operations; the
`GameTextIndexRefresh` convenience workflow remains available. A project refresh
compares the Project Index's package-and-sidecar signatures and localization file stat/content
keys, reads changed inputs, then publishes a joined generation. `loc gate` refreshes the named
changed files. Rescan with unchanged inputs reuses the index. Review and PO writes invalidate the
affected localization layers and join. Hosts publish a replacement before retiring the previous
owner, and active query users keep that generation pinned until they finish. A failed or superseded
preparation leaves the published model usable. A failed current localization read makes that input
unavailable to the new join even when a historical layer remains; missing and malformed evidence
retain distinct states. Raw scans preserve empty-source units independently of search visibility.

Source and localization targets share each project's package extraction and string store.
Loading translations reuses unchanged package layers rather than extracting those packages a
second time. Each target retains its own joined view. Inventory pages are reused within a complete
Project Index generation and fetched again when that generation changes.
Hosts choose step ordering and requested views. A verified project revision can be reused for
multiple targets; target import and construction do not refresh package inventory. The library
checks revision validity and owns per-step locking, publication, and scoped query resources.

The CLI cache is under `UE_SHED_PROJECT_INDEX_CACHE_ROOT`, defaulting to `.cache/ue-shed` in the
user's home directory. Workbench uses `project-catalogs-v1` under its existing Electron user-data
root. The `game-text-v1` descendants are disposable; close the affected hosts before deleting those
cache directories, then refresh to rebuild. This removes derived data without changing saved
packages, localization evidence, review state or authored rules. Format version 4 preserves UTF-16
strings with canonical WTF-8. Older cache generations are rejected and rebuilt.

Workbench keeps scan progress visible through localization preparation and the first results
query. It shows the current stage, completed package/file counts when known, and elapsed time from
starting the operation until results are usable. Index construction and opening use indeterminate
progress rather than an invented overall percentage or ETA. The completed duration remains visible
in the Text footer as `Ready in`. Library hosts can observe the same index stages through the optional,
operation-scoped `GameTextIndexProgressReporter`.

Staged translation review keeps its edit list in a bounded, keyboard-scrollable area. Close,
check and write controls stay visible; closing the panel preserves the staged drafts.

`GameTextIndexBuilder` is the build capability supplied by each host. `GameTextIndexBuilderLive`
selects the complete TypeScript builder/query implementation for CLI, Workbench and library hosts.
Native saved-package extraction remains a separate capability. The experimental native writer
requires explicit selection and is not the production backend. A future native backend must own
both build and query execution, with TypeScript limited to contracts, transport, lifecycle and
presentation rather than maintaining another query engine. See
[native preparation](../engineering/native-game-text-index.md) for composition, compatibility,
recovery and measurement limits.

Tagged-property text extraction supports classic, uncooked, versioned editor packages from UE 4.27
and UE 5.0–5.3, alongside the existing UE 5.4+ reader. The legacy window includes String Tables,
DataTable and CompositeDataTable rows, data assets, and generic UObject text with nested containers.
UE 4.26 and older tagged properties require resaving in 4.27 or later. UE 4.27 and 5.3 are verified
against engine-saved fixtures and fresh-process Unreal evidence
([Plan 050](../../plans/archive/050-legacy-property-tags.md)). UE 5.0–5.2 have synthetic
version-boundary coverage only. On UE 4.27, packages usually store `None` as their package name, so
the reader names their objects relative to the package (`DT_Items`). Game Text completes those paths
from the package file under `Content/`, which Unreal mounts at `/Game`, so text locations, role
matchers and exports use the same `/Game/Data/DT_Items.DT_Items` path on every engine version.

Blueprint pins, Sequencer, animation/Skeleton, property bags, InstancedStruct, and actor/component
native records retain their current version gates. Legacy native struct map/set elements without
type information report `legacy_container_element_without_type_information`; unsupported histories
and unavailable engine features retain their own gap reasons. Partial coverage stays visible in
the corpus. Each package with gaps has one `package_partially_decoded` diagnostic with
`coverageGapCounts`, using the reader's reason literals, and its first gap's location. The scan
retains at most three gap samples per package, preserving the first and preferring unsupported
history samples for the remaining slots. Only those history samples produce
`unsupported_text_history` diagnostics. `coverage.unsupportedTextProperties` counts every gap,
including rejected decoders, unavailable engine features and legacy containers.

The corpus includes decoded String Table entries, DataTable `FText` cells, and supported asset
properties. Every text unit retains its resolved or unresolved Unreal identity and one or more
occurrences with package, object, row/entry/property, and edit-capability evidence.

Localization lines use each occurrence's gathered identity: saved FText in asset properties and
DataTable cells has its trailing package namespace marker removed; String Table definitions and
references keep the namespace exactly as authored. A mixed corpus unit joins both identities with
their own occurrences. Saved corpus units and occurrences retain the full namespace and unit IDs
for asset inspection.
Package variants of one namespace and key share a localization line, including source conflicts.

Coverage is part of every corpus result. Complete and partial results distinguish discovered,
inspected, partial, and failed packages; resolved and unresolved occurrences; and unsupported text
properties. Unsupported evidence and diagnostics remain visible in search/focus and downstream
reports. A zero-finding report never implies complete project coverage unless its attached corpus
coverage does.

A package is partial when text Unreal gathers from it was not read. The reader compares the
decoded lines with the package's saved gatherable text table, the list Unreal's asset gather reads,
by namespace, key and source text, ignoring editor-only sites. Decoded identities use the gathered
namespace rule above. A decoded line covers only the entry with its own source text, so another
source variant under the same key stays unread. Undecodable properties that hold no gatherable
text, such as native Niagara structs, remain counted as coverage gaps but no longer make a package
partial. `missingGatherableText` counts the runtime entries that were not read, and each partial
package lists up to three of them, with source text and Unreal site, as
`gatherable_text_not_decoded` diagnostics. The table is used only where Unreal's gather would use
it; Unreal saves no table for packages with Blueprint bytecode and loads them instead. Those
packages, packages saved before the table existed, and unreadable tables keep the previous rule:
any decode error or gap is partial. The table is written on every editor save, so no prior gather
is needed.

Saved-scan completeness is limited to the selected package inventory and supported decoders; it
does not certify parity with a fresh Unreal gather. New C++/INI and code/CSV String Table text,
reflected metadata, custom gather callbacks and content outside the
default project inventory can be missing even without a reported decoder gap. A readable manifest
can supply previously gathered evidence from those sources. See
[coverage compared with Unreal gather](../engineering/game-text-gather-coverage.md) for the precise
boundary and the explicitly requested Unreal workflow.

The optional `packageCoverage` evidence also accepts `not_gatherable`: excluded because Unreal's
gather flag, saved gatherable-text summary and external-package relationships do not select the
package. This status does not prove absence of text. Candidate-layer helpers report the excluded
set with `package_not_gatherable` diagnostics; `loc status` includes an optional exclusion count
and bounded package rows. Game Text shows Read problems only when gathered text may be missing and
mentions excluded packages there as matching Unreal's own gather. Fixture audits check that
excluding packages hides no coverage problem: the opaque `OpaqueValue.Value` package has no
gatherable text, so the full reader reads it completely too.

### Player and editor text

Most of the `FText` a saved-package reader finds is Unreal editor text: pin and variable tooltips,
details and palette categories, graph nodes, reflection metadata. Every occurrence therefore
records who it is for, `audience` (`player`, `editor` or `unknown`), why (`audienceReason`) and,
for policy matches, the policy row (`audienceRule`). The evidence, strongest first:

1. **Unreal's gather table.** Since uasset-io 1.11 the reader sends the editor-only bit Unreal
   saved for each text in the package's gatherable text table (`gather_editor_only`), where the
   table is trusted under the coverage rule above. Text is editor-only only when every site with
   its namespace, key and source is, because a gather that skips editor-only data still collects
   text from one runtime site. Reasons: `gather_table_editor_only`, `gather_table_runtime`.
   Blueprints with bytecode have no trusted table, so their text falls through to the policy.
2. **The policy table** below (`TEXT_AUDIENCE_POLICY`): first matching row wins, and editor rows
   come before player rows, so a K2 node inside a Widget Blueprint graph stays editor text.
3. Otherwise `unknown` (`no_evidence`).

A line or unit is player text if any of its saved places with visible text is, else unknown if any
is, else editor. Lines without a saved place (C++, config) are unknown. The audience is a filter
field and a facet (`facets.audiences`, which leaves out its own clause like the others), a
grouping (`group: "audience"`), a column in both spreadsheet exports, and part of the exported JSON
occurrences and lines.

With a selected target, editor text is out of scope when the target does not gather editor-only
data: `ShouldGatherFromEditorOnlyData` on its `GatherTextFromAssets` steps (or the dashboard's
`GatherFromPackages`) is false, Unreal's default. A line that would otherwise be "Not gathered
yet", whose every place inside the gather paths is such editor text, is "Outside this target"
instead, with `outOfScope: "editor_only_data_not_gathered"`; lines outside the include and exclude
paths carry `outside_gather_paths`. Lines Unreal did gather keep their state, and developer-folder
text is editor text by convention, not editor-only data, so it stays in scope. Localization checks
skip out-of-scope lines, as before.

Names compare case-insensitively. `object` matches the class name or any object name in the
occurrence's outer chain (graph objects are named after their class). `property` matches the last
element(s) of the property path, ignoring container indexes; "in" matches any element. Map entries
(`DisplayNameMap{0}.value`, `{0}.key`) match as the map property (`DisplayNameMap`).

| Rule                              | Audience | Reason             | Match                                             | Why                                 |
| --------------------------------- | -------- | ------------------ | ------------------------------------------------- | ----------------------------------- |
| `developers_folder`               | editor   | `developer_folder` | package under `/Game/Developers/`                 | Per-user developer folders          |
| `dev_folder`                      | editor   | `developer_folder` | package under `/Game/Dev/`                        | Test and prototype content          |
| `uobject_tooltips`                | editor   | `editor_namespace` | namespace `UObjectToolTips`                       | Reflection tooltips                 |
| `uobject_display_names`           | editor   | `editor_namespace` | namespace `UObjectDisplayNames`                   | Reflection display names            |
| `uobject_categories`              | editor   | `editor_namespace` | namespace `UObjectCategories`                     | Reflection categories               |
| `k2_node`                         | editor   | `editor_object`    | object/class `K2Node_*`                           | Blueprint graph nodes               |
| `anim_graph_node`                 | editor   | `editor_object`    | object/class `AnimGraphNode_*`                    | Anim graph nodes                    |
| `anim_state_node`                 | editor   | `editor_object`    | object/class `AnimStateNode*`                     | State machine nodes                 |
| `ed_graph`                        | editor   | `editor_object`    | object/class `EdGraph*`                           | Editor graphs and comments          |
| `scs_node`                        | editor   | `editor_object`    | object/class `SCS_Node*`                          | Component tree entries              |
| `niagara_node`                    | editor   | `editor_object`    | object/class `NiagaraNode*`                       | Niagara graph nodes                 |
| `niagara_graph`                   | editor   | `editor_object`    | object/class `NiagaraGraph*`                      | Niagara graphs                      |
| `material_expression`             | editor   | `editor_object`    | object/class `MaterialExpression*`                | Material expressions                |
| `material_graph`                  | editor   | `editor_object`    | object/class `MaterialGraph*`                     | Material graphs                     |
| `editor_module`                   | editor   | `editor_object`    | class module `*Editor`                            | UMGEditor, NiagaraEditor, ...       |
| `unreal_ed_module`                | editor   | `editor_object`    | class module `UnrealEd`                           | UnrealEd classes                    |
| `blueprint_graph_module`          | editor   | `editor_object`    | class module `BlueprintGraph`                     | Blueprint graph classes             |
| `anim_graph_module`               | editor   | `editor_object`    | class module `AnimGraph`                          | Animation graph classes             |
| `property_tooltip`                | editor   | `editor_property`  | leaf `PropertyTooltip`                            | Variable tooltips                   |
| `tooltip`                         | editor   | `editor_property`  | leaf `ToolTip`                                    | Function, variable and pin tooltips |
| `pin_tooltip`                     | editor   | `editor_property`  | leaf `PinToolTip`                                 | Pin tooltips                        |
| `category`                        | editor   | `editor_property`  | leaf `Category`                                   | Details and palette categories      |
| `category_name`                   | editor   | `editor_property`  | leaf `CategoryName`                               | Blueprint and SCS categories        |
| `palette_category`                | editor   | `editor_property`  | leaf `PaletteCategory`                            | UMG designer palette category       |
| `niagara_version_data`            | editor   | `editor_property`  | module `Niagara` and in `VersionData`             | Niagara script version metadata     |
| `niagara_cached_script_vm`        | editor   | `editor_property`  | module `Niagara` and in `CachedScriptVM`          | Compiled Niagara script data        |
| `objects_to_display_names`        | editor   | `editor_property`  | leaf `ObjectsToDisplayNames`                      | Animation binding names             |
| `niagara_signature_description`   | editor   | `editor_property`  | path ends `Signature.Description`                 | Niagara function descriptions       |
| `movie_scene_display_name`        | editor   | `editor_property`  | module `MovieScene` and leaf `DisplayName`        | Sequencer track names               |
| `movie_scene_tracks_display_name` | editor   | `editor_property`  | module `MovieSceneTracks` and leaf `DisplayName`  | Sequencer track names               |
| `string_table`                    | player   | `player_asset`     | String Table entry                                | String Tables exist to be displayed |
| `data_table`                      | player   | `player_asset`     | DataTable cell                                    | Game data                           |
| `user_defined_enum_display_name`  | player   | `player_asset`     | class `UserDefinedEnum` and leaf `DisplayNameMap` | Blueprint enum display names        |
| `widget_tree`                     | player   | `player_asset`     | object `WidgetTree` in the outer chain            | Widget designer tree                |
| `script_bytecode`                 | player   | `player_asset`     | property `ScriptBytecode`                         | Compiled Blueprint text literals    |

The table is studio-agnostic. Project conventions, such as debug or demo folders, belong in the
project's rules, not here. The compact index stores each occurrence's audience; the policy table
is part of every package shard's key, so changing it re-encodes the stored shards from their saved
evidence without reading packages again.

### Compiled Blueprint copies

Compiling a Blueprint saves its authored subobjects again in the same package: a Widget
Blueprint's `WBP_X.WBP_X.WidgetTree.Title` is also saved as `WBP_X.WBP_X_C.WidgetTree.Title` under
the generated class, its UMG animations as `WBP_X_C.FadeIn_INST`, and some engines and older saves
also keep a skeleton class (`SKEL_WBP_X_C`) and default objects (`Default__WBP_X_C`). Read naively,
every widget text is two places, and a Blueprint edited but not compiled reads as one key with two
texts.

Since uasset-io 1.12 each package record lists its Blueprints' `blueprintClasses`: the Blueprint,
the export its saved `GeneratedClass` names, that class's default object (the export flagged
`RF_ClassDefaultObject`) and, when one was saved, the skeleton class and its default object. Names
are never the evidence on their own, so an asset whose own name ends in `_C` is never a class.
Game Text folds each copy into its authored site, the occurrence with:

- the same location kind and property path,
- the same key (namespace and key, String Table reference, or both unkeyed),
- and the authored object path: the Blueprint in place of the generated class, skeleton class or
  default object, with a leading `Name_INST` read as `Name`.

Two properties of one object that share a key stay two places. A copy under another key stays its
own place. A site saved only under the class, such as a construction-script node, has no authored
site and stays a place at its own path; copies of it fold into the generated class's site, then the
default object's, then the skeleton's.

The place keeps its own text: the line's source, search, counts, facets, exports and localization
joins all use the authored text, which is what the next compile and gather will use. Each copy is
kept on the place's `copies` (`objectPath`, `kind`: `generated_class`, `instance`, `class_default`
or `skeleton`, and its own `source`). When a copy's text differs, the place never makes its key
"Same key, different text". When a copy the game runs, the generated class's (including its
animation instances) or the class default object's, holds other text, the unit has the
`compiled_copy_differs` review signal ("Blueprint not compiled since edit"), and the line page says
what that copy shows until the Blueprint is compiled. A skeleton class only serves the editor while
a Blueprint compiles, so a skeleton copy with other text raises no signal and makes no claim about
the game; the line page lists it with its text. A place's audience is the line rollup over the
place and its copies, each classified from its own evidence: its path, its class and the gather
table's editor-only bit for its own text. A place the table calls editor-only whose compiled copy
is runtime text stays player text, so a target that skips editor-only data still expects it.

Folding happens per package record, the same way in the in-memory corpus and in the index
(`package-text-v5`), and is idempotent. Records from readers before 1.12 and streamed
`text_occurrence` events carry no Blueprint evidence and are never folded.

The compact corpus path is governed by Plan 033:

- the shared project index performs the only project-wide enumeration;
- text extraction opens only explicit candidates from that index;
- `@ue-shed/game-text` owns normalized text meaning and queries;
- Workbench main owns the active query instance and returns bounded pages over validated IPC;
- renderer state never receives a complete project corpus.

## Reviewing text in Workbench

> Status: shipped by [Plan 053](../../plans/archive/053-game-text-review-workspace.md); the design is in
> [`ideas/game-text-review-workspace.md`](../ideas/game-text-review-workspace.md).

The **Text** view is a list of lines and a page per line, built to stay usable with tens of
thousands of lines, hundreds of problems and a dozen cultures. The toolbar holds the search, which
matches source text as you type, then **Changed files**, **Filter**, **Display**, **Export** and
**Presets**. Every count comes from the same query as the list (see [Counting](#counting)).

The compact list has **Key**, **Source** and **State** columns, and a **Translation** column
while exactly one culture is picked; with none or several, the state column carries the culture
strip instead. **Filter** is the single entry point for translation states and line facts.
Translation values read **Not translated**, **Needs update** and **Not synced**; line facts include
**Outside this target**. **Ctrl K** (or **Cmd K**) focuses search.

The header has two rows. The title row holds the **Text**, **Quality checks** and **Reports**
views as one segmented switch, the project's scan state (lines, inspected assets and any read problems) and
**Rescan**. Under it, the translations row says which translations are shown, **Target** and the
picked cultures, and on its right what Unreal still has to take in: the not-synced count,
**Sync with Unreal**, staged edits and **Unreal steps**. **Target** names the localization target
in use within the project, and chooses another when the project has several; it decides which
translations, PO files and Unreal steps are used. A project without localization targets says so
in that row.

The Text footer is its status bar: the matching lines in each translation state for the picked
cultures, how long the project took to become ready, the last successful query round trip
(excluding the typing debounce) and the picked and total culture counts. State counts can overlap
across cultures and are not presented as percentages of one total.

Rescan shows inline progress and retains the current list for browsing and searching while the
new index is prepared. Scan progress replaces the title row's scan state, with a compact bar beside
the stage readout only when package/file totals are known. Unknown totals use a small activity
spinner instead of a looping bar. This keeps idle space and row positions stable; reduced motion
stops the spinner. The bar measures the named stage, not an overall percentage. Project selection
belongs to the host's workspace project picker; **Scan project** and **Rescan** only use that
selected project. Search retains at least 150 px of input space. At 1024 px, both header rows keep
one line, columns fit the available list width and the **Side pane** toggle can hide the side
pane, keeping focus on the toggle.

Every command in the header and toolbar is named: **Rescan**, **Changed files**, **Filter**,
**Display**, **Export**, **Presets**, **Target** and **Sync with Unreal**. Two toggles are icons,
each where its kind of toggle usually sits: **Search translations** inside the search field, as a
find option, and **Side pane** at the toolbar's right edge, above the pane it shows or hides. A
line's per-culture review flags are icons too. Icon tooltips appear on hover or keyboard focus and
let the pointer pass through to the controls beneath them. Below 1280 px the Ctrl K hint in the
search field gives way so the toolbar keeps one row. Badges show applied filters, quality finding counts and unsaved rules, and
are part of each control's accessible name ("Filter, 2 active"). When a target is unavailable,
only localization-dependent filter values are paused. Source predicates and their inclusion or
exclusion operator still apply to the list, exports and saved presets.

### Problems

Each line is classified by what it needs, worst first:

1. **Key changed**: the text has a new key, and the earlier key's translations are lost at the
   next gather unless they are carried over.
2. **Same key, different text**: one key holds conflicting source text.
3. **Not gathered yet**: Unreal's manifest does not have the line.
4. **Changed since gather**: the source differs from what Unreal gathered.
5. **Translation work**: a culture is missing, out of date or not synced.
6. **Finding**: used in several places, the same text under different keys, long, or not
   localizable.
7. **Up to date**.

A line counts once for each problem it has and is grouped under its worst. Problem groups mark
severity: red for key problems, amber for lines waiting on Unreal and translation work, blue for
translations not yet in Unreal. Findings and facts such as "Gathered only", "Not found in the
project" or excluded assets stay grey; facts are not problems. In a single-culture browse row, the
labelled state badge and dot use green for translated, amber for needs update, red for not
translated and blue for not synced; the culture picker colours each culture by its worst work the
same way. Both lines of a changed key are red: **Key changed** on the new key and **Earlier key**
on the key whose translations the next gather drops. Where colour marks severity, labels for
assistive technology say it too ("including key problems").

### Filter

**Filter** lists fields; each opens a submenu of its values with how many lines have them, and
typing at the first level finds values across every field:

- **Problem**, as above.
- **Translation**: not translated, needs update, not synced, in the cultures shown.
- **Finding**: used in several places, same text with different keys, long text, not localizable.
- **Folder**, **Asset** and **Origin** (String table, Data table, Asset, C++, Other source). A
  String Table reference inside an asset counts as the asset; gathered-only lines take their
  origin and folder from Unreal's manifest path. A line belongs to every folder it is defined or
  used in, and a folder includes its subfolders. The Folder submenu browses folders a level at a
  time, like the side pane, and never lists every folder at once: a name adds its pill, the arrow
  opens the folders inside it, and "‹" goes back up. Typing narrows the level shown and offers
  "Path starts with …", which matches object paths, package files and gathered source paths,
  ignoring case and slash direction.
- **Audience** (Player text, Editor text, Unknown), from
  [player and editor text](#player-and-editor-text). Choosing "is not Editor text" hides editor
  text.
- **Editing** (editable, read only) and **Translator notes** (none, some). No translator notes
  means blank notes, after trimming, at every saved location.
- **Review** and **Line state** (gathered only, not found, outside the target, unknown) pick one
  value each; they show as chips beside the pills.

Each chosen value becomes a pill such as "Problem | is any of | Key changed, Not gathered yet | ×".
A field has one pill and every pill must match. Picking a value adds it to the field's pill with
that pill's operator, and picking it again removes it. Clicking the middle part switches the whole
pill between "is" and "is not"; the menu marks values left out by an "is not" pill with "−". Pills
saved with both operators for one field merge when one is switched. Once a field has a pill, its
other values hide their counts, which would read zero. Long values are shortened in the pill and
shown whole on hover. Pills and grouping are saved with the project's view and carried by presets
and exports; preferences and presets saved before pills open with their toggles, lenses and state
chips as pills.

### Display and groups

Workbench's Text view uses the shared package's scoped worker adapter so scans leave the desktop main
thread available. Typing waits for 120 ms of quiet before requesting a page; pressing Enter searches
immediately. New searches cancel obsolete scans while independent group pages can load together.
Case-insensitive source matching reuses prepared source bytes. Completed query pages remain cached
when another request is cancelled.

**Display** groups the list by problem (the default), folder, asset, origin, namespace or audience,
or not at all. Its choices are one radio group: it opens on the current grouping and arrow keys change it.
Groups are listed worst first with their line counts and, outside problem grouping, how many lines
need work. At most 200 groups are listed, with a count of the rest. When every line fits on
one page all groups start open, otherwise the worst one does; each open group loads a page of its
own lines at a time, and only open groups cost a request.

### Cultures

The culture picker takes any number of cultures, and the choice is remembered per project. Unreal
has no culture groups, so there are no named sets; pick the cultures you are working on. Each
culture shows its missing, to-update and not-synced lines over the current filters.

With one culture picked, each line shows that culture's translation. With none, or several, each
line ends with a **culture strip** of the cultures shown: one cell per culture, always in the
target's order, empty when shipped, dashed when missing, amber when it needs an update and blue
when not synced, and one merged bar when every culture shares a state. The text before it names
cultures only when one or two are affected ("de, fr to update", "all missing"). A line every
culture ships draws no mark; a gather state is said once for the line ("Not gathered yet"). Picked
cultures also narrow states, counts and translation work, and **Search translations** searches
every picked culture.

### Side pane

Until a line is opened, the side pane shows where the lines are: problems (unless the list is
grouped by them) and folders, assets and origins, each with its line count and how many need work.
A name adds its pill; a folder's arrow lists the folders inside it.

### Changed files

**Changed files** takes a pasted list, one path per line, from any version control tool
(`p4 opened`, `git diff --name-only`, and so on) and keeps the text those files hold.

- Saved packages match by asset, whatever the extension (`.uasset`, `.umap`, `.uexp`); an Unreal
  package path such as `/Game/UI/WBP_Menu` names the same asset.
- Gathered-only C++ and config lines match their source file.
- Absolute paths inside the project work; blank lines and `#` comments are ignored.
- The summary reads "12 files · 5 with text · 2 not scanned · 1 outside the project". With the
  problems, it answers whether a change touches text and needs a gather.

A changed-file list lasts for the session.

### The line page

Opening a line shows its **page** beside the list; **‹ Lines** closes the detail while retaining
the list's groups and loaded pages. The header says where the line sits ("2 of 58") and steps to the
line before or after it, opening the next group or loading its next page when needed. Folder,
asset and origin groups list a line once for each place it is used, so there the place counts
within the line's group ("3 of 12 in Content/UI"). A line that filters or a rescan removed says
"Not in the current list". The header stays visible while scrolling. Opening moves focus to the
page; Escape returns focus to the line's row, and Alt+Up / Alt+Down step between lines and keep
the selected row visible. These keys are left to text fields while one has focus: in a
translation editor Escape cancels the draft and Ctrl+Enter (or Cmd+Enter) stages it, and focus
returns to the card's **Edit** button. Translation cards keep their place, and the field its focus,
when the line reloads after a write or rescan. A line Unreal has not gathered shows no empty
Translations section; its problem already says what to do.

The page says the line's worst problem first, in plain words and its severity colour, with what
resolves it. It keeps the text, key, every culture's translation (with editing, review and
key-change carrying), **Where it appears** and read problems together. The picked culture's
translation comes first. It lists the line's
properties below them: problems, namespace and key, origin, asset and folder, editing, translator
notes, length and findings. An empty namespace reads "global", as in exports. **Show in Unreal**
reports success only when the editor confirms asset navigation; the button keeps its name and a
status line says what happened.

### Bulk actions

While a target is selected, each line has a tick box; shift-click ticks every line from the last
one ticked, across the lines shown in open groups, and says so when the last one ticked is not
shown. The selection stays while filters and grouping change, so it can be built up from several
views, holds up to 5,000 lines (saying how many were not ticked), and starts over when the target
changes. A bar under the list acts on every ticked line; its result is announced, a failure as an
alert, and changing the selection clears it:

- **Export for translators** writes the all-languages CSV for just those lines, with the native
  culture and the picked cultures (every culture when none is picked);
- **Mark reviewed (n)** sets "Reviewed" on each picked culture's translation that has text to
  review, whose source is current, and is not reviewed yet, through the project's review file,
  500 changes per request, with confirmation and progress;
- **Carry translations (n)** stages the earlier keys' translations for ticked lines whose key
  changed and that are not staged yet, skipping pairs whose source text changed (the line page
  offers those one at a time), up to the 500 edits that can be staged at once;
- **Copy keys** copies each line's namespace and key as two tab-separated columns, and says how
  many ticked lines had no key.

### Counting

Every displayed text count in the toolbar, search, Filter menu and side pane comes from the same query and
filtering path. Empty or whitespace-only source lines are excluded from those counts and from role
line counts. `TextCorpus.coverage` keeps raw scan provenance counts, including empty text; the query
summary's searchable counts describe the lines shown to people. Read-problem and asset counts
continue to describe scan coverage. Partial reads and unsupported text fields remain inspectable
from either view, with related read problems available in the selected line's details.

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
Matchers read the place's own location. A Blueprint place's folded copies
([compiled Blueprint copies](#compiled-blueprint-copies)) never match by their compiled paths, so a
role selects the authored site, whose text is the line's; a site saved only under the generated
class stays a place at that path and matches there.
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

Hosts that offer the interactive workspace (scan, search, quality rules, localization targets,
edits, reviews, reports and investigations) build it with `makeGameTextWorkspace(host)` from
`@ue-shed/game-text/workspace`, the same orchestration Workbench runs. The host supplies its
selected project, which the workspace never changes, and file hooks through which every file the
workspace reads or writes passes. Optional extension points set the rules location, a recovery copy
taken before a rules file is overwritten, the localization file access that writes PO and review
files, and the reviewer and change-set author policies. A scan belongs to the workspace, so it keeps
running when the request that started it goes away, and the next request for the same project
generation joins it.

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
Hosts with an opened index evaluate the same rules over it instead (`sourceQuality`): the scan
reads units in pages of index columns, yields between them, reports progress, keeps each finding
as a few numbers and rebuilds only the findings a page, focus or export shows. Its summary,
pages, focus, export and finding IDs equal the in-memory evaluation's.

Browser-safe rule, report, finding, and query schemas live in `@ue-shed/game-text/schema`,
`/rules`, `/checks`, `/labels` and `/corpus` for
trusted host presentation. Workbench exposes quality review through the existing `GameTextClient`
and corpus query boundary. Its trusted main process retains the active index, decoded rules,
the rules' indexed findings, and rule-file path; the renderer receives the bounded decoded rule document, a
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
fields. **Discard edits** restores the loaded rules. All invalid fields are reported with their
rule and recovery guidance; preview selects the first offending rule. New culture glossary entries
start blank and cannot be previewed or saved until filled in. Scan coverage and read problems
remain available throughout.

Rule drafts and translation drafts are recovered per project from validated local preferences,
including incomplete rule fields. The view's settings and the work in progress are stored apart
and decoded field by field, so one unreadable field is dropped alone. Each distinct rules document
is stored once, the hundred most recently opened translation drafts are kept, and work that
outgrows its storage is removed rather than left to be recovered stale, with a notice to stage,
write or save it. Writes wait for a pause in typing and are flushed when the window hides, so
closing Workbench is never blocked. Drafts and staged changes for targets the project no longer
has are dropped. Translation drafts and staged changes also retain their target, culture,
namespace and key. Rescans, review writes, PO writes and closing a line retain drafts, group
toggles, loaded pages and list scroll. Reloading, choosing or creating rules, and opening a
preset require an explicit discard choice when rules are dirty. Preset rules have no attached file
until a file is loaded; Save explains this prerequisite. Completed quality results carry an
optional `ruleFile` (`attached` or `none`), so a recovered draft knows whether Save has a
destination; the host never sends the file's path. Unstage and Discard all offer Undo until the
target changes. A partial PO write names the files it could not replace, retains their changes
and requires a fresh check before retrying; edits a check finds unwritable can be unstaged
together. **Sync with Unreal** warns when staged edits are not written to PO yet.

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

The public browser entry point exposes versioned `GameTextInvestigationPreset` and
`GameTextInvestigationExport` schemas, `exportGameTextInvestigation`, and
`gameTextInvestigationCsv`. Corpus and quality query models also provide `export` methods that
retain all matching units or findings and their full evidence. Existing search page limits remain
unchanged. A capability filter selects units; exported units retain all their occurrences for
context. Coverage, role counts, rule counts, and diagnostics retain whole-scan scope.

Workbench's **Export → CSV** produces a spreadsheet for people: one row per saved location in
**Text**, or one row per source finding and affected location in **Quality checks**. With a
localization target selected, Quality checks exports one row per matching finding summary, retaining
the target, culture, readable check name, source excerpt, problem, context and scan status. Columns
retain exact Unreal names, keys, translator notes where applicable, and package files. Every cell is
quoted, embedded quotes are doubled, and text starting with optional whitespace then `=`, `+`, `-`
or `@` receives a leading apostrophe. Output has a UTF-8 BOM and CRLF endings, including the last
row. Character counts use the same JavaScript string-length measurement as the line page. JSON keeps
the existing provenance document; `gameTextInvestigationCsv` keeps its documented metadata layout.

Use **Presets → Save preset… / Open preset…** to retain or restore the current settings. A preset
stores the corpus/quality view, search text, filter pills and grouping (or, in presets saved before
pills, capability, **No translator notes**, origin and path filters and review lens), finding-type
filter, existing domain sort order, and optional quality rules. Source quality mode requires a rule
document, including semantic validation of rule and role identities. Localization quality presets
additionally carry `workspaceFilter`, the target and optional culture, and built-in checks can run
without a rules file. `workspaceFilter` is valid only in quality mode with a localization target;
the preset schema rejects other combinations. Their `localization_quality` exports retain all
matching finding summaries, selection, scan status and coverage through `WorkspaceQualityReport`,
with the target's review file applied as in the Workbench list. Localization quality presets and
exports use schema version 2, which older readers reject instead of dropping the finding filter.
Version-1 corpus and source quality investigations remain readable and retain their version when
replayed; a version-1 preset cannot carry `workspaceFilter`. An export and its preset use the same
schema version.
`localizationQualityWorkspace.export` gives headless clients the same report, and
`workspaceQualityCsv` writes Workbench's spreadsheet layout from it. The CLI's `--format csv`
instead writes the `gameTextInvestigationCsv` metadata layout, with `finding_id`, `kind`, `culture`,
`source`, `problem` and `context` columns. Workbench captures the current corpus, rules, project,
and catalog generation before opening an export dialog. The renderer receives only file-operation
feedback. Opening a preset uses the selected project's corpus, and exposes failures without applying
invalid rules.

While a localization target is selected, exports and presets also record the target and picked
cultures, so problem and translation pills select the same lines as the list; the export joins the
target's files to do so, and fails with guidance when the target is not loaded.

The CLI command `investigations run <project-root> --preset <file> --format json|csv` uses the
same public scan and export APIs. Add `--output <file>` to save the result or omit it for stdout.
It requires an explicit project and rescans its current saved files, and reads the target's
localization files when the preset names one. See
[Showcase](../showcase.md#take-an-investigation-away) for CSV layout, replay commands, and limits.

## Verification contract

The first quality slice must prove:

- valid version-1 rule documents decode and evaluate deterministically;
- malformed documents and semantic errors produce typed failures with recovery guidance;
- invalid or empty role configuration cannot broaden matching to the whole corpus;
- character budgets and forbidden/preferred terminology retain role and occurrence evidence;
- complete and partial corpus coverage and diagnostic totals survive in bounded reports;
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
> adds origin and changed-file filters, key-change detection with translation carry-over, and an
> all-languages CSV; its Perforce file-list bridge is planned but not built.
> [Plan 053](../../plans/archive/053-game-text-review-workspace.md) reshapes the Workbench around problems,
> Filter, Display, picked cultures, a page per line and bulk actions (see
> [Reviewing text in Workbench](#reviewing-text-in-workbench)). Plan 051's Phase 8 extensions remain
> proposals.

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

| State                    | Meaning                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Translated               | The archive has a translation whose recorded source matches the manifest                     |
| Not translated           | No translation, or an empty one, for the culture                                             |
| Needs update             | The translation was written for a different source than the manifest now has                 |
| Not synced               | The PO file holds a translation Unreal has not imported and compiled yet                     |
| Not gathered yet         | In the project and inside the target's gather paths, but not in the manifest                 |
| Changed since gather     | The project's current source differs from the manifest source for the key                    |
| Not found in the project | In the manifest, and its package was fully read, but the key was not found                   |
| Gathered only            | In the manifest from a source the asset scan does not read, such as C++ code                 |
| Outside this target      | Excluded by the target's include or exclude paths, or editor text the target does not gather |
| Unknown                  | Available evidence cannot prove a more specific state                                        |

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
A file the working copy does not
have is reported as "Not in this working copy" with its project-relative path and a Gather or Export
recovery; a file that exists but fails to read or parse keeps "could not be read" with its error
code. Ready target results and workspace report pages carry these failed files as bounded
`LocalizationFileProblem` values and the folder Game Text looked in, without file provenance.
Namespace-collapsed PO identities
without keys cannot support an exact join. Crowdin identity PO marks reduced source checking because
it has no source; archive-to-manifest comparisons still determine staleness.

A file confirmed missing supplies absence: a non-empty PO translation with a missing archive is
not synced, while a missing PO does not invalidate a proven archive translation. File failures
remain visible in diagnostics and coverage reasons. Unreadable files cannot supply that proof.

`ue-shed loc status <project-root> --target <name> [--culture <c>] [--state <s>] [--kind <origin>]... [--path <prefix>] [--limit 50]`
reports schema-versioned per-culture counts of lines and source words, coverage and unknown reasons,
file provenance and diagnostics, and a bounded page of matching lines. `diagnostics` contains at
most 200 entries; `diagnosticCount` is the full total, `diagnosticCounts` holds totals by diagnostic
code, and `diagnosticsOmitted` counts entries not listed. When package evidence is available,
`packageCoverage.counts` totals `complete`, `partial` and `failed` packages;
`packageCoverage.packages` lists at most 200 non-complete packages and `packageCoverage.omitted`
counts the remaining non-complete packages. These bounds do not depend on `--limit`, which controls
only the matching-line page. Localization progress and quality reports, quality investigations,
and plain `text search` use the same diagnostic bounds and totals; progress reports also use the
same package coverage summary. `text scan` intentionally returns the full corpus and can produce
large JSON output. Localization-aware
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
`--cultures de,fr` limits states, counts and translation work to those cultures. Both work on
`loc status`, `loc export` and localization-aware `text search`; a malformed clause fails with
`invalid_selection` and the expected form. Clauses on `asset` match a file in any spelling
(`Content/UI/WBP_Menu.uasset`, `/Game/UI/WBP_Menu`), and `namespace` matches exactly.

A request can **group** the matching lines by problem, folder, asset, origin or namespace
(`--group folder`). The page then lists every group, worst first, with its line count, how many
lines need work before they ship (problems worse than a finding) and its worst problem; at most
200 groups are listed, with a count of the rest. `openGroup` pages one group's lines while the
counts and groups stay those of the whole request. **Facets** count where the matching lines
are: the folders directly under a given folder, assets, origins, and each culture's shipped,
missing, to-update and not-synced lines. Each facet leaves out its own clauses, and the culture
facet leaves out the picked cultures, so the picker always shows every culture.

### Checks and reports

Localization checks are quality findings over the same corpus and report model:

- built-ins now check case-sensitive format argument names (renamed apart from dropped or added),
  plural/ordinal/gender/Hangul modifiers, rich text balance, tags and tag case, unsafe PO escapes,
  boundary whitespace, line-break counts, a project segment separator, length outliers, existing
  empty translation entries, translations made for older source, shared source translated
  inconsistently, missing translator notes, and the same source under different keys;
- built-in source checks need no rule file: culture-invariant text players will see untranslated,
  placeholder text, source whitespace, unbalanced source markup, number-only text that could be
  culture invariant, and keys two String Tables declare;
- every localization finding has a severity (blocking, normal or low); lists show blocking
  findings first;
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
not impose tag-name or nesting symmetry beyond Unreal's validator. Separate checks compare tag names
without case (`rich_text_tags`) and their case (`rich_text_tag_case`, low: Slate matches style and
decorator names without case).

UE Shed adds checks the compile validator does not perform: source/translation argument and modifier
comparison, malformed modifier parameters that Unreal treats as literals, whitespace and line-break
drift relative to source, PO escape safety, empty entries, notes, and duplicate source identities.
These are evidence-based built-ins; no rule file is required. A version-3 project rule file sets
each check's policy under `checks`: whether it runs, its severity, its scope and its parameters,
over a `default` or `none` preset. Version-1 and version-2 files keep loading, and their
`disabledLocalizationChecks`, `segmentSeparator` (text such as `"//"` that joins a line's
segments and must appear as often in each translation), `optionalTags` (rich-text tags a
translation may add or leave out) and `optionalArguments` (arguments the game always supplies)
read as the equivalent check settings; `migrateGameTextRuleDocument` rewrites them as version 3.
A check's scope (cultures, roles, object path prefixes) is applied after it finds something, and a
check that takes another's finding (a placeholder translation instead of its length) does so only
when it runs and is in scope, so an out-of-scope check never hides an in-scope one. None changes
the source rules. `localizationCheckCatalogue` describes every check: whether
it models Unreal (`unreal`) or is a judgment (`heuristic`), its label, default severity, parameter
schema with defaults and a condition text generated from those parameters. The package README's
check table is generated from it, so hosts can show the same descriptions instead of writing their
own.

This falls short of [base, not constraints](../vision-and-architecture.md#base-not-constraints).
The parsers follow Unreal, and a version-3 rule file now sets each built-in's severity and the
heuristics' thresholds and word lists (length ratios, placeholder words and markers, short-text
limits). Some policy is still fixed in code (the audience and debug-content rules behind
`culture_invariant_text`, boundary whitespace policy) and is open work. A version-3 file can define
its own checks (`customChecks`: patterns, lengths and forbidden terms on the source or each
translation, each scoped by culture, role and path) that report beside the built-ins with the same
evidence, review and workspace model.
Hosts whose projects cannot store translator notes (packages saved by UE 4.27 and by UE5 before 5.8;
String Tables and UE 5.8+ can) can pass `disabledChecks: ["missing_translator_notes"]`.

Indexed hosts run these checks through an opened model's `localizationQuality(ruleDocument?,
options?)`, which checks the join in pages of 256 lines and yields between them. On large
targets the scan takes minutes, so it reports `localization_quality` progress through
`GameTextIndexProgressReporter`, the same reporter index refreshes use: `{ completed, total,
findings }` once before the scan and after each page; `total` is known from the first event, so a
host can show a percentage. Progress does not change the findings, their order or IDs. The
reporter must be cheap and must not throw.

Notes, shared source text and the source checks are facts about the source line, not a translation.
They report once per line, under the target's native culture, or the line's first culture in the
target by code when it has no native one. The all-cultures list counts each such line once;
selecting the native culture shows them; selecting another culture does not. Shared source text
reports once per text, on its first key. "Translated inconsistently" reports, per culture, each line
of a shared source whose translation is not the one most lines use (every line when several tie):
each finding is one line a translator can open and fix or accept.

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
- In Workbench, a non-native culture's translation can be edited on the line page, starting
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
- the line page shows both the PO translation and the translation the game currently uses;
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
- In Workbench, the line page shows "Review <culture>" toggles for each flag, and a check
  finding offers "Accept as intended". **Mark reviewed** in the bulk bar sets "Reviewed" for every
  ticked line.

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

- In Workbench, the **Key changed** group (or Filter → Problem → Key changed) lists the new keys.
  The line page shows the earlier key, how it was paired, any text change, and the translations
  the earlier key shipped.
- **Carry translations** stages those translations for the new key, as hand edits are staged. The
  staged panel then guides the steps: gather, export, **Write to PO**, then sync. When the text
  changed too, the action reads **Carry anyway**, because the translations were written for the
  earlier text. **Carry translations** in the bulk bar stages every ticked key change whose text
  did not change.
- A change's previous translation matches whether it was absent or empty, so an edit staged
  before the gather is still current after it (ADR 0009 addendum).
- **Gather and export** (`ue-shed loc run prepare`) runs Unreal's gather, then its PO export, in
  one GatherText process. Dashboard targets run their Gather and Export configs; a config-only
  target needs one recipe that gathers, writes the manifest and exports.
- When UE Shed runs a gather, it keeps the target's translations from before the run and pairs
  keys that left the manifest with keys that joined it. This covers C++ and config text, such as
  a cherry-picked `LOCTEXT` change. Workbench shows those pairs as **Key changed** until the
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
changed-file filters. Picked cultures limit the columns to the native culture and those cultures;
a search request's `lines` limits the rows to the lines it names, as the Workbench selection does. In Workbench it is **Export → All languages (CSV)** while a target is
selected; from the CLI, `ue-shed loc export <project-root> --target <name> --output <new.csv>`
takes the `loc status` filters and never overwrites a file. The CSV is for reading and sharing,
with the usual spreadsheet protections (UTF-8 BOM, CRLF, a leading apostrophe before formula
characters). Edits still go through PO change sets.

### Checking a change before submit

`ue-shed loc gate <project-root> --files <list-file>` checks the text in a change's files and exits
`0` when it passes, `1` when it fails and `2` when it could not check. It only reads, and a failure
is only an exit code and a list: it stops a submit only where a team wires it into a submit script
or a required build. It judges every line whose text lives in a listed file, as the files are on
disk now, so a problem already in a touched file counts too.

| Check                     | Default | When                                                                        |
| ------------------------- | ------- | --------------------------------------------------------------------------- |
| `key_changed`             | fails   | A key changed and its earlier key has translations the next gather drops    |
| `conflicting_source`      | fails   | One key has two texts, so Unreal ships one of them everywhere               |
| `translated_text_changed` | fails   | Translated text changed; those languages show it untranslated until redone  |
| `text_changed`            | warns   | Text changed since the last gather, with nothing translated yet             |
| `not_gathered`            | warns   | New text Unreal has not gathered, including a key change that loses nothing |
| `unresolved_key`          | warns   | Text without a reliable key, which cannot be translated                     |
| `removed`                 | warns   | Gathered text its file no longer has, or a file that could not be read      |
| `gathered_source`         | warns   | Text in a changed C++ or config file, whose keys show only after a gather   |

- `--fail-on <check>` and `--warn-on <check>` (repeatable) change the defaults for a project.
- `--target <name>` (repeatable) picks targets. Without it every target is checked, and a target
  with no manifest (Unreal has never gathered it) is listed as skipped; a named target must have
  one.
- It never judges what it cannot see. A manifest, archive or PO file that exists but cannot be
  read, or a listed package the scan could not read completely, stops the check with exit `2`
  rather than passing it. A missing archive or PO file means nothing is translated.
- The output is JSON: `status` (`passed` or `failed`), and per target the lines checked, a count
  per check, up to 200 lines with their check, key, text, file and a way forward, and the
  changed-file summary. A run that could not check prints `status: "not_checked"` with the error.
  `--summary` prints the same verdict as a few lines for a pre-submit dialog.
- The list file is the one `--files` takes elsewhere: one path per line from any version control
  tool, relative to the project folder or absolute. With Git, run
  `git diff --cached --name-only --relative > changed.txt` in the project folder to list a staged
  change; with Perforce, list the changelist's opened files and map them to local paths.
- Run it where the change is: on the submitter's machine, or in a build that has the change
  applied. A Perforce server trigger has no workspace to read.
- C++ and config key changes show only across a gather UE Shed runs, so changed source files that
  hold gathered text only warn.
- Fixes are made in Unreal (ADR 0009 addendum); the way forward names the step, such as carrying
  translations with `loc run prepare --carry`.

### Fixing keys in assets

Key fixes run in Unreal through the separately enabled `UEShedGameText` editor plugin
([ADR 0011](../decisions/0011-game-text-actions.md)), over Remote Control or its commandlet. A
host sends `runGameTextActions` a `ue-shed-game-text-actions` request; each action names a place
(scanned package file, object path and the reader's property chain), the namespace, key and source the host reviewed, and
one edit:

- `change_key` gives the text a namespace and key; `regenerate_key` gives it a new random key;
- `adopt_key` makes it the same text as another id (namespace, key and source), for example to merge
  a Content Browser duplicate back into the original's id;
- `change_source` retypes the source; Unreal keeps the key only if no other text in the package
  uses it.

`gameTextActionForOccurrence` builds an action from a text the reader found. Edits use the editor's
own id rules, so a requested key Unreal would not keep fails as `key_conflict` instead of being
replaced silently. Run a dry run first: it reports each outcome and the packages an apply would
write, so the host can check them out (UE Shed never does). An apply compiles each owning
Blueprint without implicit Save on Compile, reads each place back and saves only when asked. A
compile/readback failure verifies restoration before reporting rollback. A partial save failure
retains applied outcomes and generated keys, with separate package persistence states; inspect and
reconcile those results before explicitly saving outstanding state through Unreal. Never replay the
edits as save recovery. After saving, `verifyGameTextActions` compares the reader's re-read with the
editor's result, binding even serialized original paths to their actual package files.
DataTable cells keep using Authoring Apply 1.2; graph pins are not action places yet.

### Comparing two copies of a package

`diffPackageText(before, after)` compares the text records the reader produced for two copies of
one package, for example the depot's head revision and the local file, and lists what changed place
by place:

- **added** and **removed**: text at a place only one copy has;
- **re-keyed**: the same place with another id (namespace and key, String Table reference, or a key
  that became culture invariant), with whether the text changed too;
- **edited**: the same place and id with other source text or translator notes.

Places match by their position inside the package (object path below the package name, then the
row, entry or property chain), not by the package's saved name, so a branch copy lines up with its
original. Text that moved to another place reads as removed and added; pairing moves is the
caller's policy, as in [Key changes](#key-changes). A diff is marked incomplete when either copy was
read only in part. It is a pure function: fetching the earlier revision stays with the host (Plan
052 Phase 3).

### Source control

Manifests, archives and PO files are usually checked in. The core reports which files an operation
may write before it runs, so a host can check them out. UE Shed never passes Unreal's source control
switches and never submits. Hosts own source control.

### Workbench presentation

The Game Text route uses one toolbar row (view tabs, target and cultures, the not-synced count with
**Sync with Unreal**, **Unreal steps**, one coverage line and Rescan) and gives the rest of the
window to the list and its side pane, or to one line's page. Rows keep the user's words: the text
first, then where it lives, then what the line needs. The line page stacks every culture with its
translation, state, checks, review and edit field. Work across many lines goes through the bulk bar
rather than a side-by-side grid. See [Reviewing text in Workbench](#reviewing-text-in-workbench).

## Explicitly out of scope

Out of scope for the shipped product:

- another filesystem enumeration, scanner, corpus, or persistence adapter;
- direct package or source-text mutation, and source Apply or Save from Game Text; fixes inside
  assets, such as changing a key, are applied by Unreal or a UE Shed editor plugin (ADR 0009);
- localization writes other than the bounded ones above: atomic PO `msgstr` changes, the review
  file, and the files Unreal's own processes write;
- rendered-width estimation or engine-specific font/layout simulation;
- built-in studio terminology, roles, paths, cultures, or budgets;
- full-corpus renderer IPC, renderer filesystem authority, or UI-owned rule evaluation;
- telemetry containing authored text or rule evidence;
- UE Shed writing manifests, archives, `.locres` or `.locmeta` itself;
- linking text to translations by matching source strings;
- translation memory, machine translation services, vendors, assignment and billing;
- voice lines and dialogue; and
- source control operations inside the core.

The broader localization and authoring direction remains in
[`docs/ideas/game-text-workbench.md`](../ideas/game-text-workbench.md), which is vision rather than
the shipped implementation contract.

# `@ue-shed/game-text`

Headless saved-package corpus discovery and search for player-facing Unreal Engine text. The
package keeps Unreal namespace/key identity distinct from occurrence identity, reports scan
coverage, and returns bounded search and focus results. Saved packages are evidence only; this
package does not mutate assets.

Each occurrence retains saved translator notes as `devNotes`. UE 5.8 keyed text and StringTable
entries can supply them; older packages and empty notes produce `""`. Notes stay separate from the
source string and localization identity.

## Install

Pin the package and the host's Effect runtime exactly:

```sh
npm install --save-exact @ue-shed/game-text effect@4.0.0-beta.98
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

Compose `TextCorpusServiceLive` with one scoped `AssetReader` layer in the trusted Node host. Keep
the resulting corpus and `textCorpusQuery(corpus)` model in that host, and send only bounded summary,
search, and focus results over the host's validated transport.

Use `scanFromProjectIndex` when the host already maintains a saved-project header index. Otherwise,
`scan` performs its own bounded project scan. Both paths preserve coverage and typed recovery
guidance.

The `@ue-shed/game-text/browser` entry point contains only schemas and pure query helpers. It does
not expose filesystem, process, Electron, Perforce, or Unreal authority.

The package also exports a pure compact snapshot codec from both entry points and the Effect
`SnapshotStore` with `snapshotStoreNodeLayer` from the Node entry point. These support the
upcoming persistent corpus layers; current query hosts still use the in-memory model. See the
[snapshot engineering guide](../../docs/engineering/game-text-snapshots.md) for the format, caps,
immutable publication and recovery behavior. `reader.domain()` bulk-loads one source, identity,
translation or path domain; `reader.strings()` keeps page reads limited to touched blocks.
`SharedIndex` with `sharedIndexNodeLayer` stores one deduplicated string ID space per project and
target. Localization imports use independent content keys, immutable string segments and atomic
generation publication; compaction remaps active layers while existing readers retain their handles.

Search pages include fixed-size `counts` for the current source query, capability, review filter,
and `withoutNotes` toggle. `counts.all` equals the page's full `total`, independent of pagination.
Review counts intersect every active filter; a toggle's count excludes that toggle itself so callers
can show how many lines are available when it is enabled. Notes match only when every saved location
has empty notes after trimming. An omitted `withoutNotes` means false.

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

The checks are `format_arguments`, `argument_modifiers`, `rich_text`, `po_escape_safety`,
`whitespace`, `empty_translation`, `missing_translator_notes`, and `duplicate_source`. Pass
`{ culture?, checks?, disabledChecks? }` to select them. They need no rule document; existing v1
`Config/UEShed/GameTextRules.json` documents can optionally contain `disabledLocalizationChecks`.
Version 2 adds per-culture project policy and progress reports, described below.

Checks use the pending non-empty PO text when the culture has a `not_synced` fact, otherwise archive
text. They compare with manifest source, falling back to corpus source with a diagnostic. Crowdin
uses manifest source too. Empty PO/archive entries are reported independently of missing files.
`checkDiagnostics` retain the join's unknown reasons and Crowdin's reduced checking, and explain
unavailable source/translation, unsupported cultures and syntax limits.
Syntax is capped at one million code units and 16 nested modifier forms. Coverage is not upgraded
when a syntax check succeeds on a partial corpus.

`parseUnrealFormatPattern`, `unrealPluralForms`, and `unrealRichTextCounts` expose the verified
Unreal grammar helpers. Required plural categories come from the identical ICU 64 category data
in the supported engines, rather than host `Intl.PluralRules`. Rich-text validation mirrors compile
tag counts, including tolerated source imbalance, self-closing tags and `<br>`. Unreal does not
validate matching argument names against source, missing/added modifiers, malformed parameters
that become literals, source-relative whitespace/line-break drift, empty entries, notes, duplicates
or PO escape safety; those additional checks are UE Shed findings.

Exactly one missing and one added argument can stage a rename in `report.changes`; nested form
renames preserve the grammar and revalidate the argument set. Each change records target, culture,
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
`disabledLocalizationChecks`. See [the v2 example](fixtures/quality-rules.v2.json) for an authored
document; its limits and terms are examples, not built-ins.

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

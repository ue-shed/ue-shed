# UAsset IO protocol v1

The checked-in JSON Schemas in this directory are the language-neutral authority for the UAsset
process seam. A caller writes one request to the uasset protocol command's stdin. The command writes
one NDJSON event stream to stdout.

Version 1 carries the complete request envelope, stream-control events, and typed result frames.
Every frame carries the same contract, requestId, and sequence. A supported request begins with
accepted and ends with exactly one terminal event. Sequence is contiguous from zero; completed, failed,
and rejected are terminal. An explicitly supplied empty paths array means zero work and must not
select a project root.

Minor version 1.1 adds bounded Project Index operations (`project_index_status`,
`project_index_refresh`, `project_index_rebuild`, `project_index_query`) and their typed result
frames. Version 1.0 operations and the cumulative meaning of `maximumOutputBytes` remain unchanged.
Paired TypeScript and native workers negotiate additive operations; a worker that cannot decode an
operation rejects it before `accepted`.

Minor version 1.2 adds the single-package `blueprint` operation and its versioned saved-graph
projection. It carries editor graph nodes, arbitrary tagged node properties, native pin data, and
deduplicated links without requiring Unreal Engine to load the asset. Graph membership drives
discovery of engine, plugin, and project graph/node subclasses; unsupported saved revisions and
Control Rig's separate RigVM model fail explicitly.

Minor version 1.3 adds optional `pageEncoding: "dictionary"` to `project_index_query` and the
`project_index_dictionary_page` result. The page carries a local `strings` array; header `classes`
and `serializedNames` are zero-based references into it. Map items, paths, item ordering, generation,
and cursors retain their existing meaning. Each page is independent, with at most 1,024 items,
64 references per header field, and 131,072 dictionary strings. Decoders must reject references
outside that page's dictionary before expanding them. This relational check supplements JSON Schema.
Public library query results expand to the original string arrays. Omitting `pageEncoding` retains
the original result format; an older worker rejects the new field before accepting the request.

Minor version 1.4 adds `project_index_count`, available in both `protocol` and `protocol-session`.
Its `request` carries `projectId`, `expectedGeneration`, and between 1 and 16 `filters`. Filters use
the existing query kinds and value bounds, without pagination fields. The result carries the same
identity and generation plus `count`: the number of distinct package paths matching any filter.
Overlapping filters, including map and header matches for the same package, count once. Counts read
the immutable inventory and checked postings without hydrating package evidence. Stale generations
and corrupt postings fail with the same typed errors as queries. Old workers reject the operation
before accepting it.

Minor version 1.5 added `level_sequence` in both `protocol` and `protocol-session`. Version 1.6
advances its result to schema-5 with typed discrete channels. Its request carries `assetPath`.
Decode diagnostics, projection
coverage gaps and reference coverage gaps make the terminal outcome partial. Blueprint and
Level Sequence reads are bounded to 64 MiB before parsing. Older workers reject the new operation
before acceptance. Native/WASM fixture conformance checks the same sequence record fields.

Minor version 1.7 advances `level_sequence` records to schema 6 and `blueprint` records to schema 2.
Sequence records add shared section settings, the separately saved camera-cut track, scoped cut IDs,
possessable/spawnable metadata, and string/object channels. Blueprint records add saved declarations,
CDO overrides and construction component/template inventory. Missing fields and unsupported native
bytes remain explicit nullable evidence or coverage gaps. The public readers request minor 1.7 and
validate these record versions; older result shapes are rejected at the boundary. Optional `native_data`
retains source-checked actor/component instance records separately from tagged properties in generic
inspection and Blueprint saved objects. Unknown subclass bytes remain explicit gaps.

Minor version 1.8 adds the opt-in `extract_text_packages` operation and result kind. Its selection
and limits match `extract_text`; hosts request minor 8 and validate that result kind. Older
workers reject the new operation before acceptance, and new workers reject it below minor 8.
Each `text_package_record` preserves all occurrence fields, carries package status and
`decodeErrors`, and replaces individual gaps with `gapCounts` by all four existing reasons plus
at most three `gapSamples`. The sampling rule preserves the first gap, then prefers unsupported
histories for the two remaining slots, matching today's corpus diagnostics. `text_summary` and
outer scan diagnostics retain their existing meaning. `extract_text` continues to emit each
occurrence, gap and package event for existing consumers. Cumulative output limits still apply.
The native producer bounds an encoded package-text frame to 64 MiB and reports `resource_limit`
before emitting an oversized frame. Consumers can explicitly retain the legacy stream for such
packages. This producer limit supplements structural schema validation.

Minor version 1.9 adds optional package-header gather evidence to saved header scans and both
Project Index header page encodings. `PackageHeaderData` retains raw `packageFlags`,
`gatherableTextDataCount`, `gatherableTextDataOffset`, and an exact `hasTextProperty` name-map
probe. New workers suppress these fields below minor 9 so strict old decoders retain their
existing shapes. Saved scans request this minor through `headerData: true`; public Project Index
queries request minor 9. A missing optional field is an upgrade requirement before pruning,
not evidence that the package contains no text. The package-record operation remains minor 8.

Minor version 1.10 adds optional `gatherCoverage` to `text_package_record`. The worker reads the
package summary's gatherable text table (the text Unreal's localization gather collects from that
package) and checks each runtime, non-editor-only site against the decoded occurrences by
namespace and key. `runtimeSites` counts those sites, `missing` counts sites no occurrence matched,
and `missingSamples` keeps the first three with their source string and Unreal site description.
Whenever the worker reads the table, `status` is `partial` only if `missing` is non-zero:
undecodable properties that hold no gatherable text no longer make a package partial, and
`gapCounts` and `gapSamples` remain detail. The worker reads the table only when Unreal's asset gather
would (`CalculatePackageLocCacheState`); packages Unreal loads instead, such as Blueprints with
bytecode, which are saved without a table, keep the decode-error-or-gap rule, as do packages
saved before the table existed and unreadable tables. The worker decides status before negotiation and
strips `gatherCoverage` below minor 10, so a minor 8 or 9 record can be `complete` with non-zero
gaps, and a missing field does not say which rule applied. The status rule also applies to
`text_package` events and terminal partial outcomes; the gather table cannot see Blueprint script
bytecode text, so `complete` still does not certify parity with a fresh gather.

Minor version 1.11 adds optional `gather_editor_only` to each occurrence of a `text_package_record`.
When the worker reads the package's gather table (under the 1.10 rule), every keyed occurrence whose
namespace, key and source the table lists carries Unreal's editor-only bit for that text:
`IsEditorOnly` from its site contexts, `true` only when every site with that namespace, key and
source is editor-only, since a gather that skips editor-only data still collects text with one
runtime site. Namespaces are matched as coverage matches them: a serialized `FText` loses its
package marker once, a String Table entry keeps its authored namespace. A missing field means the
table was not read or does not list the text; it is not evidence of runtime text. The worker strips
the field below minor 11. `text_occurrence` events are unchanged.

Minor version 1.12 adds optional `blueprintClasses` to a `text_package_record`: one entry for each
decoded object in the package whose saved `GeneratedClass` names an export of the same package
(a Blueprint). `generatedClass` is that export; `classDefault` is the one export flagged
`RF_ClassDefaultObject` whose class is the generated class. `SkeletonGeneratedClass` is transient,
so `skeletonClass` is present only when the package saved a top-level export of the generated
class's own class named `SKEL_` plus the generated class's name, with `skeletonClassDefault` its
default object. Paths are spelled like occurrence object paths. Text saved under these exports is a
compiled representation copy of the Blueprint's authored text; consumers can fold it into the
authored site. The field is omitted when the package has no Blueprint, and the worker strips it
below minor 12.

Minor version 1.14 adds optional `field` and `offset` context to inspection decode errors, including
full-depth scan results. The worker suppresses both keys for earlier protocol minors so existing
strict consumers retain the original error shape. Current public inspection and full-scan readers
request minor 14; their optional fields also accept older workers that omit this context. Header
scans keep their existing minor negotiation. This does not alter decode-error counts or partial status.

Minor version 1.17 adds optional `packageName` to a `text_package_record`: the package name its
summary serializes, which the record's object paths are built from. Unreal names a package from
its file's location, so a file moved or copied outside Unreal keeps an old name here; a host can
compare it with the name the file's location gives and move the package's own paths. UE 4.27
packages that save `None` report `None`, with package-relative paths. The same minor adds optional
`assetClass`: the class of the package's main asset, chosen as Unreal's loader does (the export
flagged as an asset and named after the package's file, else the first such export). An actor
saved in its own package reports the class of the world it belongs to. The field is absent when no
export is flagged as an asset. The worker strips both fields below minor 17.

Result frames use an explicit result kind. Generic inspection, authoring, scan, compact text,
compact texture, Blueprint graph, and saved-world values each have a named schema; there is no
untyped result field.
The shared inspection schemas are exported from `@ue-shed/protocol` so the Effect reader and the
Rust worker can converge on one wire shape.

Expected request or operation failures use rejected or failed and exit 0. Non-zero process exits are
reserved for failures that prevent the command from establishing or completing the protocol stream.
Existing human command exit behavior remains unchanged.

Change JSON Schema and fixtures first, keep Effect schemas conformant with
pnpm --filter @ue-shed/protocol contract:check, then add Rust conformance coverage.

The TypeScript and Rust sides both run the complete shared fixture set. TypeScript coverage is in
`packages/protocol/src/uasset-io.test.ts`; Rust coverage is `cargo test -p uasset-io protocol`.
Adding a result variant requires a valid fixture that both tests decode, plus an invalid fixture when
the boundary rule needs a rejection case.

### Saved translator notes

Generic keyed-text values may include `dev_notes`; new producers emit it even when empty.
StringTable entries and compact text occurrences also carry `dev_notes`. Consumers default missing
entry/occurrence notes from older producers to `""`. This additive evidence does not change the
source-only authoring value contract. The package decoder gates the serialized FString on
FortniteMain custom version >= 260 and the absence of `FILTER_EDITOR_ONLY`.

Minor version 1.18 adds optional `textGapCounts` to `text_package_record`, with the same four
reason keys and nonnegative integer counts as `gapCounts`. It counts only gaps whose undecoded
bytes may contain FText. Gap samples and streamed `text_coverage_gap` values add optional boolean
`may_contain_text`; absent classification from an older reader means unknown (text-capable).
Every gap remains reported. Without a usable saved gather table, only text-capable gaps or decode
errors make a package partial; with a usable table, only missing runtime gather entries do. Undecoded graph pins remain partial even when a runtime table is usable. The worker strips
both new fields below minor 18, including classifications on individually streamed gaps.

Minor version 1.19 adds optional `staging` to `extract_text_packages`: a directory and one group
number below 4096 for each requested path. The worker then writes each package's record, or its
package `error`, as one JSON line (the same object a `text_package_record` result carries) to
`<directory>/<group>.ndjson`, and streams a `staged_text_package` result with the package path,
group and line size in its place. Lines and staged results follow completion order, not path
order. The directory must exist and hold none of the group files; the worker creates each file it
writes and flushes them all before the summary. The closing `text_summary` is unchanged. Staging
needs explicit paths and is rejected below minor 19. A host reads each group in its own worker, so
package text never crosses the host's event stream.

# @ue-shed/localization

Read saved Unreal localization evidence without Unreal, an asset scan, or Workbench. The package
has no Game Text dependency. It supports the committed Unreal 4.27, 5.7 and 5.8 format layouts.

- `@ue-shed/localization`: Effect evidence and Unreal process services and Layers, plus pure exports.
- `@ue-shed/localization/browser`: schemas, branded identifiers and pure decoders; no Node IO.

The readers cover Dashboard target settings in `Config/DefaultEditor.ini`, authored and generated
`Config/Localization/*.ini` recipes, version-1 manifests, version-2 archives, UTF-8 PO files in
Unreal and Crowdin formats, `.locmeta` versions 0–2, and word-count CSV reports. They do not decode
`.locres` or interpret conflict report text.

```ts
import { Effect } from "effect";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";

const program = Effect.gen(function* () {
	const reader = yield* LocalizationEvidence;
	const report = yield* reader.targets({ projectRoot: "/project" });
	const target = report.targets.find((item) => item.name === "Game");
	if (target === undefined) return report;
	return yield* reader.read({ projectRoot: "/project", target });
}).pipe(Effect.provide(LocalizationEvidenceNodeLive));
```

The host owns the Effect runtime exit. `discover` reads configuration, `targets` additionally
inspects output presence, and `read` returns target evidence with independent file outcomes and
SHA-256 provenance. Missing or malformed culture files do not discard other cultures. Error
messages and telemetry contain codes and counts; explicit evidence contains private authored data
and project-relative paths. Keep evidence out of ordinary telemetry.

Pure decoders return `Result<value, LocalizationError>`. Their output schemas own inferred types.
Lists and opaque JSON metadata are frozen. Duplicate manifest/archive identities remain separate
entries with diagnostics; no text matching or conflict resolution happens here.

Target evidence retains compact PO entries with decoded comments and format/source flags, rather
than raw lines and field offsets. Repeated source context is shared within a read. `parsePO` still
returns a full byte-exact document for `serializePO` and the PO writer. Change-set apply rereads each
PO and checks its hash against the reviewed evidence before rewriting it. Hosts constructing target
evidence themselves can convert a parsed document with `projectPOEvidence`.

## Headless Unreal operations

`LocalizationOperations` / `LocalizationOperationsNodeLive` add an optional engine capability.
`plan(request)` returns version-1 config, argument, step and files-to-write evidence without
launching or creating a log directory. `run(request)` returns a bounded Effect stream of process
start, step start/completion, and receipt events. Requests select a parsed target and `gather`,
`import`, `export`, `compile`, `reports` or `sync`; engine discovery follows the project's
association, with an optional `explicitEngineRoot` override. The Node-only `@ue-shed/engine`
dependency owns discovery and process-tree supervision. The browser entry exposes only schemas,
`planLocalizationOperation`, `availableLocalizationOperations` and log-boundary parsing.

```ts
import { Effect, Stream } from "effect";
import { LocalizationOperations, LocalizationOperationsNodeLive } from "@ue-shed/localization";

// `target` is a LocalizationTarget returned by LocalizationEvidence.discover.
const run = Effect.flatMap(LocalizationOperations, (operations) =>
	operations
		.run({ projectRoot: "/project", target, operation: "sync", timeoutSeconds: 1800 })
		.pipe(Stream.runCollect)
).pipe(Effect.provide(LocalizationOperationsNodeLive));
```

Review `plan.files` and arrange checkout in the host before running. Sync supplies Import then
Compile to one `GatherText -Config=a;b` process. UE 4.27 runs configs in order; UE 5.7/5.8 schedule
the Import phase before Compile. This avoids a second engine startup. Dashboard operations select
their corresponding existing configs. A config-only target runs its entire authored recipe;
`wholeRecipe` and the complete write list make those additional effects explicit. Only operations
present in its steps are offered; the committed 4.27 recipe offers gather/export/compile/reports,
not import or sync. UE Shed does not generate recipes or use Unreal's Preview mode as a dry run.

The planner respects section overrides, cultures, PO culture-directory flags, report enable flags,
resource names and version-specific conflict extensions. It rejects custom commandlets, platform
splitting and asset repair/cache-report modes whose complete writes are not modeled. Paths must
stay under the project; engine substitutions, traversal and symlink escapes are rejected. The
runner re-reads configs before launch and rejects changes from the discovered target.

The commandlet writes a private log outside the project. It is tailed in 64-KiB chunks, with a
64-event backpressure queue, at most 8192 characters of incomplete line and 40 private excerpt
lines of 2048 characters each. Logs over 256 MiB fail explicitly. Receipts and failures name the
retained log; hosts own retention and should keep it out of telemetry. Timeout defaults to 1800
seconds (explicit range 1–86400). Ending or interrupting the stream terminates the owned process
tree. Effect interruption remains interruption; a process reported as terminated returns the
typed `cancelled` failure. Failed cleanup remains visible rather than silently accepting orphans.
Nonzero exits, timeouts and cancellation are not safe automatic retries: inspect partial output
and plan again. Editor/file locks are detected only when Unreal reports a sharing violation or
that another process holds the file; no running-editor presence is guessed.

Receipts compare SHA-256 before/after across durable project files, including changes outside the
target. Unplanned changes produce `planning_defect` and named diagnostics. The plan explicitly
lists excluded build/scratch directories (`Saved`, `Intermediate`, `DerivedDataCache`, `Binaries`,
`.git`, `.vs`, `node_modules`, at any depth); those are outside this content audit. An audit is
bounded to 100000 entries, 512 MiB per file and 2 GiB total, hashing in 64-KiB buffers. Schema,
telemetry and error messages carry operation/count/code data; private paths and text occur only
in explicit plans, receipts and log excerpts. No source-control switches or submissions are used.

CLI: `ue-shed loc run <operation> <project-root> --target <name> [--engine-root <path>] [--plan]
[--timeout <seconds>] [--json]`. `--plan` prints JSON without launching. A run prints human step
progress to stderr and a JSON receipt, or schema-versioned NDJSON with `--json`. `reports` means
Unreal's report commandlet; `loc report` remains UE Shed's own progress/baseline report.

`pnpm test:localization-processes` is separate from portable tests. It uses configured
`UE_SHED_UNREAL_57_ROOT`, `UE_SHED_UNREAL_58_ROOT` and optional `UE_SHED_UNREAL_427_ROOT`, disposable
copies, actual owned processes, cancellation and a test-only PO edit followed by sync. It retains
plans, receipts, copies and logs under `out/localization-processes`. No fixtures ship in the npm
package. Readers remain read-only; UE Shed never writes manifests, archives, `.locres` or
`.locmeta`. Only the launched Unreal process produces those outputs.

Targets from Dashboard settings have `source: "dashboard_settings"`. Recipes without Dashboard
settings have `source: "config_only"`, use the manifest basename as the target name, and retain
each recipe and step. The native culture is `null` when Dashboard has no native selection.
Configuration reads reuse Config Explorer's INI parser and array-operation fold. Repeated
unprefixed array fields in authored recipes use Unreal's `GetArray` behavior.

The PO document stores the UTF-8 BOM and ordered header, entry and trivia blocks. Each block keeps
every original line and line ending. Fields carry block-local line indices, including continuation
lines, alongside decoded strings. `serializePO(parsePO(bytes).success)` reproduces valid input
byte for byte, including mixed endings and a missing final newline. Serialization uses raw lines;
decoded fields are a read-only view, not an editing API. Crowdin documents have `hasSourceText:
false` in the identity-and-source collapse mode; their identities come from `msgid`, so later stale
checks can report reduced checking. The legacy namespace collapse mode retains source text in both
formats and may carry a namespace without a key. Pass `collapseMode` when decoding that layout.
Unreal's replacement-order escape decoding is preserved, including its literal-backslash caveat.

Defaults cap each file at 320 MiB and 1,000,000 entries, nesting at 64, and a target read at
2,560 files. Entry limits apply per file, independently of other cultures and evidence files.
Pass an explicit `limits` value to change them.
Node reads reject project-root
escapes, external symlinks, and unresolved engine-root tokens. Conflicting output locations return
an `ambiguous_config` diagnostic rather than selecting one implicitly.

The format and evidence APIs are read-only. UE Shed never writes manifests, archives, `.locres`, or
`.locmeta`. The optional process service creates a private log directory and delegates
localization outputs to Unreal. Unreal remains responsible for import, export and compilation.

Translation edits are written only through change sets, into PO files.

**`reviewLocalizationChangeSet(evidence, changeSet)`** (browser) checks every change against freshly
read evidence. Each change gets one outcome:

- `ready`
- `unchanged`
- `wrong_target`
- `culture_unavailable`
- `not_in_manifest`
- `stale_source`
- `not_in_po`
- `po_out_of_date`
- `stale_translation`

A change's replaced translation must equal what ships next: a non-empty PO `msgstr`, or otherwise
the archive translation. The review also lists the PO files a write would replace, so hosts can
check them out first.

**`replacePOTranslations(document, edits)`** (browser) replaces only the identified singular
`msgstr` lines. It escapes as Unreal's PO exporter does. It rejects edits that are plural, missing,
ambiguous or duplicated, and translations that Unreal's PO import would alter. It re-parses its
result to prove that every other byte is unchanged.

**`applyLocalizationChangeSet`** (Node) reviews, then writes each culture's PO file. If any change
is stale it writes nothing, unless `skipStale` is set. Each write lands in a file beside the
target, which is then renamed over it, and only while the target still hashes to what was read.
It returns a receipt.

`LocalizationChange` and `LocalizationChangeSet` are browser-safe version-1 proposal schemas,
not writers. Each change names target/culture/namespace/key, source, `previousTranslation` (null
means absent; empty string remains distinct), and the proposed `translation`. The document adds
`schemaVersion: 1` and provenance (`producer` and evidence `files`).
`decodeLocalizationChangeSet(json)` returns a typed safe failure for invalid versions, malformed
fields or duplicate identities. A future writer must revalidate source and previous translation
before applying a change. There is no change-set file IO or apply API in this package.
Game Text checks produce these proposals; `ue-shed loc check --changes <new-file.json>` can
exclusively create the proposal JSON without touching localization files.

Review state is UE Shed-owned project data, one file per target at
`defaultLocalizationReviewPath(target)` (`Config/UEShed/Localization/<Target>.review.json`).

**`decodeLocalizationReviewFile(text, target)`** and **`encodeLocalizationReviewFile(file)`**
(browser) read and write version 1. Encoding sorts records and accepted findings by culture,
namespace and key, so diffs stay minimal. **`updateLocalizationReviewFile(file, updates, stamp)`**
applies `set`, `clear`, `accept` and `unaccept` updates. Setting flags on a line whose fingerprint
changed replaces its old flags rather than merging them.

**`localizationEvidenceFingerprint(evidence, culture, identity)`** fingerprints the manifest source
and the translation that ships next. A record whose fingerprint differs from the current evidence
is changed since review.

**`readLocalizationReview(location)`** and **`updateLocalizationReview(location, updates, stamp,
expected?)`** (Node) read and write the file. A missing file reads as empty with a null
`contentHash`. The first write creates the file exclusively; later writes replace it atomically
and only while it still hashes to `expected`.

Tests decode committed manifest and archive bytes from both 5.7 and 5.8 against Unreal's
version-specific evidence oracles, including 5.8 `DevNotes`. The unchanged 5.8 files live under
`fixtures/unreal-project/FixtureExpected/localization/ue5.8-output`; its PO files also have
byte-exact round-trip tests, and its locmeta and word-count CSV are decoded directly.

CLI: `ue-shed loc targets <project-root>` prints schema-versioned target settings, discovered
configs, output paths, and culture file presence. `@ue-shed/game-text` consumes the browser entry
to join saved corpus identities, compute coverage-qualified states, and expose bounded queries and
`ue-shed loc status` reports. This package remains independent of the corpus. Hosts can use the separately enabled process service to import and
compile translations.

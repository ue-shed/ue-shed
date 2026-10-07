# @ue-shed/localization

Read saved Unreal localization evidence without Unreal, an asset scan, or Workbench. The package
has no Game Text dependency. It supports the committed Unreal 4.27, 5.7 and 5.8 format layouts.

- `@ue-shed/localization`: Effect IO services and Layers, plus the pure exports.
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

Defaults cap each file at 32 MiB, decoded files and total target evidence at 100,000 entries,
nesting at 64, and a target read at 256 files. Pass an explicit `limits` value to change them.
Node reads reject project-root
escapes, external symlinks, and unresolved engine-root tokens. Conflicting output locations return
an `ambiguous_config` diagnostic rather than selecting one implicitly.

This package is read-only. It exposes no filesystem write or translation edit API. UE Shed never
writes manifests, archives, `.locres`, or `.locmeta`. A future change-set writer will own PO edits;
Unreal remains responsible for import, export and compilation.

`LocalizationChange` and `LocalizationChangeSet` are browser-safe version-1 proposal schemas,
not writers. Each change names target/culture/namespace/key, source, `previousTranslation` (null
means absent; empty string remains distinct), and the proposed `translation`. The document adds
`schemaVersion: 1` and provenance (`producer` and evidence `files`).
`decodeLocalizationChangeSet(json)` returns a typed safe failure for invalid versions, malformed
fields or duplicate identities. A future writer must revalidate source and previous translation
before applying a change. There is no change-set file IO or apply API in this package.
Game Text checks produce these proposals; `ue-shed loc check --changes <new-file.json>` can
exclusively create the proposal JSON without touching localization files.

Tests decode committed manifest and archive bytes from both 5.7 and 5.8 against Unreal's
version-specific evidence oracles, including 5.8 `DevNotes`. The unchanged 5.8 files live under
`fixtures/unreal-project/FixtureExpected/localization/ue5.8-output`; its PO files also have
byte-exact round-trip tests, and its locmeta and word-count CSV are decoded directly.

CLI: `ue-shed loc targets <project-root>` prints schema-versioned target settings, discovered
configs, output paths, and culture file presence. `@ue-shed/game-text` consumes the browser entry
to join saved corpus identities, compute coverage-qualified states, and expose bounded queries and
`ue-shed loc status` reports. This package remains independent of the corpus. Localization
processes, editing and Workbench views are later slices.

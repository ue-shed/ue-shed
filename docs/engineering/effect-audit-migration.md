# Effect audit and native builder migration

These source changes are prepared for the next 0.17 release. Merging them does not publish packages.

## Contract failures

Existing public decoder names remain, but raw `Schema.decode*` factories now expose unary domain
parsers. Match `ContractParseError` (`code: "invalid_contract"`) at protocol boundaries instead of
matching a top-level `SchemaError`. The original schema error remains in `cause`, including field
issues. Domain-specific Game Text policy/response parsers retain their own domain errors. A valid
failed response is still a response value; it is distinct from an invalid response contract.
The strict review-capture and migrating review-set/run/preview parsers use the same domain error.
Schema-only fallback stays inside the parser; its final failure is translated with
`contractParseError(contract, cause)` after migration attempts finish.
Plugin distribution preserves its protocol independence: its schema-only manifest parser returns
`PluginBundleManifestValidationError` with `code: "schema_invalid"` and the original schema cause.

Do not pass decoder options as a second argument. Configure a schema before creating a parser when
you own that boundary. Ordinary unknown-field compatibility is preserved; this migration does not
make every wire schema strict.

Errors expose `message`, `recovery`, `retrySafe` and `nextStep`; match their stable code, kind, reason
or typed tag. Causes remain structured diagnostic evidence and do not become message text. A retry
requires both a safe replay and a recovery action that calls for retrying. Native failed/terminated
write sessions require reopening and reconciling the last committed state before more work.

Game Text corpus and Enhanced Input scans now distinguish `reader_failed` from `invalid_project`;
Game Text workspace index operations use `index_failed`. Match these codes when handling reader or
index failures, and follow their retained reader guidance instead of always asking for another
project. Portable localization errors retain safe classified causes while excluding private engine
installation candidates, authored evidence and secret configuration.

## Native composition

```ts
import { Layer } from "effect";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { GameTextIndexBuilderLive } from "@ue-shed/game-text/index";

const builder = GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive));
```

The host supplies its ordinary source and localization evidence layers to the index/workspace.
`AssetReaderLive` uses the installed compatible reader; explicit `assetReaderLayer(configuration)`
is supported too. No source-checkout auto-build or executable download is introduced by the library.
Reader capability `game_text_index` requires uasset-io protocol 1.13 or newer.

To select the reference implementation intentionally, provide `typeScriptIndexBuilderLayer` from
the same `/index` entry point. There is no automatic writer fallback after failure. Existing cache
format 4 remains readable; switching builder rebuilds its joined view once and reuses input layers.
No authored assets, localization files, review state or rule documents are migrated by that switch.

## Public names

Replace obsolete connection, reader, Project Index and camera service `*Shape` aliases with their
corresponding `*Api` names. This includes `RemoteControlClientShape`, `AssetReaderShape`,
`AssetReaderTestShape`, `ProjectIndexShape`, `CameraFeedShape`, `ReviewCapturePortShape`,
`ReviewCaptureShape`, `ReviewIdGeneratorShape`, `MapCaptureRepositoryShape`, `MapCaptureShape`,
`MapTileCapturePortShape`, `ReviewAuthoringShape`, `ReviewAuthoringSessionsShape` and
`ReviewRepositoryShape`.

`columnarTextCorpusQuery` and `makeGameTextSearchWorker` are private implementation constructors.
Use `GameTextIndexRefresh` and its retained model/query; select `searchWorker: true` in the public
refresh-layer options. The owning scope controls the worker and pinned reader lifetime.

The asset-reader root no longer exposes `ProtocolOutputBudget`, `ProtocolStreamFailure`,
`ProtocolStreamValidator` or `protocolCacheOutcome`. They belong to the private protocol adapter;
hosts use AssetReader and the scoped native index client instead.

`makeAssetReaderTestLayer` accepts a complete `AssetReaderTestApi` (the full `AssetReaderApi`).
Supply configuration, progress and projection operations explicitly. The layer no longer fills
omitted operations with runtime "not stubbed" failures or assumes a native executable for a test.
Repository fixtures spell out unexpected operations as defects, so an unexpected call fails the
test and adding a new required operation produces a type error. Existing complete derived test
adapters and idle observational defaults in other SDKs remain documented behavior.

Focused Game Text entry points remain `/schema`, `/rules`, `/checks`, `/labels`, `/corpus`, `/index`
and `/workspace`. Deprecated root/browser aggregates remain for the previously promised transition;
no new production composition API is added to those aggregates.

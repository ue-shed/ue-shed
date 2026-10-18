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
or typed tag. TypeScript causes remain structured diagnostic evidence. Native protocol messages
also include underlying IO/parse details for operators; classification uses the stable code, never
that diagnostic prose. A retry
requires both a safe replay and a recovery action that calls for retrying. Native failed/terminated
write sessions require reopening and reconciling the last committed state before more work.

Game Text corpus and Enhanced Input scans now distinguish `reader_failed` from `invalid_project`;
Game Text workspace preserves classified scan errors and uses `index_failed` for other index
preparation failures. Native store/format failures retain their outer recovery and retry safety;
lower-level transport guidance does not replace the writer's classification. Match these codes when handling reader or
index failures, and follow their retained reader guidance instead of always asking for another
project. Portable localization errors retain safe classified causes while excluding private engine
installation candidates, authored evidence and secret configuration.

## Production composition

```ts
import { GameTextIndexBuilderLive } from "@ue-shed/game-text/index";

const builder = GameTextIndexBuilderLive;
```

CLI, Workbench and library hosts use the complete TypeScript build/query implementation through
this layer. The host supplies ordinary source and localization evidence layers; the separate
AssetReader still performs saved-package extraction. No native Game Text writer configuration or
`game_text_index` capability is required by the production builder. `typeScriptIndexBuilderLayer`
names the same implementation.

`nativeIndexBuilderLayer(configuration)` remains an explicit experimental writer for parity and
measurement, requiring reader protocol 1.13. Its query engine still runs in JavaScript; it is not a
complete native backend and is no longer selected by the production layer. There is no automatic
writer fallback after failure. Existing cache format 4 remains readable; restoring the TypeScript
builder rebuilds the joined view once and reuses compatible input layers. No authored assets,
localization files, review state or rule documents are migrated by that switch.

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

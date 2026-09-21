# Unreal source-derived parser model

`uasset-source-gen` derives the model used by UE Shed's default UAsset parser from Unreal C++ source.
It reads reflected declarations and a deliberately small subset of serializer bodies, then emits a
language-neutral JSON model consumed through `uasset-parser`'s `SchemaProvider` boundary.

The native and WASM builds embed the engine-only model. Engine source is a development input for
generation and verification, not a runtime requirement. This is a bounded analyzer, not a general
C++ interpreter; unsupported classes and payloads keep the existing compatibility and evidence paths.

The generated model now proves all nine legacy `DecodedAsset` variants across these target
families:

- `UDataTable` and `UCompositeDataTable`: inheritance, reflected row schemas, UObject properties and
  GUID footer, and the native row array written by `UDataTable::SaveStructData`.
- `UDataAsset`: inheritance-based recognition of native subclasses, reflected properties, and the
  inherited UObject serialization layout.
- `UCurveTable`: inherited UObject serialization plus the mode-dependent native array of named
  `FSimpleCurve` or `FRichCurve` rows.
- `UStringTable`: inherited UObject serialization plus the delegated `FStringTable::Serialize`
  payload: namespace, keyed source strings, and nested metadata maps.
- `UUserDefinedEnum`: inheritance through `UEnum` and `UField`, tagged display names, the native
  `FName`/`int64` entry array, and `CppForm`.
- `UUserDefinedStruct`: inheritance through `UStruct` and `UScriptStruct`, reflected `FProperty`
  fields, script-size markers, non-computed struct flags, and the tagged default instance.
- `USkeleton`: inherited UObject serialization and the `FReferenceSkeleton` bone information,
  double-precision reference transforms, and name-to-index map. Later Skeleton data remains opaque.
- `UAnimSequence`: inherited UObject serialization, `UAnimationAsset::SkeletonGuid`, strip flags,
  the legacy raw-track array boundary, and the uncooked compressed-data gate.
- Generic `UObject`: source-owned classes with the inherited tagged-property/GUID prefix retain all
  later class-specific native data as the same opaque byte span as the compatibility decoder. The
  real conformance inventory includes the `UTexture2D` inheritance chain and all 17 texture fixtures.

The conformance test decodes all 12 DataTable fixtures (10,022 rows total) and the fixture DataAsset
without any raw property values, plus the three-entry StringTable fixture. It also checks every
decoded row/property against the type generated from the fixture's Unreal declarations. This includes
nested structs, enums, containers, object and soft-object references, row handles, `FIntPoint`, and
localized/string-table `FText` values.

Modeled classes now take a strict source-driven path before compatibility dispatch. That path
interprets the generated operation list itself and does not call the handwritten family adapters.
Conformance compares its decoded DT/CDT and StringTable models and public inspection JSON with the
compatibility implementation. StringTable is also compared with the namespace, entries, and metadata
independently emitted by Unreal. The fixture DataAsset comparison records the intentional
classification improvement from generic `UObject` to its source-proven `UDataAsset` subclass while
requiring identical properties, GUID, and object identity. Synthetic differential tests require
exact generated/legacy equality for CurveTable and UserDefinedEnum, including their supported
malformed-input boundaries, and do the same for UserDefinedStruct fields and nesting limits.
Skeleton comparisons cover the real UE 5.7 fixture and its public inspection JSON, exact bone
output, malformed counts, and the intentionally opaque tail.
AnimSequence comparisons cover the real UE 5.7 fixture, the complete supported uncooked trailer,
and exact malformed or unsupported errors for raw tracks, archive booleans, compressed data, and
trailing bytes; its public inspection JSON is also identical.
Generic UObject comparisons cover scalar properties, object GUIDs, arbitrary binary tails, and a
source-recognized subclass whose later native operations must remain compatibility-opaque, plus
exact property/GUID/tail equality across the 17 real `UTexture2D` assets.

The native inspection, project-IO, and WASM paths use the embedded engine-only model. The parser and
inspection libraries also accept an explicit `SchemaProvider`, allowing a generated project model to
classify native subclasses without global state. The legacy class-name fallback remains for projects
that have not supplied source metadata. Thus the generated lane has variant parity with the normal
parser for source-owned classes, while unmodeled project classes continue through the normal generic
fallback instead of being rejected.

Upgrade the native/WASM parser together with its protocol schemas and affected Game Text consumers.
Older strict decoders reject the additional metadata and value/identity variants even though the
inspection schema version is unchanged. The [core swap trial](../../docs/research/uasset-core-swap-2026-09-19.md)
records the required companion files and the passing tests against current main's consumers.

## Generate from UE 5.7

The engine-only model is embedded by the portable parser and deliberately excludes fixture or
project declarations:

```powershell
cargo run -p uasset-source-gen -- generate `
  --config crates/uasset-source-gen/config/ue57-engine-data-assets.json `
  --engine-source "C:\Program Files\Epic Games\UE_5.7\Engine\Source" `
  --workspace . `
  --output crates/uasset-parser/source-models/ue57-data-assets.json
```

The wider conformance model adds the generic fixture module so the strict generated lane can prove
native project subclasses and row structures without placing those declarations in product code:

From the repository root:

```powershell
cargo run -p uasset-source-gen -- generate `
  --config crates/uasset-source-gen/config/ue57-data-assets.json `
  --engine-source "C:\Program Files\Epic Games\UE_5.7\Engine\Source" `
  --workspace . `
  --output fixtures/unreal-project/FixtureExpected/parser-source-model.json
```

Replace `generate` with `check` to fail when the committed model is stale. The engine path is an
explicit development input; it is not embedded in the generated file or used as a runtime default.

## Deliberate boundaries

This is not a general C++ parser and does not pretend to understand arbitrary engine code. Its lexer
and recognizers support the source constructs needed by the target types and preserve unrecognized
field types as explicit `unknown` model entries. Parser dispatch additionally validates the generated
serialization operation sequence before decoding a modeled class.

Tagged property values remain decoded from the type information serialized in the package, using the
same bounded codecs in both lanes. Generated declarations validate those values and supply class
inheritance and native serialization order; they do not override contradictory on-disk evidence.

## Reusable native layouts

Source-model schema 9 provides named native layouts alongside the class operation lists. The shared
`uasset-parser::native` reader composes strings, names, integers, floats, doubles, archive booleans, records, padding, counted
arrays, stride-checked arrays, and native maps. It knows no asset classes. These native maps are count-plus-pairs, distinct from tagged
`MapProperty` replacement/removal framing.

The original cross-module examples use the same interpreter:

- Core's `FStringTable` supplies a string, an array of key/source records, and
  `TMap<FString, TMap<FName, FString>>` metadata. The generator resolves `FMetaDataMap` from the
  configured Unreal header through shared native type lowering.
- CoreUObject's `UEnum` supplies an array of name/integer records followed by `CppForm`.

Family recognizers still establish the supported serializer shape. Small semantic adapters interpret
the resulting values, resolve package names, and validate domain values. They do not repeat the byte
reading loops. Other existing families retain their specialized codecs; extending them is incremental.

The metadata increment adds coverage that the old parser rejected. Public inspection exposes it as
optional `string_table_metadata`, keyed by table entry and metadata name; empty metadata is omitted.
Unknown entry keys and empty strings/maps are retained. The fixture includes multiple keys, multiple
metadata fields, Unicode, and an empty value. A fresh Unreal process reloads the saved package and
emits the committed evidence through `EnumerateMetaData`, independently of the Rust layout.

Tests compare that evidence with both Rust paths and compare native/WASM inspection. Malformed tests
cover truncated maps, invalid counts and name references, allocation limits, and layout depth. A
reordered enum record test establishes that generated layout order drives the reader.

The expanded recipes also cover Engine rich curve keys and reference poses, MovieScene numeric
channels, and CoreUObject InstancedStruct framing and package annotations. These are source-checked
recipes for UE 5.7, not automatic interpretation of arbitrary C++. General source change detection,
preprocessor conditions, and additional engine versions remain future work.

For a focused fixture refresh, build `UEShedFixtureEditor` and run `UnrealEditor-Cmd` with the fixture
project and `-run=UEShedBuildFixture -TextOnly -unattended -nop4 -NullRHI`. Then run a **new process**
with `-TextOnly -VerifyOnly -TextEvidence=<output-directory>`. Its `parser-targets/string-table.json`
is the evidence to compare with `FixtureExpected/parser-targets/string-table.json`. The ordinary
fixture generation and conformance commands also include this metadata.

Only derived declarations, field types, inheritance, and serialization operations are committed.
Unreal source is read locally and is never copied into the product or generated artifact.

## Expanded native coverage

Six fixtures in `Content/Fixture/ParserNative` cover the five additions:

| Capability                                  | Decoded evidence                                                                                                    | Remaining boundary                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| CurveFloat / CurveVector / CurveLinearColor | Rich keys, interpolation, tangents and weights; reflected defaults/extrapolation                                    | No curve evaluation                                                                                                                |
| Skeleton                                    | Raw reference transforms (quaternion, translation, scale) and name-to-index map                                     | Later native Skeleton data remains `tail_bytes`                                                                                    |
| Sequencer float/double channels             | Frames, numeric values, tangents/weights, default, extrapolation, tick resolution, ShowCurve                        | Verified UE 5.7 bulk strides and custom-version framing only; compact sequence projection still reports these tracks as structural |
| InstancedStruct                             | Selected type, bounded byte size, tagged inner properties, supported native inner values, null instances and arrays | Other native inner types remain typed raw evidence; no authoring                                                                   |
| Package metadata                            | Root and per-object name/string annotations, including empty/Unicode values                                         | Current saved metadata section; no legacy UMetaData export decoder                                                                 |

The property codecs use the embedded engine layouts in both generated and fallback class lanes.
They compose `native_struct` fields without inventing Unreal property tags. `instanced_struct` keeps
its selected `struct_type`, `size`, and nullable inner `value`. Skeleton inspection adds
`reference_pose`; package inspection adds optional `metadata: { root, objects }`. The public
inspection version remains 8 with additive capabilities; source-model version 9 is a separate format.
Header-only package reads do not visit annotations. Metadata decode errors make inspection partial.

Generate with `-run=UEShedBuildFixture -NativeParserOnly -unattended -nop4 -NullRHI`; then launch a
new process with `-NativeParserOnly -VerifyOnly -NativeParserEvidence=<output-directory>`.
Compare that directory's `native-coverage.json` with the committed file in
`FixtureExpected/parser-targets`. Set `UE_SHED_NATIVE_EVIDENCE_DIR` to that directory when running
`cargo test -p uasset-inspection --test native_coverage` to compare directly with the fresh oracle.
The ordinary Unreal conformance command runs this comparison too. Portable tests use the committed
assets/evidence, reject malformed counts, strides, booleans, versions and bounded payloads, and
compare all six assets across native and WASM inspection.

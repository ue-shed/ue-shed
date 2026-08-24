# Unreal source-model experiment

`uasset-source-gen` is a bounded experiment in deriving UAsset parser facts from Unreal C++ source.
It reads reflected declarations and a deliberately small subset of serializer bodies, then emits a
language-neutral JSON model consumed through `uasset-parser`'s `SchemaProvider` boundary.

The generated model currently proves eight legacy decoded variants across these target families:

- `UDataTable` and `UCompositeDataTable`: inheritance, reflected row schemas, UObject properties and
  GUID footer, and the native row array written by `UDataTable::SaveStructData`.
- `UDataAsset`: inheritance-based recognition of native subclasses, reflected properties, and the
  inherited UObject serialization layout.
- `UCurveTable`: inherited UObject serialization plus the mode-dependent native array of named
  `FSimpleCurve` or `FRichCurve` rows.
- `UStringTable`: inherited UObject serialization plus the delegated `FStringTable::Serialize`
  payload: namespace, keyed source strings, and the metadata map boundary.
- `UUserDefinedEnum`: inheritance through `UEnum` and `UField`, tagged display names, the native
  `FName`/`int64` entry array, and `CppForm`.
- `UUserDefinedStruct`: inheritance through `UStruct` and `UScriptStruct`, reflected `FProperty`
  fields, script-size markers, non-computed struct flags, and the tagged default instance.
- `USkeleton`: inherited UObject serialization and the `FReferenceSkeleton` bone-info prefix. Bone
  poses and the later native Skeleton payload remain opaque, matching the compatibility decoder.
- `UAnimSequence`: inherited UObject serialization, `UAnimationAsset::SkeletonGuid`, strip flags,
  the legacy raw-track array boundary, and the uncooked compressed-data gate.

The conformance test decodes all 12 DataTable fixtures (10,022 rows total) and the fixture DataAsset
without any raw property values, plus the three-entry StringTable fixture. It also checks every
decoded row/property against the type generated from the fixture's Unreal declarations. This includes
nested structs, enums, containers, object and soft-object references, row handles, `FIntPoint`, and
localized/string-table `FText` values.

Modeled classes now take a strict source-driven path before compatibility dispatch. That path
interprets the generated operation list itself and does not call the handwritten family adapters.
Conformance compares its decoded DT/CDT and StringTable models and public inspection JSON with the
compatibility implementation. StringTable is also compared with the namespace and entries
independently emitted by Unreal. The fixture DataAsset comparison records the intentional
classification improvement from generic `UObject` to its source-proven `UDataAsset` subclass while
requiring identical properties, GUID, and object identity. Synthetic differential tests require
exact generated/legacy equality for CurveTable and UserDefinedEnum, including their supported
malformed-input boundaries, and do the same for UserDefinedStruct fields and nesting limits.
Skeleton comparisons cover exact bone output, malformed counts, and the intentionally opaque tail.
AnimSequence comparisons cover the real UE 5.7 fixture, the complete supported uncooked trailer,
and exact malformed or unsupported errors for raw tracks, archive booleans, compressed data, and
trailing bytes.

The native inspection, project-IO, and WASM paths use the embedded engine-only model. The parser and
inspection libraries also accept an explicit `SchemaProvider`, allowing a generated project model to
classify native subclasses without global state. The legacy class-name fallback remains for projects
that have not supplied source metadata; removing it completely requires a distribution mechanism for
project-native models.

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

StringTable metadata is recognized as part of the native layout but remains deliberately unsupported
by both the generated and compatibility lanes. A non-empty metadata map fails explicitly rather than
being silently skipped.

Only derived declarations, field types, inheritance, and serialization operations are committed.
Unreal source is read locally and is never copied into the product or generated artifact.

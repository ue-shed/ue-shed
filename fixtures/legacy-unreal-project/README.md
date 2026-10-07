# Legacy Unreal text fixtures

This independent C++ project builds on UE 4.27 and UE 5.3. Its runtime module declares a DataTable
row, a nested struct, and a text DataAsset. Its editor module provides two native commandlets:

- `UEShedLegacyFixtureBuild` saves `ST_LegacyText`, `DT_LegacyText`, and `DA_LegacyText` under
  `/Game/Legacy/` and logs each object path and saved filename.
- `UEShedLegacyFixtureEvidence -Evidence=<json file>` loads those packages in a fresh process and
  records Unreal API evidence. Run it only after the build commandlet exits.

The project has no engine path, plugins, engine content, Python dependency, or shared code with
`fixtures/unreal-project`. The generator assigns `EngineAssociation` in each disposable copy.
Both targets use `BuildSettingsVersion.V2`, which exists in both engines.

## Build and generate

From the repository root in PowerShell, discover the installations or set
`UE_SHED_UNREAL_427_ROOT` and `UE_SHED_UNREAL_53_ROOT` explicitly. Optional initial editor builds:

```powershell
$legacyProject = (Resolve-Path fixtures/legacy-unreal-project/UEShedLegacyFixture.uproject).Path
$legacy427 = $env:UE_SHED_UNREAL_427_ROOT
if (!$legacy427) {
  $legacy427 = (Get-ItemProperty 'HKLM:\SOFTWARE\EpicGames\Unreal Engine\4.27').InstalledDirectory
}
$legacy53 = $env:UE_SHED_UNREAL_53_ROOT
if (!$legacy53) {
  $legacy53 = (Get-ItemProperty 'HKLM:\SOFTWARE\EpicGames\Unreal Engine\5.3').InstalledDirectory
}
& "$legacy427/Engine/Build/BatchFiles/Build.bat" UEShedLegacyFixtureEditor Win64 Development "-Project=$legacyProject" -WaitMutex -NoHotReloadFromIDE
if ($LASTEXITCODE -ne 0) { throw 'UE 4.27 editor target failed' }
& "$legacy53/Engine/Build/BatchFiles/Build.bat" UEShedLegacyFixtureEditor Win64 Development "-Project=$legacyProject" -WaitMutex -NoHotReloadFromIDE
if ($LASTEXITCODE -ne 0) { throw 'UE 5.3 editor target failed' }

pnpm fixture:generate-legacy --update
pnpm fixture:generate-legacy
```

The generator builds each editor target again in an isolated copy, saves the assets, and runs the
evidence commandlet in another process. UE 4.27 uses `UE4Editor-Cmd.exe`; UE 5.3 uses
`UnrealEditor-Cmd.exe`. It retains separate build, save, and reload logs and a per-version status in
`out/legacy-unreal-fixtures-*/results.json`. Missing engines are reported separately as skipped,
with the corresponding environment variable. A skipped version is incomplete verification.

`--update` copies only the fixture-authored packages, evidence, and project descriptor into
`Generated/4.27` and `Generated/5.3`. Without it, the generator compares fresh loaded evidence and
package versions with the committed evidence and fails on drift. Package bytes may change between
saves and are not compared. `--results=<file>` also writes the per-version result array for the
engine matrix.

## Evidence and expected gaps

The language-neutral `evidence.schema.json` is authoritative. `evidence.ts` validates it alongside
the typed Effect schema, package uniqueness, and engine/version agreement. `EvidenceContractFixtures`
contains synthetic valid/invalid schema samples, not engine oracles; `evidence.test.ts` checks them.

`evidence.json` version 1 contains the engine version and three packages, sorted by asset name.
Each package records its object/class paths and the saved UE4, UE5, and licensee versions read via
`FPackageFileSummary`. UE 4.27 records UE4 522 and `ue5: null`; UE 5.3 records UE4 522 and UE5 1009.

The summary's name string is a folder name on 4.27 and a package name on 5.3. Evidence preserves it
as `serialized_package_name` separately from Unreal's loaded `object_path`. Byte-only parser paths
use the serialized prefix, normally `None` on 4.27; conformance compares that exact prefix and the
text property/row paths within each asset. Full loaded package paths are retained as independent
API evidence. Resolving a 4.27 export to its full mounted package path requires caller context and
is not added by this fixture change. No artificial folder name is authored to hide the difference.

String Table keys and metadata keys are sorted. DataTable rows have stable name order. JSON object
keys are sorted recursively, and package localization namespaces are fixed to avoid random identity
drift. Text evidence records source, saved history, culture invariance, namespace/key or table ID/key,
row, and property path. `FTextInspector` provides identity and source; serializing the loaded text
through Unreal's `FText` operator provides the saved history discriminator because neither engine
has a public history getter. No private engine headers are included.

Paths follow the text projection: `Nested.Text`, `Texts[0]`, `TextMap{0}.value`, and
`NestedMap{0}.value.Text`. Map indices follow loaded serialization order rather than sorting the
map and changing its indices. Empty text values are included. Empty containers contribute no text
occurrences. The `EmptyContainers` row also records an empty vector array.

String Table reference payloads contain only their table ID and key. Conformance checks require
their inline source to be empty and resolve the engine-evidenced source using the independently
decoded String Table entries. Metadata is compared separately. Both nonempty culture-invariant text
and empty text use None history; the public projection represents both with the existing unresolved
`culture_invariant` identity.

The `Full.NativeVectors` map intentionally has no legacy struct type information. It must remain
`Raw`, with exactly one text coverage gap at `NativeVectors`:
`legacy_container_element_without_type_information`. The empty native map decodes as an empty map.
Nested tagged struct map values must decode, and vector arrays must match Unreal's component values
on both float-width 4.27 and double-width 5.3 packages. No other coverage gap is expected.

## Portable and engine verification

After generating both versions, run:

```powershell
pnpm uasset:check:libraries
pnpm uasset:check:io
pnpm test fixtures/legacy-unreal-project/evidence.test.ts
pnpm test packages/unreal-assets/src/legacy-fixture.integration.test.ts packages/game-text/src/legacy-fixture.integration.test.ts
pnpm test:uasset-engine-matrix
pnpm check
```

The Rust conformance tests compare parser values and text projections with Unreal evidence. Native
reader integration checks inspection and compact IO extraction; Game Text checks the corpus.
The WASM parity list contains all six packages and compares both inspection and text extraction.
These portable tests need committed assets and evidence, but no installed engine. Missing fixtures
fail instead of silently skipping; TypeScript reader suites skip only when the native reader is
disabled, as reported by the test runner.

The engine matrix keeps the required UE 5.7 and UE 5.8 lanes and invokes this generator for optional
UE 4.27 and UE 5.3 evidence comparison lanes. Report all four engine versions separately. UE 5.3
needs an MSVC toolset older than 14.40; see `UE_SHED_UNREAL_53_COMPILER_VERSION` in
[testing](../../docs/engineering/testing.md).

## Source verification

The following references were checked in both UE 4.27 and UE 5.3 full source trees. Paths are
relative to `Engine/Source`:

| API                           | Reference                                                                                                                                                      | Compatibility                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targets and modules           | `Programs/UnrealBuildTool/Configuration/TargetRules.cs`, `ModuleRules.cs`                                                                                      | Both have `BuildSettingsVersion.V2`; no C# version guard is needed.                                                                                                               |
| Commandlets                   | `Runtime/Engine/Classes/Commandlets/Commandlet.h`                                                                                                              | The constructor flags and `Main` signature are shared.                                                                                                                            |
| Create/load objects           | `Runtime/CoreUObject/Public/UObject/UObjectGlobals.h`                                                                                                          | One-argument `CreatePackage`, named `NewObject`, and `LoadObject` are shared.                                                                                                     |
| DataTable rows                | `Runtime/Engine/Classes/Engine/DataTable.h`, `Runtime/Engine/Private/DataTable.cpp`                                                                            | `RowStruct`, `AddRow`, `GetRowNames`, and `FindRow` are shared; rows save through `SerializeItem` with no defaults.                                                               |
| String Table                  | `Runtime/Engine/Public/Internationalization/StringTable.h`, `Runtime/Core/Public/Internationalization/StringTableCore.h`                                       | Setters accept the same literal keys; 5.3's internal `FTextKey` change needs no guard. Enumeration callbacks use strings in both versions.                                        |
| Text identity and history     | `Runtime/Core/Public/Internationalization/Text.h`, `Runtime/Core/Private/Internationalization/Text.cpp`                                                        | `ChangeKey`, `AsCultureInvariant`, `FromStringTable`, and `FTextInspector` are shared. `FText::SerializeText` is private in both, so evidence derives history from the inspector. |
| Stable localization namespace | `Runtime/CoreUObject/Public/Internationalization/TextPackageNamespaceUtil.h`                                                                                   | Both expose `ForcePackageNamespace`.                                                                                                                                              |
| Save package                  | `Runtime/CoreUObject/Public/UObject/Package.h`, `SavePackage.h`                                                                                                | `ENGINE_MAJOR_VERSION >= 5` selects 5.3's `FSavePackageArgs` overload; 4.27 uses positional arguments.                                                                            |
| Saved package summary         | `Runtime/CoreUObject/Public/UObject/PackageFileSummary.h`, `Runtime/Core/Public/UObject/ObjectVersion.h`, `Runtime/CoreUObject/Private/UObject/LinkerSave.cpp` | `ENGINE_MAJOR_VERSION >= 5` selects UE4/UE5 version fields, the renamed licensee getter, and `PackageName`; 4.27 has no UE5 field and stores `FolderName`.                        |
| Editor binary names           | `UE4Editor.Target.cs` (4.27), `UnrealEditor.Target.cs` (5.3)                                                                                                   | The shared tool helper selects the binary prefix from `Build.version`'s major version.                                                                                            |

File/path helpers, JSON values/writers, and container sorting were also checked against the
corresponding Core and Json public headers in both engines. Both lanes have been built and run on
UE 4.27 and UE 5.3.

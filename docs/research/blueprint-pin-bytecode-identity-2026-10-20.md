# Saved Blueprint pins and compiled text identity

The saved pin and compiled literal are two occurrences of one localized text when their package,
clean namespace, key and source agree. Keep the pin's full saved namespace in the corpus and both
locations. Localization still joins on the namespace without its package marker.

## Native evidence

UE 5.7's `KismetCompilerVMBackend.cpp`, localized text literal emission, explicitly calls
`TextNamespaceUtil::StripPackageNamespace` before writing the source, key and namespace to bytecode.
Its comment explains that runtime bytecode removes the package localization ID and editor-only
gathering picks up the property/pin version.

`Serialization/PropertyLocalizationDataGathering.cpp`, `GatherTextInstance`, likewise calls
`StripPackageNamespace` before `AddGatheredText`. Thus the manifest identity has no package stamp;
the full stamp is saved authoring evidence, not an additional translation identity.

The committed `fixtures/unreal-project/FixtureExpected/game-text-actions/evidence.ue5.7.json`
records these two keys in `BP_ActionSign_Duplicate`:

- `AEFB26114D07A708EE991DA4399BEF87`
- `1543B5374F13EA995E694CB599B198EB`

Each has source `The door is locked`, clean namespace `""`, a graph pin site and a compiled
`[Script Bytecode]` site. Their package namespace is `1C66B5FE8224ED34EC87FB91DA650434`.
The saved pins retain `[1C66B5FE8224ED34EC87FB91DA650434]`; bytecode retains `""`.
`Content/Localization/GameTextActions/GameTextActions.manifest` contains the two keys under its
empty namespace and the same source, with compiled bytecode paths. It does not contain separate
package-stamped translation entries.

The retained UE 5.6 acceptance evidence (`ueshed-427-round3-56-acceptance-01`) independently
records repaired pin namespace/key/source triples in `source-reload.json`, and verifies them
against actual GatherText output. `ueshed-427-round3-gather-verification.json` records all nine
action matches in each phase and the regenerated pin's native graph path. The committed four-engine
repair-pin fixtures use those native reload expectations with clean namespaces. Their disconnected
nodes do not emit compiled literals, so compiled-copy regressions use the UE 5.7/5.8
`BP_IdentityLiterals` saves instead.

## Reconciliation boundary

Reconciliation runs after all exports in one package have been projected, in the shared portable
inspection layer used by native streaming extraction, compact package extraction and WASM.
Only resolved default pin identities with a package stamp supply a candidate. Matching requires
exact clean namespace, key and source. Multiple different stamped candidates are ambiguous and
leave the bytecode unchanged. Friendly names, other properties, other packages, String Table
references and unresolved text do not supply a candidate.

Source differences remain separate identities and retain localization source-conflict evidence.
An unread pin cannot supply a match; the original bytecode identity and the partial `Pins` gap
remain. No occurrences are removed. Existing package text caches are invalidated by format v7.

The saved main fixture changes from 153 to 147 units, retaining 224 occurrences (220 resolved,
4 unresolved). The duplicate-sign assertion changes from four units to two, each with its pin and
compiled occurrence and its full saved package namespace. Tests also change the compiled source
without changing the pin or key, and damage the native pin stream while keeping bytecode readable.
No Unreal execution or asset regeneration is required for these checks.

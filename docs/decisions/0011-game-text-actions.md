# 0011: Game Text actions run in Unreal through an editor plugin

## Status

Proposed on 2026-10-17 for Plan 058 item A3 (decision 10 of that plan). The operation set, places,
verification and failure model below specify the intended contract for the `UEShedGameText` editor
plugin and the `@ue-shed/game-text` actions API; this decision record does not ship the implementation.
Engine API declarations were checked against both UE 5.7 and UE 5.8 `Engine/Source` (see
[Engine APIs](#engine-apis)). Implementation acceptance still requires runtime evidence on both
versions.

## Context

Game Text finds identity problems (a key that changed, two texts sharing one id, a branch copy
whose text drifted) but cannot fix them. Plan 052 kept key fixes out of scope, and its owner
decision says any fix that writes to assets is applied in Unreal, through its own APIs or a UE Shed
editor plugin where those fall short (ADR 0009 addendum). The only shipped text writes are
DataTable cells through `UEShedAuthoring`. The Game Text identity fixture
(`UEShedGameTextActionsFixture.cpp`) already shows the editor APIs a details panel or graph pin
uses to assign an id.

## Decision

### Localization authoring extension (2026-10-19)

The public `@ue-shed/localization` package now owns transport and reusable text migration services;
Game Text keeps compatible exports and owns corpus-specific repair UI and saved-reader comparison.
The `game-text.actions.authoring.v1` capability extends the 1.0 envelope with explicit DataTable row,
String Table entry and graph-pin selectors, plus guarded conversion, reference retargeting,
entry copy/removal and whole-table namespace edits. Older plugins are rejected before extended
requests are sent. Plain top-level DataTable fixes may continue through Authoring Apply 1.2.

String Table renaming is a reviewed migration: copy/save the new entry, persist an Unreal old/new
key redirect, retarget/save caller-discovered references, then activate and verify the redirect.
The old entry is retained by default. **Delete old entry** is an optional action selected with
`deleteOldEntry: true` during preparation; it appears in that proposal's preview and execution.
When selected, deletion is saved and absence verified before completion. Migration can complete
without selecting deletion. The redirect remains for dynamic references.
Unreal applies redirects while loading references, so original references are migrated before
live activation. Each phase journals outcomes and cannot automatically replay. Writes across
packages and config are not atomic; failed phases require reconciliation. Discovery cannot prove
the absence of code/dynamic references. Redirects are only appropriate when source text is retained.

The initial base-capability constraints below remain the compatibility contract for requests
without the authoring extension. See the [localization API](../../packages/localization/README.md#asset-text-editing-and-string-table-key-migration)
and [plugin](../../unreal/Plugins/UEShedGameText/README.md) for extended places and host obligations.

Text actions run inside Unreal, in a separately enabled editor plugin, `UEShedGameText`, called over
stock Remote Control like `UEShedAuthoring`, with a commandlet entry for headless batches. UE Shed
never writes text into a package itself.

### Operations

Each action names one place, the text the caller expects there, and one edit:

| Edit             | Effect                                                                                               | Unreal API                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `change_key`     | Give the text the namespace and key the caller names; source stays                                   | `GetTextIdForEdit` (Namespace), then `FText::ChangeKey`      |
| `regenerate_key` | Give the text a new random key; namespace and source stay                                            | The same identity edit with `GenerateRandomTextKey`          |
| `adopt_key`      | Make the text the same text as another id: its namespace, key and source                             | `EditTextProperty_Direct` (SourceString), then identity edit |
| `change_source`  | Retype the source as a user would; Unreal keeps the key only if no other text in the package uses it | `EditTextProperty_Direct` (SourceString)                     |

A request then compiles each Blueprint that owns an edited place, and saves the edited packages
only when asked. Re-reading happens in two places: the plugin reads every edited place back after
compiling, and the host re-reads the saved packages with the saved-package reader.

Namespaces on the wire are the user namespace, without the package namespace Unreal adds to text in
packages (`TextNamespaceUtil::StripPackageNamespace`), which is the namespace Unreal's gather and
the saved-package reader report. The plugin re-applies the package's namespace on write, as the
editor does.

Namespace and key are proposed together to `GetTextIdForEdit`, then applied with `FText::ChangeKey`.
This also handles saved text whose namespace has no package marker: a sequential direct Namespace
edit can return early as unchanged, after which a direct Key edit resets the user namespace while
repairing the package marker. Native automation covers the plain-namespace case in both preview
and apply.

### Places

A place carries the scanned `packageFile`, the reader's `object_path`, and `property_path`, bound to
an explicitly selected project. `packageFile` identifies the actual file under a configured content
mount, not the package name serialized inside it. A copied file can still contain the original
package's object path and identical namespace, key and source; those values alone cannot identify
the mutation target.

Before loading or resolving an object, the host and plugin must agree on the mounted package name
derived from that file's location (`Content/` maps to `/Game/`; plugin content uses its discovered or
explicitly configured mount). The plugin verifies that Unreal resolves that mounted name to the
same canonical file, resolves the object within that package, and checks its owning package before
editing. A serialized absolute object path is evidence to translate within the selected package,
never authority to load a different one. Missing, ambiguous or mismatched mappings reject the
request with `package_mismatch`, without mutation; there is no fallback to the original path.
Existing read-only path completion does not establish this guarantee. Until file-bound resolution
is implemented, actions on file-copied packages remain unavailable.

Original and branched places stay distinct in requests, receipts and saved-package verification
through `packageFile` as well as the resolved object and property. The chain may step into structs
and fixed or dynamic arrays (`Lines[2]`, `Info.Title`); the last property must be an `FTextProperty`.

| Place                  | Object                                        | Compiled by                 |
| ---------------------- | --------------------------------------------- | --------------------------- |
| DataAsset property     | The asset                                     | none                        |
| Blueprint CDO variable | `Default__<Class>_C` in the Blueprint package | the owning Blueprint        |
| SCS component template | The node's template, outer'd to the class     | the owning Blueprint        |
| Widget tree            | A widget under the Widget Blueprint's tree    | the owning Widget Blueprint |
| Graph pin              | Waits for Plan 058 A2                         | the owning Blueprint        |

DataTable cells keep using `UEShedAuthoring` (its Apply 1.2 already writes text identity). A
DataTable or graph-pin place is rejected with `unsupported_place` and a way forward. A
representation copy that a compile regenerates (for example a Widget Blueprint class's own widget
tree) fails verification rather than being silently overwritten, because the plugin reads the
place back after compiling.

### Verification

1. **Preflight.** Verify every file-to-mount binding and owning package before resolving places.
   Every place holds localizable text (not culture invariant, not a String Table reference, not
   generated), and still holds the caller's expected namespace, key and source.
2. **Edit.** Actions apply in request order, so a later action sees an earlier one.
3. **Key check.** `change_key` and `adopt_key` fail with `key_conflict` when Unreal does not keep the
   requested key, which it does when another text in the package already uses that id with
   different source.
4. **Compile.** Each owning Blueprint compiles once with `EBlueprintCompileOptions::SkipSave`,
   including rollback compiles. Editor Save on Compile preferences must not persist changes before
   the explicit save step or when `save: false`; a compile error fails the request.
5. **Read back.** Each place is read again after compiling and must hold the result the action
   reported.
6. **Save** (optional), then the host re-reads the saved packages with the saved-package reader and
   compares each file-bound place against the reported result. This verification also runs for
   successfully saved packages when another package fails to save. Unreal's gather stays the final
   reference: the acceptance tests compare re-read ids with a gather of the fixture.

A dry run performs steps 1 to 3 against the live objects and then restores every edited value and
each package's dirty flag, so it reports the same results and conflicts an apply would, without
compiling or saving. A key that would be minted is reported as `minted` with no value.

### Failure model

Before saving, a request either applies every edit or attempts to restore them all. A request that
fails validation, preflight or the key check changes nothing (edits made before the failing action
are restored, with each package's dirty flag) and reports `status: "rejected"`. When a compile or
read-back fails, the plugin restores every edited value, recompiles the Blueprints it compiled with
saving suppressed, and restores dirty flags. It reports `status: "failed"` with `rolledBack: true`
only after verifying restoration; a failed rollback requires reconciliation and must report the
remaining or unknown changes honestly.

Saving several packages is not atomic. A save failure after successful compile and read-back leaves
the edits applied in memory and reports `failed` with `rolledBack: false`. A receipt records each
action's applied result, including any generated key, separately from each package's persistence
state (`saved`, `unsaved`, or `unknown`) and saved-read verification. It retains file-bound places,
before/after text and diagnostic evidence so a host can reconcile without replaying edits. A failed
or interrupted save is never represented as an unapplied or merely planned action.

For `save_failed`, `retrySafe` is `false` and `nextStep` is `reconcile`. This first contract does not
provide an automatic save-only continuation. The host must inspect the receipt, current live text
and saved bytes for every affected package, resolve checkout or disk failures, then explicitly
persist the reviewed outstanding state through Unreal and re-read those files. It must account for
packages already saved and any intervening unrelated changes before authorizing a package save.
Replaying the original mutation request, or refreshing its expected values and replaying it, is not
persistence recovery: the original preflight is stale and `regenerate_key` could mint another key.
A lost reply or disconnected editor also has an unknown mutation outcome and requires
reconciliation, not automatic replay. Any future save-only continuation needs its own operation and
freshness checks rather than interpreting `retry` as permission to repeat the edits.

Errors have a stable `code`, the action they belong to, `message`, `recovery`, `retrySafe` and a
typed `nextStep` (`fix_input`, `retry`, `reconcile`, `escalate`), the error shape Plan 058 lane D
adopts:

| Code                | Next step   | Meaning                                                                       |
| ------------------- | ----------- | ----------------------------------------------------------------------------- |
| `invalid_request`   | `fix_input` | The request does not match the contract or its bounds                         |
| `package_mismatch`  | `reconcile` | The scanned file cannot be bound to the resolved mounted package; no mutation |
| `place_not_found`   | `reconcile` | The object or property chain no longer exists; rescan                         |
| `not_text`          | `fix_input` | The property chain does not end in a text property                            |
| `read_only_text`    | `fix_input` | Culture-invariant, String Table or generated text has no key to edit          |
| `unsupported_place` | `fix_input` | DataTable cell (use authoring) or graph pin (not yet)                         |
| `stale_expected`    | `reconcile` | The live text differs from what the caller reviewed; rescan                   |
| `key_conflict`      | `fix_input` | Unreal would not keep the requested key in this package                       |
| `compile_failed`    | `escalate`  | An owning Blueprint failed to compile; edits were rolled back                 |
| `not_persisted`     | `escalate`  | A place did not hold its result after compiling; rolled back                  |
| `save_failed`       | `reconcile` | Edits remain applied; inspect per-package persistence before an explicit save |

UE Shed never checks files out (ADR 0009): a dry run lists the packages an apply may write so a
host can check them out first.

### Engine APIs

Declarations checked in both UE 5.7 and UE 5.8 `Engine/Source` on 2026-10-17:

| Source check                                        | UE 5.7 | UE 5.8 |
| --------------------------------------------------- | ------ | ------ |
| Text edit and namespace APIs below                  | Passed | Passed |
| Text inspection and Blueprint ownership/status APIs | Passed | Passed |
| Compile with `SkipSave`; package save arguments     | Passed | Passed |

These are source checks for a documentation-only design change, not plugin build or action runtime
passes. The implementation must separately pass its fixture and recovery tests on both versions.

- `TextNamespaceUtil::EditTextProperty_Direct`, `GetTextIdForEdit`, `ETextEditAction`,
  `GenerateRandomTextKey`, `GetPackageNamespace` (`CoreUObject/Public/Internationalization/TextPackageNamespaceUtil.h`);
- `TextNamespaceUtil::StripPackageNamespace` (`Core/Public/Internationalization/TextNamespaceUtil.h`);
- `FTextInspector::GetTextId`, `GetSourceString`, `FText::IsCultureInvariant`, `IsFromStringTable`
  (`Core/Public/Internationalization/Text.h`);
- `FKismetEditorUtilities::CompileBlueprint` and `EBlueprintCompileOptions::SkipSave`
  (`UnrealEd/Public/Kismet2/KismetEditorUtilities.h`);
- `UBlueprint::GetBlueprintFromClass`, `UBlueprint::Status` (`Engine/Classes/Engine/Blueprint.h`);
- `UPackage::SavePackage` (`CoreUObject/Public/UObject/Package.h`) with `FSavePackageArgs`
  (`CoreUObject/Public/UObject/SavePackage.h`).

### Implementation acceptance

In addition to the supported-place fixture cases, the implementation must prove on both engines:

- Target only the branched Blueprint CDO when the original and copy have identical expected text
  and the copy still reports the original serialized object path. Verify the original's saved bytes
  and live text stay unchanged; verify the selected copy through its own file. Reject an unresolved
  mount or wrong owning package before editing.
- With Save on Compile enabled, applying with `save: false` and any rollback compile writes no
  package files.
- Force a save failure after a key regeneration, including a batch with one saved and one unsaved
  package. Preserve the generated key and applied-result receipt, verify saved results, and report
  reconciliation with `retrySafe: false`. Explicit persistence recovery must retain that key rather
  than replay the edit. Intervening changes or a lost reply must require fresh inspection.

## Consequences

- Hosts get key fixes without UE Shed writing packages, and the editor's own id rules apply.
- The plugin is optional and capability-advertised (`gameTextObjectPath` and the
  `game-text.actions.v1` capability in the core manifest) and allow-listed for Remote Control.
- Graph pins join once A2 makes them Game Text places; their edit uses
  `UEdGraphSchema_K2::TrySetDefaultText`.
- A request edits at most 256 places, so one dry run or apply stays bounded.

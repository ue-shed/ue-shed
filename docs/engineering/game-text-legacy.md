# Game Text on Unreal 4.27

The `game-text` source preset selects `UEShedCore` (Runtime module only) and
`UEShedGameText` (Editor module). It projects the Core descriptor in the archive and excludes
CoreEditor source. Canonical descriptors and the existing UE5 presets retain their module graphs.
The preset declares Unreal 4.27 through 4.27.2; engine verification uses 4.27.2. This does not
extend the full suite's UE5 compatibility window. The shared native sources also retain UE5.7/5.8
regression coverage.

Build public sources with the same release provenance as other presets:

```powershell
pnpm release:plugins:game-text --candidate-manifest <manifest> --commit <sha> --ref <ref>
```

Assets are `ue-shed-plugins-game-text-<version>.tar.gz` and
`ue-shed-plugins-game-text-<version>.manifest.json`. The distribution package exports
`gameTextPluginReleaseAssetNames(version)` and `gameTextVariantPluginReleaseAssetNames(version,
request)`. A compiled UE4 request uses target `UE4Editor`, configuration `Development`, the exact
engine version, architecture, platform and `UE4Editor.modules` BuildId. Compiled names contain
`ue4editor`; module manifests and DLLs use `UE4Editor.modules` and `UE4Editor-<module>.dll`.
AutomationTool is discovered at `Engine/Binaries/DotNET/AutomationTool.exe` on UE4. Existing UE5
target, paths and asset names are unchanged. A source archive is not a precompiled release.

## Host interface

Enable the two plugins and stock Remote Control. Call
`/Script/UEShedCore.Default__UEShedCoreLibrary.GetCapabilityManifest` through stock Remote Control.
Core supplies `projectRoot` (absolute project directory), `projectName`, process/session identity,
engine version and the loaded module list without CoreEditor. The minimal UE4 producer advertises:

- `game-text.actions.v1`: established object-property identity and source operations.
- `game-text.actions.key-repairs.v1`: `change_key`, `regenerate_key`, and `adopt_key` on resolved
  object properties, `data_table_cell` selectors, and `graph_pin` selectors. This is a narrower
  capability than the extended authoring surface.

`gameTextObjectPath` remains `/Script/UEShedGameText.Default__UEShedGameTextLibrary`. Calls use the
existing `ue-shed-game-text-actions` 1.0 request/result, expected namespace/key/source, physical
package file, compile/save flags and per-package persistence receipts. Graph pins accept a pin GUID
or saved pin index. DataTables remain independently addressable assets; inherited Composite
DataTables are rejected by the native selector.

UE4 does **not** advertise `game-text.actions.authoring.v1`. String-table migrations, conversions,
and cell/pin source edits must not be inferred from the key-repair capability. No CoreEditor,
Authoring, navigation/open, cameras or world capabilities are advertised in the minimal graph.
Hosts choose their UI and behavior from those facts; engine version alone is not feature admission.

The commandlet `-run=UEShedGameText -Manifest=<file>` emits the same manifest without mutations.
Normal actions continue to use `-Request=<file> -Result=<file>`.

## Verification

All engine runs require exclusive machine access. A host coordinating multiple agents must acquire
its shared engine lease before invoking builds or editors, and retain no other engine process.
The scripts do not assume a machine-specific lock path.

```powershell
$env:UE_SHED_UNREAL_ENGINE_ROOT = '<engine root>'
pnpm test:unreal-plugins <new-evidence-directory> --game-text
pnpm test:unreal-game-text-actions <new-acceptance-directory>
```

The first command builds only Core runtime + GameText and requires fresh success reports for all
four `UEShed.GameText.*` automation tests. Run it separately on 4.27, 5.7 and 5.8.

On 4.27, the second command copies `fixtures/legacy-unreal-project`, builds its editor target and
generates new 4.27 assets. It performs nine key repairs (split, regenerate and adopt across object
properties, table cells and Blueprint pins). It retains the baseline, dry-run byte checks,
compile/save receipts, fresh-process reload, offline per-place verification and a GatherText
manifest. Legacy Blueprint graph pins currently lack offline reader projection: their native
save/reload/gather checks run, and their three offline checks are explicitly skipped. The six
object/table places require complete offline verification. `results.json` records each coverage
gap and never treats a partial Blueprint read as complete. Add `--source-edits` for a subsequent
native source-edit pass through the same lifecycle. It does not open a studio
project, use Perforce, claim ten-culture translation carry, or test the stock Remote Control
transport. The four automation tests additionally cover live dry-run restoration and refusal/save
recovery paths. Skipped or failed stages remain incomplete acceptance.

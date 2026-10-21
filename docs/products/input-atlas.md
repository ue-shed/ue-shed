# Input Atlas

Input Atlas reads a project's saved Enhanced Input assets and answers the questions a designer, UX
reviewer or programmer asks of a control scheme: which keys each context claims, which claims
collide, which actions nothing uses, and what changes per platform. It is read-only and saved-only:
no editor, no plugin, no play session. The public library (`@ue-shed/enhanced-input`) owns every
answer, the CLI exposes the same workflows, and the Workbench route is a showcase client.

Unreal decides at runtime which mapping contexts are active and at what priority. Saved packages do
not say. Every claim beyond "these contexts name this key" therefore depends on evidence a host
supplies or the project's own files hold. Without it, the product says only what is true.

## Product language

- A **report** is one scan: actions, mapping contexts, player mappable config assets, coverage and
  diagnostics (`EnhancedInputReport`, schema 2).
- **Evidence** is a saved value or the reason it is unavailable (`not_serialized`,
  `wrong_value_kind`, `unresolved_reference`). A value the package did not save is never replaced
  by an engine class default.
- A **claim** is one mapping: a context binding a key to an action, with its triggers and modifiers.
- A key is **contested** when claims from two or more contexts name it. This is the base evidence
  and needs nothing beyond the scan.
- A **co-activation set** is a list of contexts a source says can be active at the same time, each
  with a priority when the source states one.
- A **conflict class** describes a contested pair inside or across co-activation sets.
- An action has **no known use** when nothing the product can see uses it.
- A **platform view** is the atlas as one platform sees it after its context redirects.

## Scan

`EnhancedInputService.scan` selects packages by header class (`/Script/EnhancedInput.` and the
`InputAction`, `InputMappingContext` and `PlayerMappableInputConfig` name suffixes) and decodes only
those. Three projectors, each exported on its own, turn a decoded package into records:

| Projector                            | Record                       | Saved properties projected                                                                                                                                                                                     |
| ------------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputActionFromInspection`          | `InputActionRecord`          | description, value type, `bConsumeInput`, `bTriggerWhenPaused`, `bConsumesActionAndAxisMappings`, `bReserveAllMappings`, `TriggerEventsThatConsumeLegacyKeys`, accumulation, triggers, modifiers, key settings |
| `mappingContextFromInspection`       | `InputMappingContextRecord`  | description, mappings (`DefaultKeyMappings` or legacy `Mappings`), `MappingProfileOverrides`, `InputModeFilterOptions`, `InputModeQueryOverride` tags, `RegistrationTrackingMode`                              |
| `playerMappableConfigFromInspection` | `PlayerMappableConfigRecord` | `ConfigName`, `ConfigDisplayName`, `bIsDeprecated`, `Contexts` (context to priority)                                                                                                                           |

Each mapping keeps its action, key, `SettingBehavior` and its own `PlayerMappableKeySettings`
(name, display name, category, supported key profiles). Each trigger and modifier keeps its class
and its saved **parameters**: scalar values, vectors and object references, with structs and arrays
flattened into names such as `ComboActions[0].ComboStepAction`. A parameter left at its class
default is absent, because Unreal does not save it.

A trigger parameter that references an action is an **action-to-action edge**
(`inputActionEdges`): a chord names the action that must also be active, a combo names its steps.

Schema 2 is additive. New fields are optional in the schema, so schema 1 reports still decode, and
every existing field keeps its meaning. Property names differ between engine releases; every field
is evidence on its own and a missing one is `not_serialized`, not an error. Earlier releases saved
mappable-key options under different names (for example a mapping's `PlayerMappableOptions`
before 5.3); those are not projected.

A package that holds none of the three classes is reported as `unsupported_asset`. A config asset
is supported, so a project with one no longer reads as a permanently partial scan.

## Co-activation sources

Each source is optional and produces `CoActivationSet` values plus a `CoActivationSourceStatus`
(`resolved`, `absent` or `unavailable` with recovery). A host may use any of them, combine them, or
replace them with its own.

| Source                     | Resolver                                                                   | Evidence                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_default_contexts` | `resolveDefaultContextsFromConfig` (Config Explorer); pure parsing helpers | `[/Script/EnhancedInput.EnhancedInputDeveloperSettings] DefaultMappingContexts` for one platform, `Input` family. A context written with `bAddImmediately=False` is left out. |
| `config_asset`             | `coActivationFromConfigAssets` (pure)                                      | Each `PlayerMappableInputConfig` with readable `Contexts` is one set.                                                                                                         |
| `host_document`            | `readCoActivationDocument`; `coActivationFromDocument` (pure)              | A JSON document the host authors, below.                                                                                                                                      |

Contexts are matched by package path, so `/Game/Input/IMC_A.IMC_A`, `/Game/Input/IMC_A` and the
`Class'/Game/Input/IMC_A.IMC_A'` text form name the same context.

Not read: `DefaultWorldSubsystemMappingContexts` (a separate subsystem), the
`bEnableDefaultMappingContexts` console variable, and any context a game adds from code.

### Co-activation document, schema 1

```json
{
	"schemaVersion": 1,
	"kind": "enhanced_input_co_activation",
	"sets": [
		{
			"id": "driving",
			"label": "Driving",
			"platforms": ["Windows"],
			"contexts": [
				{ "context": "/Game/Input/IMC_Gameplay", "priority": 0 },
				{ "context": "/Game/Input/IMC_Vehicle.IMC_Vehicle", "priority": 1 }
			]
		}
	]
}
```

| Field                        | Required | Meaning                                                                     |
| ---------------------------- | -------- | --------------------------------------------------------------------------- |
| `schemaVersion`              | yes      | `1`.                                                                        |
| `kind`                       | yes      | `"enhanced_input_co_activation"`.                                           |
| `sets[].id`                  | yes      | Non-empty identity, reported as `host_document:<id>`.                       |
| `sets[].label`               | no       | Display name; defaults to the id.                                           |
| `sets[].platforms`           | no       | Platforms the set applies to. Absent means every platform.                  |
| `sets[].contexts`            | yes      | At least one context, by object or package path.                            |
| `sets[].contexts[].priority` | no       | Integer. Higher wins, as in Unreal. Absent means the document does not say. |

The Effect Schema is `CoActivationDocument`. Documents are read with a 1 MiB bound; an invalid one
is an input error with recovery guidance, never silently ignored.

## Conflict classes

`classifyInputConflicts(report, sets)` takes every contested key and classifies each pair of
claims from different contexts. It follows UE 5.7's
`IEnhancedInputSubsystemInterface::RebuildControlMappings`: contexts apply from the highest
priority down, and a mapping whose action has `bConsumeInput` keeps its key from every lower
context unless the mapping (or its action) has a chord trigger, which never consumes. Ordinary
trigger differences do not exempt a lower mapping.

When the set states two different priorities, the higher claim comes first and `consumption` says
what the higher action saved (`consumes`, `passes_through` or `not_serialized`):

| Class                | When                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shadowed`           | Different priorities, the higher mapping is not chorded, and its action saves `bConsumeInput=true`. The lower mapping never receives the key.                               |
| `may_shadow`         | Different priorities, the higher mapping is not chorded, and its action does not save `bConsumeInput` (or is outside the scan). It hides the lower only if it consumes.     |
| `both_fire`          | Different priorities, the higher action saves `bConsumeInput=false`, and the triggers match. Both actions fire.                                                             |
| `qualified`          | A chorded higher mapping; or a higher action that passes input through, or equal or unstated priorities, with a chord, combo or different trigger list. Likely intentional. |
| `ambiguous_priority` | Equal priorities, or the set does not state both, and the triggers match.                                                                                                   |
| `cross_context`      | No set holds both contexts. Informational: the contexts are never active together according to the sources supplied.                                                        |

With no co-activation set at all, the analysis reports `classified: false` and only the contested
flag. That is the honest answer when nothing says which contexts are active together.

## Usage

`inputActionUsage(report, { blueprintUses, blueprintCoverage })` joins each action with the
contexts that map it, the config assets holding those contexts, trigger edges that name it, and
Blueprint uses. An action with none of them has **no known use**: C++ `BindAction` and bindings a
game builds at runtime are invisible to saved packages. The usage report also lists mappings with
no action or no saved key, and mapping targets that are not among the scanned actions (for example
plugin content outside the scanned roots).

`scanBlueprintInputActionUses` finds Blueprint uses. Package dependencies are not yet exposed in
header evidence, so it uses the documented fallback with a cheaper first step:

1. One header scan lists packages with a `...Blueprint` export (the set the Blueprint search catalog
   lists) and probes each name map for the scanned actions' package names.
2. Only Blueprints whose name map holds one of those names are decoded, in path order, up to an
   explicit `maximumBlueprints` bound. Matches past the bound are counted as `skipped`; failures are
   listed. Coverage is returned beside the uses so "no known use" is read against it.
3. `blueprintReferences` walks each decoded Blueprint. A reference from a
   `K2Node_EnhancedInputAction` node is an `event_node` use, from `K2Node_GetInputActionValue` a
   `value_node` use, and any other saved reference a `reference` use.

## Platform views

Three sources, each separately usable:

- **Platform data redirects.** `UEnhancedInputPlatformSettings` is a per-object config class; its
  object for a platform reads `[EnhancedInputPlatformSettings_<Platform>
EnhancedInputPlatformSettings] InputData` from that platform's `Input` hierarchy.
  `resolvePlatformViews` reads it through Config Explorer, finds each listed Blueprint class's package
  in one header scan, and reads `MappingContextRedirects` from its class default object
  (`platformDataRedirectsFromInspection`). Each class costs one package decode. A native platform
  data class saves nothing here and is reported as a diagnostic. `discoverInputPlatforms` lists the
  platforms that have a project platform `Input` config file.
- **Key profiles.** `inputKeyProfiles` and `reportForKeyProfile` apply a context's
  `MappingProfileOverrides` the way `UInputMappingContext::GetMappingsForProfile` does.
- **Device coverage.** `inputDeviceCoverage(report, deviceSets)` lists, per action, the keys each
  device set offers. Device sets are host input: `defaultInputDeviceSets` (keyboard with mouse, and
  gamepad) is a starting point a host can replace with an `InputDeviceSetsDocument`
  (`{ "schemaVersion": 1, "kind": "enhanced_input_device_sets", "sets": [{ "id", "label",
"devices": ["keyboard" | "mouse" | "gamepad"] }] }`).

`platformContextPaths` and `redirectCoActivationSets` apply a platform's redirects to the atlas and
to co-activation sets.

## Library surface

Every piece is a separately exported function or layer; hosts compose or replace them.

- Pure, browser-safe (`@ue-shed/enhanced-input/browser`): schemas, `buildInputAtlas`,
  `inputActionEdges`, co-activation resolvers, `classifyInputConflicts`, usage and candidate
  selection, platform and device helpers.
- Node (`@ue-shed/enhanced-input`): the projectors, `EnhancedInputService`, the effectful sources
  above (each with its requirement, `ConfigExplorer` or `AssetReader`, in its type), the optional
  `EnhancedInputAnalysis` service with `EnhancedInputAnalysisLive`, and the control sheet export.

`EnhancedInputRunResult` may carry an optional `analysis` (`EnhancedInputHostAnalysis`): the
co-activation sets with each source's status, and platform views. A host that resolves nothing
omits it.

## CLI

```text
ue-shed input inspect <asset-or-project>
ue-shed input atlas <project>
ue-shed input conflicts <project> [--platform <Platform>] [--co-activation <file>] [--engine-root <path>]
ue-shed input unused <project> [--no-blueprints] [--maximum-blueprints <n>]
ue-shed input platforms <project> [--platform <Platform>]... [--device-sets <file>] [--engine-root <path>]
ue-shed input export <project> [--format markdown|csv|json] [--output <file>] [co-activation flags]
```

`--platform` on `conflicts` and `export` turns on the project default contexts source for that
platform and keeps only sets that apply to it. `--co-activation` adds a host document. Each output
is a versioned JSON document with the source statuses beside the result. `export` writes the
control sheet, one row per mapping with triggers and parameters, through the saved-investigation
file writer; CSV has the metadata row the other investigation exports use. Without `--platform`,
`platforms` uses the platforms that have a project platform `Input` config.

## Workbench route

The route follows [project ownership](../showcase.md#project-ownership): it reads the shell's
selected project, never offers its own project picker, and Rescan refreshes that project only.
Workbench resolves, beside the scan, the config asset sets, the project default contexts for the
platform it runs on (its own policy), and the platform views for platforms with a project platform
`Input` config.

- The **conflict class filter** narrows which contested keys stand out. Without a co-activation
  source it offers only "All contested" and says so.
- **View within this project** selects all contexts, one platform's redirected view or one key
  profile. It is a selection inside the selected project, not a project picker.
- The key detail lists every claim with trigger and modifier parameters, and every classified pair
  with its reason and set.

## Verification

- Unit tests cover the projectors on synthetic inspections, every resolver, the classifier, usage,
  platform helpers and the control sheet; the route has component tests.
- `apps/cli/src/input.integration.test.ts` runs every command against the repository fixture with
  the native reader.
- `pnpm test:unreal-enhanced-input` saves actions, contexts, a config asset and a platform data
  Blueprint with non-default parameters through each installed engine's Python commandlet in a
  disposable project, then checks the CLI's output against them. It reports a missing engine as
  skipped. The committed fixture has no config asset or chord; these are covered by the probe.

Per [AGENTS.md](../../AGENTS.md), both UE 5.7 and UE 5.8 must pass before a change to this
projection ships. The first slice was checked on UE 5.7 only; UE 5.8 was not installed.

# Config Explorer

Config Explorer explains why a saved Unreal configuration key has a value for an explicit project
and target platform. It is a read-only, headless-first settings-archaeology product: the public
library resolves source-controlled `.ini` evidence, the CLI exposes the same workflow, and a
host-neutral extension presents supplied results without filesystem authority.

The first slice answers a deliberately bounded question:

> Within the supported saved-source configuration hierarchy, which ordered lines affected this
> section/key, what state did each line see and produce, and which effects survive in the result?

It does **not** claim that the answer is the value currently observed by a running Unreal process.

## Product language

- A **config family** is Unreal's base ini name, such as `Engine`, `Game`, or `Input`.
- A **saved-source layer** is an engine- or project-owned config file in the uncooked static
  hierarchy that is safe to inspect without entering user-private storage.
- A **contribution** is one parsed operation for the selected section/key, with a privacy-safe source
  path, source location when the parser can establish it, prior state, resulting effect, and final
  effectiveness.
- **Effective saved value** means the final scalar/array/explicit-empty/missing state after folding
  every supported contribution in the declared saved-source coverage. It does not mean live runtime
  authority.
- **Coverage** lists every considered layer as read, missing, unreadable, excluded, or unsupported.
  Missing optional files are evidence, not silent absence.

## First-slice journey

The required headless journey is:

```text
explicit project + section + key + platform
  -> discover or explicitly select the matching engine
  -> identify one config family (or report ambiguity)
  -> construct the UE 5.7 saved-source hierarchy
  -> parse and fold ordered contributions
  -> return effective saved value + contribution timeline + coverage
```

The CLI entry point is:

```text
ue-shed config explain <project> <section> <key> --platform <platform>
```

`<project>` accepts an explicit `.uproject` or project root containing exactly one `.uproject`.
The ordinary command succeeds without a config-family option when evidence identifies exactly one
family. If the same section/key occurs in more than one family, the result reports the candidates
and recovery guidance rather than guessing. An optional explicit family selector may be added for
that recovery path without changing the required command.

The comparison workflow resolves the same section/key independently for two explicit platforms and
returns both explanations plus a value/coverage comparison. It never derives one platform's answer
by patching the other.

## Saved-source coverage

The hierarchy is derived from the selected engine and project, never from a baked-in installation
path. For a chosen config family, the first slice models UE 5.7's uncooked static engine/project
layers and expansions in engine order:

- `Engine/Config/Base.ini` and `Base{Type}.ini`;
- engine/project restricted expansions when those project/engine paths exist;
- platform-parent layers before the selected platform;
- platform-extension locations beneath engine or project `Platforms/<Platform>/Config`;
- project `Default{Type}.ini` and source-tree `Generated{Type}.ini` layers;
- engine and project platform-specific `{Platform}{Type}.ini` and source-tree generated platform
  layers.

Platform inheritance comes from the engine/project `DataDrivenPlatformInfo.ini` evidence. Parent
chains are applied parent-most first and the requested platform last. An unknown platform or an
invalid/cyclic parent chain is an explicit discovery/coverage failure.

Project custom-config layers are not selected implicitly because Unreal normally selects them from
runtime/build invocation state. They remain excluded until a future explicit, schema-owned input
and conformance case earns them.

The following authorities are intentionally outside the effective saved-source result and are named
in its coverage:

| Authority                                                            | First-slice treatment                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Project `Saved/Config` generated destination files                   | Excluded as local/generated state that can contain user-machine settings             |
| Application/user settings directories and `Project/Config/User*.ini` | Excluded; never read silently                                                        |
| Live CVars and console state                                         | Excluded; requires a running-process authority and can diverge from config           |
| Device Profiles                                                      | Excluded; their inheritance, selectors, and CVar application are a separate resolver |
| Command-line config/CVar overrides                                   | Excluded; invocation-specific live/build authority                                   |
| Cooked, staged, binary, and generated runtime config                 | Excluded; this slice models uncooked source evidence only                            |
| Plugins, Game Feature plugins, hotfixes, and other dynamic layers    | Unsupported; requires enabled-plugin and dynamic-layer provenance                    |
| Code defaults, environment mutation, and runtime writes              | Excluded; not saved-source evidence                                                  |

Consequently, Config Explorer says “effective saved-source value,” not “the runtime value.” A result
with excluded or unsupported authorities remains useful, but its coverage prevents callers from
promoting it into a stronger claim.

## Merge semantics

The first slice follows the behavior verified in UE 5.7 `FConfigFile::ProcessCommand` and the config
parser:

| Syntax       | Operation        | Supported behavior                                                   |
| ------------ | ---------------- | -------------------------------------------------------------------- |
| `Key=Value`  | set              | Add when absent; otherwise replace the first existing entry in place |
| `+Key=Value` | add unique       | Add only when the saved value is not already present                 |
| `.Key=Value` | append           | Append even when the same saved value already exists                 |
| `-Key=Value` | remove           | Remove one stable matching entry when present                        |
| `!Key=...`   | clear            | Remove all entries and remove explicit-empty initialization          |
| `^Key=...`   | initialize empty | Remove all entries and preserve an explicitly empty array state      |

Key and section matching follows Unreal's case-insensitive config identity. Values remain saved
strings; Config Explorer does not perform runtime macro expansion or property-type coercion.

UnrealBuildTool's `ConfigHierarchySection` is useful corroboration for layer enumeration, but it is
not the merge oracle for this product: its build-tool projection intentionally collapses some
runtime distinctions (including plain-set and removal behavior). The table above follows the
Runtime/Core config cache that loads a running Unreal process.

`@` keyed-array metadata, `*` per-object keyed-array metadata, config remaps, and parser forms that
the slice cannot reproduce truthfully are reported as unsupported syntax/semantics. They are never
treated as ordinary keys or ignored while returning complete coverage. Quoted values and ordinary
comments are supported; unsupported multiline or malformed input produces a source-located coverage
diagnostic where safely available.

Every contribution reports:

- source scope and project/engine-relative path, never an absolute user path;
- one-based line and column when established by the text parser;
- operation and saved value;
- prior value state and the concrete effect (added, replaced, removed, cleared, initialized empty,
  duplicate/no match);
- whether that effect remains represented in the final state.

No-op contributions remain visible and are marked ineffective. Superseded contributions remain in
the ordered history. Removal/clear effectiveness is based on whether the removed lineage is still
absent at the end, not merely whether the line executed.

## Public contract and architecture

`@ue-shed/config-explorer` owns browser-safe Effect Schemas, pure hierarchy/parse/fold/compare
transformations, and an Effect-native `ConfigExplorer` service. Node filesystem and engine-location
authority are supplied by narrow adapter services/layers. Browser imports expose result/input
schemas and pure projections only; they must not import Node, Workbench, or process APIs.

The service operations are conceptually:

- `explain(request)` -> one schema-validated explanation;
- `compare(request)` -> two independently resolved explanations plus their differences.

External input is decoded at the service/CLI boundary. Expected failures are tagged, schema-owned
values with safe identifiers, retry guidance, and partial-work context. Filesystem interruption
remains cancellable through Effect; adapters do not hide Promise/runtime exits.

`extensions/config-explorer` receives supplied browser-safe results through a small Effect client or
component input. It can display ready, partial, ambiguous, missing, and failed evidence without raw
filesystem, process, Unreal, Electron, or Workbench IPC authority. Workbench composition is deferred
until its current IPC/preload changes are deliberately rebased and reviewed.

This first standalone extension is not yet advertised as a copy-and-own adoption bundle, so it does
not claim the adoption-manifest/materializer conformance described by the engineering guide.

## Result and recovery states

The public model distinguishes:

- resolved scalar, resolved array, explicitly empty array, and missing key;
- ambiguous config family with candidate families;
- missing optional hierarchy layer;
- unreadable existing file;
- unsupported syntax or semantic mechanism;
- incomplete/ambiguous engine discovery;
- invalid project or platform inheritance;
- cancelled resolution.

Missing layers are normal coverage entries. Unreadable files and unsupported semantics make the
answer partial and prevent a complete-coverage claim. Incomplete engine discovery prevents
resolution because engine defaults and platform metadata cannot be reconstructed truthfully.

## Privacy and safety

- The product never writes `.ini` files.
- Public results contain normalized engine/project-relative source references, not absolute engine,
  repository, home, application-data, or temporary paths.
- Errors may describe a failed logical layer but must not leak private path prefixes.
- No user-private config location is probed as part of hierarchy discovery.
- Telemetry uses bounded operation, platform, config-family, outcome, and coverage dimensions; it
  never labels spans/metrics with project paths, section names, keys, or values.

## Fixture and acceptance

A generic text fixture supplies a minimal synthetic engine/project hierarchy and platform metadata.
It includes deliberate scalar replacement, unique addition, duplicate append, removal, clear,
explicit-empty initialization, missing layers, an unsupported construct, and platform-specific
divergence. It contains no studio names, paths, assets, credentials, or private schema.

The first slice is accepted when:

1. the required CLI command explains the fixture key with ordered, source-located contributions;
2. scalar, array, clear, explicit-empty, duplicate/no-op, and supersession semantics match the UE
   5.7 source behavior;
3. comparison shows a real same-key difference across two fixture platforms;
4. missing, unreadable, unsupported, ambiguous-family, and incomplete-engine states are distinct;
5. public results round-trip through browser-safe schemas and contain no absolute paths;
6. cancellation and typed recovery are tested at the filesystem/service boundary;
7. the standalone extension renders supplied complete/partial/comparison evidence with no
   filesystem authority;
8. focused checks and the full `pnpm check` gate pass, with practical Unreal-backed comparison
   evidence recorded where the local UE 5.7 installation can verify it.

## Out of scope

- Editing, generating, or writing config files.
- Live CVar or console inspection.
- Device Profile resolution.
- User-machine/private settings.
- Command-line overrides or custom-config selection.
- Cooked, staged, binary, or runtime-generated config.
- Plugin/dynamic/hotfix config layers in this slice.
- Historical/source-control drift.
- Project-specific policy, recommendations, or “correct” values.
- A general Unreal runtime settings system or complete parity claim for unsupported mechanisms.

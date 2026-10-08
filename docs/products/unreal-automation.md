# Unreal authoring and runtime automation

UE Shed exposes separately enabled native capabilities to trusted external hosts through Unreal
Remote Control. The public clients live in `@ue-shed/unreal-connection`; schemas and language-neutral
contracts live in `@ue-shed/protocol`. Workbench is not required. See the
[adoption guide](../../packages/unreal-connection/ADOPTING.md) for integration and verification.

## Capability and scope

| Capability                                                                  | Native provider    | Scope                                                                                         |
| --------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `authoring.snapshot.v2`, `authoring.table-list.v1`, `authoring.defaults.v1` | `UEShedAuthoring`  | Editor DataTable snapshots, discovery, and initialized struct defaults                        |
| `authoring.apply.v1`, `authoring.apply-result.v1`, `authoring.save.v1`      | `UEShedAuthoring`  | Editor mutation, result lookup, and explicit Save                                             |
| `authoring.actor-references.v1`                                             | `UEShedAuthoring`  | Actors and components currently loaded in an explicitly selected editor world                 |
| `automation.players.v1`                                                     | `UEShedAutomation` | Local controllers in an explicitly selected game or PIE world                                 |
| `automation.input.v1`                                                       | `UEShedAutomation` | One-shot Enhanced Input injection for an explicitly selected local controller and InputAction |
| `automation.csv.v1`                                                         | `UEShedAutomation` | Process-wide CSV profiler state and owned captures                                            |

`UEShedCore` advertises the loaded providers and their public endpoints. `UEShedAutomation` is an
optional runtime plugin, disabled by default; enabling Authoring does not enable Automation.
An editor advertises `unreal_editor`; a runtime producer advertises `unreal_runtime`. Capability
advertisements, rather than plugin presence or producer kind alone, determine supported operations.
Remote Control must be enabled and reachable in the selected producer. Packaging policy and Remote
Control availability in a runtime build remain the consuming project's responsibility.

The `authoring-automation` source bundle contains `UEShedCore`, `UEShedAuthoring`, and
`UEShedAutomation`. Enhanced Input is an engine dependency. Authoring remains an editor module;
runtime consumers select Core and Automation without requiring editor functionality.

## Authoring defaults and actor references

Live schema snapshots include known default values obtained from Unreal's initialized row struct.
The defaults use the same typed value representation as table rows, including nested structs and
containers. A codec that cannot represent a property reports an unavailable or unsupported value;
consumers must not substitute guessed zero values. Saved-package inspection can still report
unknown defaults, since a saved asset does not necessarily serialize its struct's initialized value.
Text values carry their localization identity (snapshot 2.3, Apply 1.2), so text defaults are
known unless they hold generated text. Hosts edit text content with `editAuthoringText`, which keeps
a localized namespace and key; omitting the key asks the producer to mint one in the table package.
Producer refusals such as `invalid_request` or `operation_not_found` arrive as an
`UnrealConnectionError` with a `code`.

The `editor-host` source bundle adds `UEShedAuthoring` to the camera-authoring plugin graph for hosts
that offer both camera and DataTable authoring in one editor.

`findUnrealActorsReferencingRow({ endpoint, request })` negotiates actor-reference support
independently of Apply. The request selects a world, table object path, row name, and explicit
`maxActors` and `maxResults` bounds. The scan inspects reflected actor and component properties,
recursing through structs, arrays, sets, and map keys and values for `FDataTableRowHandle` matches.
Its evidence describes the loaded-world scope and any truncation. It does not load World Partition
actors or claim to inventory every saved actor in a project.

## Input and profiling

`connectUnrealAutomation(endpoint)` negotiates the public runtime connection. `listPlayers(request)`
discovers local controllers in the requested world. The host chooses a returned controller identity
and an explicit Enhanced Input action, then calls `injectInput(request)` with a typed action value.
There is no implicit first-player selection, game-specific camera action, sustained input loop, or
scenario replay. Input is injected once; the host owns any scheduling and records the action intent.

`csvProfiler(request)` supports status, owned start, and owned stop. The plugin checks its generated
capture filename before stopping; it cannot stop a capture started outside UE Shed. Control is
process-wide and does not distinguish host identities, so connected hosts must coordinate capture
ownership through their own shared policy. Responses distinguish `idle`, `starting`,
`capturing`, `stopping`, and `unavailable`, with output evidence when available. Starting and stopping
are asynchronous engine transitions; inspect status until the transition resolves. Do not treat a
successful stop submission as evidence that the CSV file has finished writing.

## Host contract and recovery

The host owns project and endpoint selection, user-facing review, transport composition, and durable
records of mutation intent and evidence. Browser code receives a host-owned validated API; raw
Remote Control authority stays in the trusted host.

Authoring consumers translate reviewed edits into one UE Shed Apply request with table fingerprints
and a stable operation identifier. The native producer owns rollback and the editor transaction.
Save is explicit. Refresh from returned snapshots and results rather than assuming that a submitted
request changed every requested value. See [Data Authoring](data-authoring.md).

Missing capabilities remain typed unavailable results or capability failures. Lost replies after
Apply, Save, input, or profiler mutation are indeterminate; never replay them automatically. Apply
supports operation lookup. For input and profiling, inspect current producer state and ownership,
then let the host decide the next action. Fixture-specific arithmetic and serialization probes
belong to the consuming fixture, rather than production authoring or automation methods.

## Acceptance evidence

Portable checks validate the wire schemas, client capability negotiation, mutation retry behavior,
and exact source-bundle closure and release provenance. Real Unreal automation covers:

- `UEShed.Authoring.Defaults`: initialized native defaults represented in live snapshots.
- `UEShed.Authoring.ActorReferences`: actor/component matches, nested containers, world selection,
  and scan bounds.
- `UEShed.Automation.Input`: explicit controller/action selection, typed values, and invalid targets.
- `UEShed.Automation.Profiling`: plugin-owned captures, external-capture refusal, state transitions,
  and output evidence.

Run the plugin gate separately on UE 5.7 and UE 5.8 with fresh evidence directories. A build or test
pass on one engine does not complete the matrix. The adopting host must also prove its own real
transport journey against a generic fixture; native tests alone do not establish a host migration.

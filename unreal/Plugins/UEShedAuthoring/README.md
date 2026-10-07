# UEShedAuthoring

The separately enabled editor capability for live DataTable snapshots, bounded transactional Apply,
operation-result lookup, and explicit Save. Its reflected functions carry the shared versioned JSON
contract over stock Remote Control. Apply preflights semantic fingerprints, supports the five
canonical command shapes across several tables, restores every table if any command fails, and keeps
a bounded operation-result cache so clients never need to replay uncertain mutation.

Snapshots include known field defaults from an independently initialized row struct, including
native constructors and authored Blueprint struct defaults. Values use the same typed codec as
rows and Apply. Properties the codec cannot fully represent retain `unknown` defaults.
This includes text and enclosing structs/containers containing text: the display-only text codec
cannot preserve localization identity, string-table linkage, or text history when reused by Apply.

`FindActorsReferencingRow(RequestJson, ResultJson)` implements
`unreal-authoring-actor-references` version 1.0. The request selects an already-loaded editor or PIE
`worldObjectPath`, an already-loaded `tableObjectPath`, and an existing `rowName`, plus explicit
`maxActors` (1–100000) and `maxResults` (1–10000). It examines loaded actors and their components,
including nested structs, static arrays, arrays, sets, and map keys and values. It does not load
worlds or assets, switch editor worlds, or traverse unrelated UObject references.

Results contain actor object paths, the scanned actor count, and `isComplete`. Depth (64), property
visits (1000000), request characters (16384), and output path characters (4194304) are additionally
bounded. A reached scan bound returns `status: "ok"`, `isComplete: false`, and a `scan_limit`
diagnostic. Invalid targets or requests return `status: "rejected"` with typed errors. Results
describe currently loaded actors only; unloaded World Partition actors are outside this query.

Requests are also capped at 16384 UTF-8 bytes, so multibyte characters cannot bypass the transport
payload bound.

Native automation tests `UEShed.Authoring.Defaults` and `UEShed.Authoring.ActorReferences` create
transient tables, Blueprint structs, worlds, actors, and components, and verify that read operations
preserve row values and dirty state. `UEShed.Authoring.DefaultsCodec` creates a row through the
actual command decoder using the snapshot defaults. The plugin gate passes shared wire fixtures via
`-UEShedAuthoringContractFixtures=<directory>`.

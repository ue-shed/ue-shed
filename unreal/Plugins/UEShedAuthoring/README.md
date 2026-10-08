# UEShedAuthoring

The separately enabled editor capability for live DataTable snapshots, bounded transactional Apply,
operation-result lookup, and explicit Save. Its reflected functions carry the shared versioned JSON
contract over stock Remote Control. Apply preflights semantic fingerprints, supports the five
canonical command shapes across several tables, restores every table if any command fails, and keeps
a bounded operation-result cache so clients never need to replay uncertain mutation.

Snapshots include known field defaults from an independently initialized row struct, including
native constructors and authored Blueprint struct defaults. Values use the same typed codec as
rows and Apply. Properties the codec cannot fully represent retain `unknown` defaults.

Text values carry an `identity` alongside the display string: `localized` (namespace, key, and
source string), `string_table` (table id and key), `culture_invariant`, `none`, or `generated`.
Apply 1.2 writes text from its identity. A localized write keeps the given namespace and key, or
mints a new key in the table package when the key is omitted; a string-table write must name an
existing entry; generated text (formatted, numeric, and other derived histories) is read-only, and
defaults containing it stay `unknown`. Apply 1.1 requests compare and write display strings only,
and rewriting an unchanged display string leaves the existing text identity in place.

The table fingerprint leaves text identity out, so Apply 1.1 clients still match it. Apply 1.2
checks identity per command instead:

- `set_cell` compares its `oldValue`, identity included;
- `remove_row` compares the reviewed `row` with the live row, identity included. Text nested in
  structs, arrays, sets and maps is compared too, and each identity stays tied to its map key or
  set element. If a key or string-table reference changed since review, the removal is a
  conflict, even when the display text is the same.

Both comparisons read `float` values as Unreal stores them, rounded to 32 bits. A draft can
therefore name a float it wrote earlier in the same Apply.

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
actual command decoder using the snapshot defaults, and `UEShed.Authoring.TextIdentity` covers
localized, minted, string-table, culture-invariant, generated, and Apply 1.1 text writes. The plugin gate passes shared wire fixtures via
`-UEShedAuthoringContractFixtures=<directory>`.

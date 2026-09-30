# `@ue-shed/blueprints`

Headless graph navigation, search, reference layout and display metadata for saved Blueprint
schema-2 projections. The package has no DOM, Solid, StyleX, Electron, filesystem or Unreal dependency.
The maintained viewer stays in UE Shed Workbench; any host can consume these ordinary pure functions.

Read asset bytes with `@ue-shed/uasset-inspection-wasm` in Node or a browser, or use
`readSavedBlueprint` from `@ue-shed/unreal-assets` with an explicitly selected native reader.
Validate external JSON with the re-exported `decodeBlueprintGraphProjection` or
`BlueprintGraphProjection` schema before passing it to the helpers. Parsing remains owned by those
existing libraries. This package neither reads files nor creates a runtime.

```ts
import {
	indexBlueprintGraph,
	blueprintNeighbors,
	layoutBlueprintGraph,
	blueprintLinkPath,
	searchBlueprint
} from "@ue-shed/blueprints";

// projection is a validated BlueprintGraphProjection from a native or WASM read.
const graph = projection.graphs[0];
if (graph !== undefined) {
	const index = indexBlueprintGraph(graph);
	const first = graph.nodes[0];
	const outgoing =
		first === undefined
			? []
			: blueprintNeighbors({
					index,
					nodeObjectPath: first.object_path,
					direction: "outgoing"
				});
	const layout = layoutBlueprintGraph(graph);
	const paths = graph.links.map((link) => blueprintLinkPath(layout, link));
}
const matches = searchBlueprint({ blueprint: projection, query: "damage float" });
```

`indexBlueprintGraph` resolves pins by both owner path and pin ID. Repeated node paths or repeated
pin IDs within one owner are reported in `issues` and omitted from lookup maps; a consumer never gets
an arbitrarily chosen duplicate. `blueprintNeighbors` follows decoded saved links in their order,
deduplicates neighbors and skips unresolved endpoints. It does not evaluate execution flow.

`layoutBlueprintGraph` returns maps of node placements and pin anchors using the exported reference
card geometry `BLUEPRINT_LAYOUT`. It normalizes negative coordinates while preserving the original
saved positions in each node. Colors, UI state, rendering and alternate layouts belong to the host.
`blueprintLinkPath` returns a portable SVG cubic path, or undefined for unavailable endpoints.

`searchBlueprint` performs literal, case-insensitive search across graph names, node identity/title,
comments and pin names/types/tooltips/defaults. Every whitespace-separated term must match. Results
retain graph/node/pin addresses in saved order, stop at 500 hits and report truncation. Empty queries
return no hits. A host owns selection, result rendering and reference navigation.

`blueprintNodeDisplay` extracts explicitly saved comments, dimensions, comment-bubble flags and enabled
state. Absent, undecoded or ambiguous properties remain null; false and empty values survive.
`blueprintPinFlags` names the eight persistent archive bits verified against UE 5.7 and UE 5.8's
EdGraphPin serializer, retaining unknown bits separately. These are saved flags, including the orphan
marker, rather than a claim about the editor's effective pin visibility or orphan-pin setting.
Pin label/type/default/tone helpers supply semantic display values; they impose no colors or styling.

For saved references and structural comparisons use the existing `@ue-shed/unreal-assets/saved-review`
functions. Graph families, engine revisions, opaque bytes and partial coverage retain the source
reader's limits. Compilation, editing, playback and exact C++-generated editor titles/icons are
outside this package.

Verify locally with `pnpm --filter @ue-shed/blueprints typecheck`,
`pnpm test packages/blueprints/src/blueprints.test.ts`, and `pnpm test:saved-review` for native/WASM
fixture conformance. Packed-package conformance checks the published entry point and real Blueprint
bytes from a clean consumer. No UI entry point or separate viewer package is published.

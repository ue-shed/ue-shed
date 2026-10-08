import "@dschz/solid-flow/base.css";
import {
	Background,
	Handle,
	MiniMap,
	Panel,
	SolidFlow,
	createEdgeStore,
	createNodeStore,
	useSolidFlow,
	type NodeProps,
	type NodeTypes,
	type SolidFlowEdge,
	type SolidFlowNode
} from "@dschz/solid-flow";
import * as stylex from "@stylexjs/stylex";
import {
	BLUEPRINT_LAYOUT,
	blueprintPinTone,
	findBlueprintPin,
	indexBlueprintGraph,
	layoutBlueprintGraph
} from "@ue-shed/blueprints";
import type { BlueprintGraph, BlueprintNode } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Show, createEffect, createUniqueId, untrack } from "solid-js";
import { GraphCardContent, blueprintCommentFrame, pinToneColor } from "./blueprint-graph-node.js";
import { styles as graphStyles } from "./blueprint-graph-styles.js";

type BlueprintFlowData = { node: BlueprintNode; labelId: string };

/**
 * Names a node "Inspect <title>" for assistive technology. Solid Flow does not render a node's
 * aria-label, so the node element points at this hidden label through aria-labelledby.
 */
function NodeLabel(props: { readonly data: BlueprintFlowData }) {
	return (
		<span hidden id={props.data.labelId}>
			{"Inspect " + props.data.node.title}
		</span>
	);
}

function BlueprintFlowNode(props: NodeProps<BlueprintFlowData, "blueprint">) {
	return (
		<div {...stylex.attrs(graphStyles.node, props.selected && graphStyles.nodeSelected)}>
			<NodeLabel data={props.data} />
			<GraphCardContent
				node={props.data.node}
				pinHandle={(pin) => (
					<Handle
						id={pin.id}
						position={pin.direction === "input" ? "left" : "right"}
						type={pin.direction === "input" ? "target" : "source"}
						isConnectable={false}
						class={stylex.attrs(styles.handle).class ?? ""}
					/>
				)}
			/>
		</div>
	);
}

function BlueprintFlowComment(props: NodeProps<BlueprintFlowData, "comment">) {
	return (
		<div {...stylex.attrs(graphStyles.comment, props.selected && graphStyles.commentSelected)}>
			<NodeLabel data={props.data} />
			<span
				title={blueprintCommentFrame(props.data.node)?.text}
				{...stylex.attrs(graphStyles.commentHeader)}
			>
				{blueprintCommentFrame(props.data.node)?.text}
			</span>
		</div>
	);
}

const nodeTypes = {
	blueprint: BlueprintFlowNode,
	comment: BlueprintFlowComment
} satisfies NodeTypes;

/** Graph zoom stays within the range the native canvas offered. */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;

function FlowZoom() {
	const { flow, commands } = useSolidFlow();
	return (
		<>
			<Panel position="bottom-left">
				<span aria-hidden="true" {...stylex.attrs(graphStyles.panHint)}>
					Drag or scroll to pan · Ctrl + wheel to zoom
				</span>
			</Panel>
			<Panel position="bottom-right">
				<div aria-label="Zoom" role="group" {...stylex.attrs(graphStyles.zoomCluster)}>
					<button
						aria-label="Zoom out"
						onClick={() => void commands.zoomOut()}
						type="button"
						{...stylex.attrs(graphStyles.zoomButton)}
					>
						−
					</button>
					<output aria-label="Graph zoom" {...stylex.attrs(graphStyles.zoomOutput)}>
						{Math.round(flow.viewport.zoom * 100)}%
					</output>
					<button
						aria-label="Zoom in"
						onClick={() => void commands.zoomIn()}
						type="button"
						{...stylex.attrs(graphStyles.zoomButton)}
					>
						+
					</button>
					<span {...stylex.attrs(graphStyles.zoomDivider)} />
					<button
						onClick={() => void commands.fitView({ maxZoom: 1 })}
						title="Fit the graph to the viewport"
						type="button"
						{...stylex.attrs(graphStyles.zoomButton, graphStyles.zoomText)}
					>
						Fit
					</button>
					<button
						onClick={() => void commands.setZoom(1)}
						title="Reset to actual size"
						type="button"
						{...stylex.attrs(graphStyles.zoomButton, graphStyles.zoomText)}
					>
						1:1
					</button>
				</div>
			</Panel>
		</>
	);
}

export function BlueprintGraphFlowCanvas(props: {
	readonly graph: BlueprintGraph;
	readonly onSelect: (path: string | undefined) => void;
	readonly selectedNodePath: string | undefined;
}) {
	// The viewer mounts a fresh canvas for each graph. Saved positions are fixed: the canvas is
	// read-only, so dragging anywhere, nodes included, pans the view.
	const layout = layoutBlueprintGraph(props.graph);
	const index = indexBlueprintGraph(props.graph);
	const labelPrefix = createUniqueId();
	// The initial selection seeds the store; the effect below follows later changes.
	const initiallySelected = untrack(() => props.selectedNodePath);
	const initialNodes: SolidFlowNode<typeof nodeTypes>[] = [...layout.nodes.values()].map(
		({ node, x, y, height }, nodeIndex) => {
			const frame = blueprintCommentFrame(node);
			const labelId = `${labelPrefix}-node-${nodeIndex}`;
			return {
				id: node.object_path,
				type: frame === undefined ? "blueprint" : "comment",
				data: { node, labelId },
				position: { x, y },
				width: frame?.width ?? BLUEPRINT_LAYOUT.nodeWidth,
				height: frame?.height ?? height,
				selected: initiallySelected === node.object_path,
				deletable: false,
				zIndex: frame === undefined ? 2 : 0,
				// Focusable nodes select on Enter, so they read as the inspector action they are.
				ariaRole: "button",
				domAttributes: { "aria-labelledby": labelId }
			};
		}
	);
	const initialEdges: SolidFlowEdge[] = props.graph.links.flatMap((link, linkIndex) => {
		const source = link.from.node_object_path;
		const target = link.to.node_object_path;
		const sourcePin = findBlueprintPin(index, link.from);
		const targetPin = findBlueprintPin(index, link.to);
		if (
			source === undefined ||
			target === undefined ||
			sourcePin?.direction !== "output" ||
			targetPin?.direction !== "input"
		)
			return [];
		return [
			{
				id: `link-${linkIndex}`,
				type: "default",
				source,
				target,
				sourceHandle: link.from.pin_id,
				targetHandle: link.to.pin_id,
				selectable: false,
				deletable: false,
				reconnectable: false,
				zIndex: 1,
				style: { stroke: pinToneColor(blueprintPinTone(sourcePin)) }
			}
		];
	});
	const [nodes, setNodes] = createNodeStore<typeof nodeTypes>(initialNodes);
	const [edges, setEdges] = createEdgeStore(initialEdges);

	// Search and footer reveals use the same selection as clicks and keyboard selection here.
	createEffect(
		() => props.selectedNodePath,
		(selected) => {
			setNodes((draft) => {
				for (const node of draft) node.selected = node.id === selected;
			});
			setEdges((draft) => {
				for (const edge of draft) {
					const touches = selected === edge.source || selected === edge.target;
					edge.style = {
						...edge.style,
						opacity: selected === undefined ? 0.8 : touches ? 1 : 0.18,
						"stroke-width": touches ? 3 : 2
					};
				}
			});
		}
	);

	return (
		<div aria-label="Graph viewport" {...stylex.attrs(styles.viewport)}>
			<SolidFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				fitView
				fitViewOptions={{ maxZoom: 1 }}
				minZoom={MIN_ZOOM}
				maxZoom={MAX_ZOOM}
				panOnScroll
				zoomActivationKey="Control"
				forceColorMode="dark"
				deleteKey={null}
				selectionKey={null}
				multiSelectionKey={null}
				selectionOnDrag={false}
				nodesConnectable={false}
				nodesDraggable={false}
				edgesFocusable={false}
				zIndexMode="manual"
				elevateNodesOnSelect={false}
				elevateEdgesOnSelect={false}
				onNodeClick={({ node }) => props.onSelect(node.id)}
				onSelectionChange={({ nodes: selected }) =>
					// Solid Flow calls this from its own effect; it reacts to nothing here.
					untrack(() => {
						const node = selected[0];
						if (node !== undefined && node.id !== props.selectedNodePath) {
							props.onSelect(node.id);
						}
					})
				}
				onPaneClick={() => props.onSelect(undefined)}
			>
				<Background variant="dots" gap={16} size={1} />
				<FlowZoom />
				<MiniMap
					position="top-right"
					width={160}
					height={100}
					pannable
					zoomable
					class={stylex.attrs(styles.minimap).class ?? ""}
				/>
			</SolidFlow>
			<Show when={props.graph.nodes.length === 0}>
				<div {...stylex.attrs(graphStyles.emptyGraphCanvas, styles.emptyGraph)}>
					<strong>No nodes saved in this graph</strong>
					<span>The graph export exists, but its saved Nodes array is empty.</span>
				</div>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	viewport: {
		position: "absolute",
		inset: 0,
		fontFamily: tokens.fontBody,
		backgroundColor: tokens.colorCanvas,
		"--xy-background-color": tokens.colorCanvas,
		"--xy-background-pattern-color": tokens.colorBorder,
		"--xy-node-color": tokens.colorText,
		"--xy-selection-background-color": tokens.colorAccentWash,
		"--xy-selection-border": "1px solid " + tokens.colorAccent,
		"--xy-minimap-background-color": tokens.colorSurface,
		"--xy-minimap-mask-background-color": tokens.colorCanvasTranslucent,
		"--xy-minimap-mask-stroke-color": tokens.colorBorderStrong,
		"--xy-minimap-node-background-color": tokens.colorTextMuted,
		"--xy-minimap-node-stroke-color": tokens.colorBorderStrong,
		"--xy-attribution-background-color": tokens.colorSurface,
		"--xy-handle-background-color": "transparent"
	},
	// Invisible edge anchors. base.css centres each handle on its pin row's edge; these
	// properties are ones base.css leaves alone, so stylesheet order never matters.
	handle: { opacity: 0, width: 12, height: 14, borderWidth: 0 },
	minimap: {
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		overflow: "hidden"
	},
	emptyGraph: { pointerEvents: "none" }
});

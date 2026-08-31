import * as stylex from "@stylexjs/stylex";
import type {
	BlueprintGraph,
	BlueprintGraphProjection,
	BlueprintNode,
	BlueprintPin
} from "@ue-shed/protocol";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { BlueprintGraphReadResult } from "../main/preload.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

const NODE_WIDTH = 268;
const NODE_HEADER_HEIGHT = 43;
const PIN_ROW_HEIGHT = 25;
const GRAPH_MARGIN = 72;
const POSITION_SCALE = 0.82;

interface LaidOutNode {
	readonly height: number;
	readonly node: BlueprintNode;
	readonly x: number;
	readonly y: number;
}

interface GraphLayout {
	readonly height: number;
	readonly nodes: ReadonlyMap<string, LaidOutNode>;
	readonly width: number;
}

export interface BlueprintGraphViewerProps {
	readonly client: Pick<WorkbenchRendererClient, "chooseBlueprint" | "readBlueprint">;
}

function nodeHeight(node: BlueprintNode): number {
	return NODE_HEADER_HEIGHT + Math.max(node.pins.length, 1) * PIN_ROW_HEIGHT + 8;
}

function layoutGraph(graph: BlueprintGraph | undefined): GraphLayout {
	if (graph === undefined || graph.nodes.length === 0) {
		return { height: 480, nodes: new Map(), width: 760 };
	}
	const minimumX = Math.min(...graph.nodes.map((node) => node.position.x));
	const minimumY = Math.min(...graph.nodes.map((node) => node.position.y));
	const nodes = new Map<string, LaidOutNode>();
	let width = 0;
	let height = 0;
	for (const node of graph.nodes) {
		const x = GRAPH_MARGIN + (node.position.x - minimumX) * POSITION_SCALE;
		const y = GRAPH_MARGIN + (node.position.y - minimumY) * POSITION_SCALE;
		const laidOut = { height: nodeHeight(node), node, x, y };
		nodes.set(node.object_path, laidOut);
		width = Math.max(width, x + NODE_WIDTH + GRAPH_MARGIN);
		height = Math.max(height, y + laidOut.height + GRAPH_MARGIN);
	}
	return { height: Math.max(height, 480), nodes, width: Math.max(width, 760) };
}

function pinPoint(
	layout: GraphLayout,
	reference: { readonly node_object_path?: string; readonly pin_id: string }
): { readonly x: number; readonly y: number } | undefined {
	if (reference.node_object_path === undefined) return undefined;
	const node = layout.nodes.get(reference.node_object_path);
	if (node === undefined) return undefined;
	const index = node.node.pins.findIndex((pin) => pin.id === reference.pin_id);
	if (index < 0) return undefined;
	const pin = node.node.pins[index];
	if (pin === undefined) return undefined;
	return {
		x: pin.direction === "output" ? node.x + NODE_WIDTH : node.x,
		y: node.y + NODE_HEADER_HEIGHT + (index + 0.5) * PIN_ROW_HEIGHT
	};
}

function linkPath(layout: GraphLayout, link: BlueprintGraph["links"][number]): string | undefined {
	const from = pinPoint(layout, link.from);
	const to = pinPoint(layout, link.to);
	if (from === undefined || to === undefined) return undefined;
	const handle = Math.max(64, Math.abs(to.x - from.x) * 0.46);
	return `M ${from.x} ${from.y} C ${from.x + handle} ${from.y}, ${to.x - handle} ${to.y}, ${to.x} ${to.y}`;
}

function shortClass(classPath: string): string {
	return (
		classPath
			.split(".")
			.at(-1)
			?.replace(/^K2Node_/, "") ?? classPath
	);
}

function pinLabel(pin: BlueprintPin): string {
	return pin.friendly_name?.source || pin.name || "unnamed";
}

function resultBlueprint(
	result: BlueprintGraphReadResult | undefined
): BlueprintGraphProjection | undefined {
	return result?.status === "ready" ? result.blueprint : undefined;
}

export function BlueprintGraphViewer(props: BlueprintGraphViewerProps) {
	const action = createEffectAction();
	const [assetPath, setAssetPath] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [result, setResult] = createSignal<BlueprintGraphReadResult>();
	const [graphIndex, setGraphIndex] = createSignal(0);
	const [selectedNodePath, setSelectedNodePath] = createSignal<string>();
	const [zoom, setZoom] = createSignal(1);
	const blueprint = createMemo(() => resultBlueprint(result()));
	const failure = createMemo(() => {
		const value = result();
		return value?.status === "failed" ? value : undefined;
	});
	const graph = createMemo(() => blueprint()?.graphs[graphIndex()]);
	const layout = createMemo(() => layoutGraph(graph()));
	const selectedNode = createMemo(() => {
		const path = selectedNodePath();
		return path === undefined
			? undefined
			: graph()?.nodes.find((node) => node.object_path === path);
	});
	const pinCount = createMemo(
		() =>
			blueprint()
				?.graphs.flatMap((item) => item.nodes)
				.flatMap((node) => node.pins).length ?? 0
	);
	const linkCount = createMemo(
		() => blueprint()?.graphs.reduce((count, item) => count + item.links.length, 0) ?? 0
	);

	const accept = (next: BlueprintGraphReadResult) => {
		setLoading(false);
		if (next.status === "cancelled") return;
		setResult(next);
		if (next.status === "ready") {
			setAssetPath(next.assetPath);
			setGraphIndex(0);
			setSelectedNodePath(next.blueprint.graphs[0]?.nodes[0]?.object_path);
			setZoom(1);
		}
	};

	const run = (effect: ReturnType<BlueprintGraphViewerProps["client"]["readBlueprint"]>) => {
		setLoading(true);
		setTransportFailure(false);
		action.run(effect, {
			onFailure: () => {
				setLoading(false);
				setTransportFailure(true);
			},
			onSuccess: accept
		});
	};

	const readPath = (event: SubmitEvent) => {
		event.preventDefault();
		const path = assetPath().trim();
		if (path !== "") run(props.client.readBlueprint(path));
	};

	const choose = () => run(props.client.chooseBlueprint());
	const chooseGraph = (index: number) => {
		setGraphIndex(index);
		setSelectedNodePath(blueprint()?.graphs[index]?.nodes[0]?.object_path);
	};

	return (
		<main {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>
						Saved asset laboratory / Blueprint cartography
					</p>
					<h1 {...stylex.props(styles.title)}>Blueprint Graphs</h1>
					<p {...stylex.props(styles.intro)}>
						Open an uncooked UE 5.7 .uasset and inspect the graph exactly as it was
						saved—no editor process, asset load, or compile step.
					</p>
				</div>
				<span {...stylex.props(styles.readOnlyStamp)}>READ ONLY · SCHEMA 1</span>
			</header>

			<form onSubmit={readPath} {...stylex.props(styles.pathBar)}>
				<label {...stylex.props(styles.pathField)}>
					<span>Blueprint package</span>
					<input
						aria-label="Blueprint package path"
						onInput={(event) => setAssetPath(event.currentTarget.value)}
						placeholder="C:\\Project\\Content\\Blueprints\\BP_Example.uasset"
						spellcheck={false}
						value={assetPath()}
						{...stylex.props(styles.pathInput)}
					/>
				</label>
				<button disabled={loading()} type="submit" {...stylex.props(styles.openButton)}>
					{loading() ? "Decoding…" : "Open graph"}
				</button>
				<button
					disabled={loading()}
					onClick={choose}
					type="button"
					{...stylex.props(styles.browseButton)}
				>
					Browse…
				</button>
			</form>

			<Show when={transportFailure()}>
				<div role="alert" {...stylex.props(styles.failure)}>
					Workbench could not reach the saved-asset reader. Verify the configured uasset
					executable, then retry.
				</div>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<div role="alert" {...stylex.props(styles.failure)}>
						<strong>{value().message}</strong>
						<span>{value().recovery}</span>
					</div>
				)}
			</Show>

			<Show
				when={blueprint()}
				fallback={
					<section {...stylex.props(styles.emptyState)}>
						<div {...stylex.props(styles.emptyGlyph)}>
							<span {...stylex.props(styles.emptyDot)} />
							<span {...stylex.props(styles.emptyDot, styles.emptyDotAccent)} />
							<span {...stylex.props(styles.emptyDot)} />
						</div>
						<h2>Graph evidence starts here</h2>
						<p>
							Paste a package path or choose a .uasset. The reader keeps unknown
							native tails visible instead of inventing meaning for them.
						</p>
					</section>
				}
			>
				{(projection) => (
					<>
						<section aria-label="Blueprint summary" {...stylex.props(styles.summary)}>
							<div {...stylex.props(styles.identity)}>
								<span>OBJECT</span>
								<strong title={projection().object_path}>
									{projection().object_path.split(".").at(-1)}
								</strong>
							</div>
							<Metric label="graphs" value={projection().graphs.length} />
							<Metric
								label="nodes"
								value={projection().graphs.reduce(
									(count, item) => count + item.nodes.length,
									0
								)}
							/>
							<Metric label="pins" value={pinCount()} />
							<Metric label="links" value={linkCount()} />
							<div {...stylex.props(styles.coverage)}>
								<span
									{...stylex.props(
										projection().coverage_gaps.length === 0
											? styles.coverageDotReady
											: styles.coverageDotGap
									)}
								/>
								{projection().coverage_gaps.length === 0
									? "Topology complete"
									: `${projection().coverage_gaps.length} coverage gaps`}
							</div>
						</section>

						<div {...stylex.props(styles.graphTabs)}>
							<For each={projection().graphs}>
								{(item, index) => (
									<button
										aria-pressed={graphIndex() === index()}
										onClick={() => chooseGraph(index())}
										type="button"
										{...stylex.props(
											styles.graphTab,
											graphIndex() === index() && styles.graphTabActive
										)}
									>
										{item.name}
										<small>{item.nodes.length}</small>
									</button>
								)}
							</For>
							<div {...stylex.props(styles.zoomControls)}>
								<button
									aria-label="Zoom out"
									onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
									type="button"
									{...stylex.props(styles.zoomButton)}
								>
									−
								</button>
								<output {...stylex.props(styles.zoomOutput)}>
									{Math.round(zoom() * 100)}%
								</output>
								<button
									aria-label="Zoom in"
									onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
									type="button"
									{...stylex.props(styles.zoomButton)}
								>
									+
								</button>
								<button
									onClick={() => setZoom(1)}
									type="button"
									{...stylex.props(styles.zoomButton, styles.zoomReset)}
								>
									1:1
								</button>
							</div>
						</div>

						<section
							aria-label="Saved Blueprint graph"
							{...stylex.props(styles.workspace)}
						>
							<div {...stylex.props(styles.viewport)}>
								<div
									style={`width:${layout().width * zoom()}px;height:${layout().height * zoom()}px`}
								>
									<div
										style={`width:${layout().width}px;height:${layout().height}px;transform:scale(${zoom()})`}
										{...stylex.props(styles.canvas)}
									>
										<svg
											aria-hidden="true"
											height={layout().height}
											width={layout().width}
											{...stylex.props(styles.wires)}
										>
											<For each={graph()?.links}>
												{(link) => {
													const path = () => linkPath(layout(), link);
													return (
														<Show when={path()}>
															{(value) => <path d={value()} />}
														</Show>
													);
												}}
											</For>
										</svg>
										<For each={graph()?.nodes}>
											{(node) => {
												const placed = () =>
													layout().nodes.get(node.object_path);
												return (
													<button
														aria-label={`Inspect ${node.title}`}
														onClick={() =>
															setSelectedNodePath(node.object_path)
														}
														style={`left:${placed()?.x ?? 0}px;top:${placed()?.y ?? 0}px;width:${NODE_WIDTH}px;height:${placed()?.height ?? nodeHeight(node)}px`}
														type="button"
														{...stylex.props(
															styles.node,
															node.kind === "event" &&
																styles.nodeEvent,
															node.kind === "function_call" &&
																styles.nodeFunction,
															(node.kind === "variable_get" ||
																node.kind === "variable_set") &&
																styles.nodeVariable,
															selectedNodePath() ===
																node.object_path &&
																styles.nodeSelected
														)}
													>
														<span {...stylex.props(styles.nodeHeader)}>
															<span>{node.title}</span>
															<small>
																{shortClass(node.class_path)}
															</small>
														</span>
														<span {...stylex.props(styles.pinList)}>
															<For each={node.pins}>
																{(pin) => (
																	<span
																		{...stylex.props(
																			styles.pinRow
																		)}
																	>
																		<span
																			{...stylex.props(
																				styles.pinSide,
																				styles.pinInput
																			)}
																		>
																			<Show
																				when={
																					pin.direction ===
																					"input"
																				}
																			>
																				<i
																					{...stylex.props(
																						styles.pinDot
																					)}
																				/>
																				<span>
																					{pinLabel(pin)}
																				</span>
																			</Show>
																		</span>
																		<span
																			{...stylex.props(
																				styles.pinSide,
																				styles.pinOutput
																			)}
																		>
																			<Show
																				when={
																					pin.direction ===
																					"output"
																				}
																			>
																				<span>
																					{pinLabel(pin)}
																				</span>
																				<i
																					{...stylex.props(
																						styles.pinDot
																					)}
																				/>
																			</Show>
																		</span>
																	</span>
																)}
															</For>
														</span>
													</button>
												);
											}}
										</For>
									</div>
								</div>
							</div>
							<aside {...stylex.props(styles.inspector)}>
								<Show
									when={selectedNode()}
									fallback={<p>Select a node to inspect its saved evidence.</p>}
								>
									{(node) => <NodeInspector node={node()} />}
								</Show>
							</aside>
						</section>
					</>
				)}
			</Show>
		</main>
	);
}

function Metric(props: { readonly label: string; readonly value: number }) {
	return (
		<div {...stylex.props(styles.metric)}>
			<strong>{props.value.toLocaleString()}</strong>
			<span>{props.label}</span>
		</div>
	);
}

function NodeInspector(props: { readonly node: BlueprintNode }) {
	return (
		<div {...stylex.props(styles.inspectorContent)}>
			<p {...stylex.props(styles.inspectorLabel)}>SELECTED NODE</p>
			<h2>{props.node.title}</h2>
			<span {...stylex.props(styles.kindBadge)}>{props.node.kind.replaceAll("_", " ")}</span>
			<dl {...stylex.props(styles.evidenceList)}>
				<div {...stylex.props(styles.evidenceRow)}>
					<dt>Class</dt>
					<dd>{props.node.class_path}</dd>
				</div>
				<div {...stylex.props(styles.evidenceRow)}>
					<dt>Position</dt>
					<dd>
						{props.node.position.x}, {props.node.position.y}
					</dd>
				</div>
				<div {...stylex.props(styles.evidenceRow)}>
					<dt>GUID</dt>
					<dd>{props.node.guid ?? "not serialized"}</dd>
				</div>
				<div {...stylex.props(styles.evidenceRow)}>
					<dt>Pins</dt>
					<dd>{props.node.pins.length}</dd>
				</div>
				<div {...stylex.props(styles.evidenceRow)}>
					<dt>Native tail</dt>
					<dd>{props.node.subclass_tail_bytes} bytes</dd>
				</div>
			</dl>
			<div {...stylex.props(styles.propertyHeading)}>
				<span>Tagged properties</span>
				<small>{props.node.properties.length}</small>
			</div>
			<div {...stylex.props(styles.properties)}>
				<For each={props.node.properties}>
					{(property) => (
						<div {...stylex.props(styles.property)}>
							<span>{property.name}</span>
							<small>{property.type}</small>
							<code {...stylex.props(styles.propertyValue)}>
								{JSON.stringify(property)}
							</code>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

const styles = stylex.create({
	route: {
		minHeight: "100%",
		padding: "28px 30px 38px",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		gap: 32,
		alignItems: "flex-start",
		marginBottom: 20
	},
	eyebrow: {
		margin: "0 0 7px",
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 10,
		letterSpacing: "0.13em",
		textTransform: "uppercase"
	},
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 31,
		fontWeight: 650,
		letterSpacing: "-0.035em"
	},
	intro: {
		maxWidth: 700,
		margin: "8px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.55
	},
	readOnlyStamp: {
		flexShrink: 0,
		marginTop: 5,
		padding: "6px 9px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusBadge,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		letterSpacing: "0.1em"
	},
	pathBar: {
		display: "grid",
		gridTemplateColumns: "minmax(280px, 1fr) auto auto",
		gap: 8,
		alignItems: "end",
		padding: 12,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowCard
	},
	pathField: {
		display: "grid",
		gap: 5,
		color: tokens.colorTextMuted,
		fontSize: 10,
		fontWeight: 650,
		letterSpacing: "0.06em",
		textTransform: "uppercase"
	},
	pathInput: {
		height: 38,
		padding: "0 11px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorderStrong, ":focus": tokens.colorTextMuted },
		borderRadius: tokens.radiusControl,
		outline: "none",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textTransform: "none"
	},
	openButton: {
		height: 38,
		padding: "0 16px",
		borderWidth: 0,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":disabled": tokens.colorAccent
		},
		color: tokens.colorAccentText,
		cursor: { default: "pointer", ":disabled": "wait" },
		fontWeight: 700,
		transitionProperty: "transform, background-color",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { ":active": "scale(0.97)" },
		opacity: { ":disabled": 0.55 }
	},
	browseButton: {
		height: 38,
		padding: "0 14px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorderStrong, ":hover": "#50545a" },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorText,
		cursor: "pointer",
		transitionProperty: "transform, border-color",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { ":active": "scale(0.97)" }
	},
	failure: {
		display: "grid",
		gap: 4,
		marginTop: 12,
		padding: "11px 13px",
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorDanger,
		backgroundColor: "rgba(235,87,87,.08)",
		color: tokens.colorText,
		fontSize: 12
	},
	emptyState: {
		minHeight: 480,
		display: "grid",
		placeContent: "center",
		justifyItems: "center",
		marginTop: 16,
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceInset,
		textAlign: "center"
	},
	emptyGlyph: { display: "flex", gap: 28, alignItems: "center", marginBottom: 20 },
	emptyDot: {
		width: 14,
		height: 14,
		borderWidth: 2,
		borderStyle: "solid",
		borderColor: "#5bc0eb",
		borderRadius: "50%",
		backgroundColor: "#101820",
		boxShadow: "0 0 0 5px rgba(91,192,235,.06)"
	},
	emptyDotAccent: {
		borderColor: tokens.colorAccent,
		boxShadow: "0 0 0 5px rgba(228,242,34,.06)"
	},
	summary: {
		display: "flex",
		alignItems: "stretch",
		minHeight: 60,
		marginTop: 16,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	identity: {
		minWidth: 280,
		display: "grid",
		alignContent: "center",
		gap: 3,
		padding: "10px 16px",
		borderRightWidth: 1,
		borderRightStyle: "solid",
		borderRightColor: tokens.colorBorder
	},
	metric: {
		minWidth: 78,
		display: "grid",
		placeContent: "center",
		justifyItems: "center",
		padding: "8px 14px",
		borderRightWidth: 1,
		borderRightStyle: "solid",
		borderRightColor: tokens.colorBorder
	},
	coverage: {
		marginLeft: "auto",
		display: "flex",
		alignItems: "center",
		gap: 8,
		padding: "0 16px",
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	coverageDotReady: {
		width: 7,
		height: 7,
		borderRadius: "50%",
		backgroundColor: tokens.colorSuccess,
		boxShadow: "0 0 0 3px rgba(76,183,130,.12)"
	},
	coverageDotGap: {
		width: 7,
		height: 7,
		borderRadius: "50%",
		backgroundColor: tokens.colorWarning,
		boxShadow: "0 0 0 3px rgba(242,153,74,.12)"
	},
	graphTabs: { display: "flex", alignItems: "end", gap: 3, marginTop: 14, minHeight: 34 },
	graphTab: {
		display: "flex",
		gap: 8,
		alignItems: "center",
		height: 32,
		padding: "0 12px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderBottomColor: tokens.colorBorderStrong,
		borderTopLeftRadius: tokens.radiusControl,
		borderTopRightRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontSize: 11
	},
	graphTabActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		borderTopColor: tokens.colorAccent
	},
	zoomControls: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 },
	zoomButton: {
		height: 28,
		minWidth: 28,
		padding: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorBorderStrong },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		cursor: "pointer",
		transitionProperty: "transform, border-color",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { ":active": "scale(0.96)" }
	},
	zoomReset: { padding: "0 8px", fontFamily: tokens.fontMono, fontSize: 9 },
	zoomOutput: {
		minWidth: 45,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 10,
		textAlign: "center"
	},
	workspace: {
		height: "calc(100vh - 315px)",
		minHeight: 500,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 294px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusPanel,
		borderTopLeftRadius: 0,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden"
	},
	viewport: {
		overflow: "auto",
		backgroundColor: "#0a0c0f",
		backgroundImage:
			"linear-gradient(rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(rgba(103,113,126,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.035) 1px, transparent 1px)",
		backgroundSize: "80px 80px, 80px 80px, 16px 16px, 16px 16px"
	},
	canvas: { position: "relative", transformOrigin: "top left" },
	wires: {
		position: "absolute",
		inset: 0,
		overflow: "visible",
		pointerEvents: "none",
		fill: "none",
		stroke: "#5bc0eb",
		strokeWidth: 2,
		strokeLinecap: "round",
		opacity: 0.82
	},
	node: {
		position: "absolute",
		display: "block",
		padding: 0,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: "#343943", ":hover": "#596170" },
		borderRadius: 7,
		backgroundColor: "#15181d",
		color: tokens.colorText,
		boxShadow: "0 9px 24px rgba(0,0,0,.36)",
		overflow: "visible",
		textAlign: "left",
		cursor: "pointer",
		transitionProperty: "border-color, box-shadow",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut
	},
	nodeEvent: { borderTopColor: "#ef6a67" },
	nodeFunction: { borderTopColor: "#4f9ddf" },
	nodeVariable: { borderTopColor: "#60b58d" },
	nodeSelected: {
		borderColor: tokens.colorAccent,
		boxShadow: "0 0 0 1px rgba(228,242,34,.26), 0 12px 30px rgba(0,0,0,.5)"
	},
	nodeHeader: {
		height: NODE_HEADER_HEIGHT,
		display: "grid",
		alignContent: "center",
		gap: 2,
		padding: "0 11px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: "#2a2f37",
		borderTopLeftRadius: 6,
		borderTopRightRadius: 6,
		backgroundImage: "linear-gradient(180deg,#252a32,#1c2027)"
	},
	pinList: { display: "block", paddingTop: 4 },
	pinRow: {
		height: PIN_ROW_HEIGHT,
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		alignItems: "center",
		color: "#b7bdc7",
		fontSize: 10
	},
	pinSide: { minWidth: 0, display: "flex", alignItems: "center", gap: 6 },
	pinInput: { justifyContent: "flex-start", paddingLeft: 9 },
	pinOutput: { justifyContent: "flex-end", paddingRight: 9 },
	pinDot: {
		width: 8,
		height: 8,
		flex: "0 0 auto",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "#a4d7ee",
		borderRadius: "50%",
		backgroundColor: "#17242c",
		boxShadow: "0 0 0 2px rgba(91,192,235,.08)"
	},
	inspector: {
		minWidth: 0,
		overflow: "auto",
		borderLeftWidth: 1,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorder,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		padding: 16,
		fontSize: 12
	},
	inspectorContent: { display: "grid", alignContent: "start" },
	inspectorLabel: {
		margin: 0,
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		letterSpacing: ".12em"
	},
	kindBadge: {
		justifySelf: "start",
		marginTop: 8,
		padding: "3px 6px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		textTransform: "uppercase"
	},
	evidenceList: { display: "grid", gap: 0, margin: "16px 0 0" },
	evidenceRow: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "70px minmax(0, 1fr)",
		gap: 8,
		padding: "7px 0",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		overflowWrap: "anywhere"
	},
	propertyHeading: {
		display: "flex",
		justifyContent: "space-between",
		marginTop: 20,
		paddingBottom: 7,
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		color: tokens.colorText,
		fontSize: 11,
		fontWeight: 650
	},
	properties: { display: "grid" },
	property: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: 3,
		padding: "9px 0",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	propertyValue: {
		gridColumn: "1 / -1",
		maxHeight: 72,
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		lineHeight: 1.45,
		overflowWrap: "anywhere"
	}
});

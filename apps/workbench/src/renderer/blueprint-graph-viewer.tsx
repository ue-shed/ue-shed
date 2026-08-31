import * as stylex from "@stylexjs/stylex";
import type {
	BlueprintGraph,
	BlueprintGraphCoverageGap,
	BlueprintGraphProjection,
	BlueprintNode,
	BlueprintPin,
	BlueprintPinReference
} from "@ue-shed/protocol";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
	BlueprintAssetCandidate,
	BlueprintAssetSearchResult,
	BlueprintGraphReadResult
} from "../main/preload.js";
import type { BlueprintGraphFailureReason } from "../main/ipc-contracts.js";
import type { WorkbenchRendererClient } from "./workbench-client.js";

const NODE_WIDTH = 268;
const NODE_HEADER_HEIGHT = 43;
const PIN_ROW_HEIGHT = 25;
const GRAPH_MARGIN = 72;
const POSITION_SCALE = 0.82;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;

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

type FailedResult = Extract<BlueprintGraphReadResult, { readonly status: "failed" }>;

interface PanOrigin {
	readonly pointerId: number;
	readonly pointerX: number;
	readonly pointerY: number;
	readonly scrollLeft: number;
	readonly scrollTop: number;
}

type PinTone = "boolean" | "exec" | "numeric" | "object" | "struct" | "text" | "wildcard";

export interface BlueprintGraphViewerProps {
	readonly client: Pick<
		WorkbenchRendererClient,
		"chooseBlueprint" | "chooseProject" | "readBlueprint" | "searchBlueprints"
	>;
}

type ReadyBlueprintSearch = Extract<BlueprintAssetSearchResult, { readonly status: "ready" }>;

type IndexedBlueprintState =
	| { readonly status: "loading" }
	| { readonly status: "transport_failed" }
	| { readonly result: ReadyBlueprintSearch; readonly status: "ready" | "updating" }
	| Exclude<BlueprintAssetSearchResult, { readonly status: "ready" }>;

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

function isTopologyGap(gap: BlueprintGraphCoverageGap): boolean {
	return !["native_node_subclass_tail", "undecoded_node_property"].includes(gap.reason);
}

function gapLabel(reason: BlueprintGraphCoverageGap["reason"]): string {
	return reason.replaceAll("_", " ");
}

function findPin(
	graph: BlueprintGraph,
	reference: BlueprintPinReference
): BlueprintPin | undefined {
	if (reference.node_object_path === undefined) return undefined;
	return graph.nodes
		.find((node) => node.object_path === reference.node_object_path)
		?.pins.find((pin) => pin.id === reference.pin_id);
}

function pinTone(pin: BlueprintPin | undefined): PinTone {
	const category = pin?.pin_type.category.toLowerCase() ?? "";
	if (category === "exec") return "exec";
	if (category === "bool" || category === "boolean") return "boolean";
	if (["byte", "double", "float", "int", "int64", "real"].includes(category)) {
		return "numeric";
	}
	if (["name", "string", "text"].includes(category)) return "text";
	if (["class", "interface", "object", "softclass", "softobject"].includes(category)) {
		return "object";
	}
	if (category === "struct") return "struct";
	return "wildcard";
}

function pinToneColor(tone: PinTone): string {
	switch (tone) {
		case "boolean":
			return "#ef6a67";
		case "exec":
			return "#d8e0e8";
		case "numeric":
			return "#80d9ad";
		case "object":
			return "#5bc0eb";
		case "struct":
			return "#f0b35b";
		case "text":
			return "#d78ce8";
		case "wildcard":
			return "#8a919c";
	}
}

function PinDot(props: { readonly pin: BlueprintPin }) {
	return (
		<i
			style={"border-color:" + pinToneColor(pinTone(props.pin))}
			{...stylex.props(styles.pinDot)}
		/>
	);
}

function terminalTypeLabel(type: NonNullable<BlueprintPin["pin_type"]["value_type"]>): string {
	return [type.category, type.subcategory || type.subcategory_object?.split(".").at(-1)]
		.filter((value): value is string => value !== undefined && value !== "")
		.join(" · ");
}

function pinTypeLabel(pin: BlueprintPin): string {
	const type = pin.pin_type;
	const base = [type.category, type.subcategory || type.subcategory_object?.split(".").at(-1)]
		.filter((value): value is string => value !== undefined && value !== "")
		.join(" · ");
	const contained =
		type.container_type === "map" && type.value_type !== undefined
			? base + " → " + terminalTypeLabel(type.value_type)
			: base;
	const container =
		type.container_type === "none" ? contained : type.container_type + "<" + contained + ">";
	const modifiers = [type.is_const ? "const" : undefined, type.is_reference ? "ref" : undefined]
		.filter((value): value is string => value !== undefined)
		.join(" ");
	return modifiers === "" ? container || "wildcard" : modifiers + " " + (container || "wildcard");
}

function pinDefaults(
	pin: BlueprintPin
): readonly { readonly label: string; readonly value: string }[] {
	const defaults: Array<{ readonly label: string; readonly value: string }> = [];
	if (pin.default_text_value?.source) {
		defaults.push({ label: "Text default", value: pin.default_text_value.source });
	}
	if (pin.default_object) defaults.push({ label: "Object default", value: pin.default_object });
	if (pin.default_value !== "") {
		defaults.push({ label: "Saved default", value: pin.default_value });
	}
	if (pin.autogenerated_default_value !== "") {
		defaults.push({ label: "Generated default", value: pin.autogenerated_default_value });
	}
	return defaults;
}

function failureTitle(reason: BlueprintGraphFailureReason): string {
	switch (reason) {
		case "control_rig":
			return "Control Rig uses a different graph model";
		case "malformed_package":
			return "The saved package is malformed";
		case "missing_reader":
			return "The local UAsset reader is unavailable";
		case "reader_failure":
			return "The saved package could not be read";
		case "unsupported_asset":
			return "This package has no supported Blueprint graph";
		case "unsupported_version":
			return "This saved package revision is unsupported";
	}
}

export function BlueprintGraphViewer(props: BlueprintGraphViewerProps) {
	const openAction = createEffectAction();
	const indexAction = createEffectAction();
	const [assetPath, setAssetPath] = createSignal("");
	const [assetQuery, setAssetQuery] = createSignal("");
	const [indexedBlueprints, setIndexedBlueprints] = createSignal<IndexedBlueprintState>({
		status: "loading"
	});
	const [loading, setLoading] = createSignal(false);
	const [cancelled, setCancelled] = createSignal(false);
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [result, setResult] = createSignal<BlueprintGraphReadResult>();
	const [graphIndex, setGraphIndex] = createSignal(0);
	const [selectedNodePath, setSelectedNodePath] = createSignal<string>();
	const [zoom, setZoom] = createSignal(1);
	const [panning, setPanning] = createSignal(false);
	let viewport: HTMLDivElement | undefined;
	let panOrigin: PanOrigin | undefined;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	const ready = createMemo(() => {
		const value = result();
		return value?.status === "ready" ? value : undefined;
	});
	const blueprint = createMemo((): BlueprintGraphProjection | undefined => ready()?.blueprint);
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
	const topologyGaps = createMemo(() => blueprint()?.coverage_gaps.filter(isTopologyGap) ?? []);
	const metadataGaps = createMemo(
		() => blueprint()?.coverage_gaps.filter((gap) => !isTopologyGap(gap)) ?? []
	);
	const indexedResult = createMemo(() => {
		const state = indexedBlueprints();
		return state.status === "ready" || state.status === "updating" ? state.result : undefined;
	});
	const indexFailure = createMemo(() => {
		const state = indexedBlueprints();
		return state.status === "failed" ? state : undefined;
	});
	const indexBusy = createMemo(() =>
		["loading", "updating"].includes(indexedBlueprints().status)
	);

	const setZoomLevel = (value: number) => {
		setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100)));
	};
	const resetViewport = () => {
		if (viewport !== undefined) {
			viewport.scrollLeft = 0;
			viewport.scrollTop = 0;
		}
	};

	const accept = (next: BlueprintGraphReadResult) => {
		setLoading(false);
		if (next.status === "cancelled") {
			setCancelled(true);
			return;
		}
		setResult(next);
		if (next.status === "ready") {
			setAssetPath(next.assetPath);
			setGraphIndex(0);
			setSelectedNodePath(next.blueprint.graphs[0]?.nodes[0]?.object_path);
			setZoom(1);
			resetViewport();
		}
	};
	const run = (effect: ReturnType<BlueprintGraphViewerProps["client"]["readBlueprint"]>) => {
		setLoading(true);
		setCancelled(false);
		setTransportFailure(false);
		openAction.run(effect, {
			onFailure: () => {
				setLoading(false);
				setResult(undefined);
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
	const requestBlueprints = (query: string) => {
		setIndexedBlueprints((current) =>
			current.status === "ready" || current.status === "updating"
				? { result: current.result, status: "updating" }
				: { status: "loading" }
		);
		indexAction.run(props.client.searchBlueprints({ query }), {
			onFailure: () => setIndexedBlueprints({ status: "transport_failed" }),
			onSuccess: (next) =>
				setIndexedBlueprints(
					next.status === "ready" ? { result: next, status: "ready" } : next
				)
		});
	};
	const updateAssetQuery = (query: string) => {
		setAssetQuery(query);
		if (searchTimer !== undefined) clearTimeout(searchTimer);
		searchTimer = setTimeout(() => requestBlueprints(query), 120);
	};
	const chooseProject = () => {
		setIndexedBlueprints({ status: "loading" });
		indexAction.run(props.client.chooseProject(), {
			onFailure: () => setIndexedBlueprints({ status: "transport_failed" }),
			onSuccess: (state) => {
				if (state.status === "ready") {
					requestBlueprints(assetQuery());
					return;
				}
				if (state.status === "failed") {
					setIndexedBlueprints({
						message: state.error.message,
						recovery: state.error.recovery,
						status: "failed"
					});
					return;
				}
				setIndexedBlueprints({ status: "not_configured" });
			}
		});
	};
	const openIndexedBlueprint = (asset: BlueprintAssetCandidate) => {
		setAssetPath(asset.assetPath);
		run(props.client.readBlueprint(asset.assetPath));
	};
	const searchKeyDown = (event: KeyboardEvent & { readonly currentTarget: HTMLInputElement }) => {
		if (event.key === "Escape" && assetQuery() !== "") {
			event.preventDefault();
			updateAssetQuery("");
			return;
		}
		if (event.key !== "Enter") return;
		const first = indexedResult()?.assets[0];
		if (first === undefined) return;
		event.preventDefault();
		openIndexedBlueprint(first);
	};
	const chooseGraph = (index: number) => {
		setGraphIndex(index);
		setSelectedNodePath(blueprint()?.graphs[index]?.nodes[0]?.object_path);
		setZoom(1);
		resetViewport();
	};
	const fitGraph = () => {
		if (viewport === undefined) return;
		setZoomLevel(
			Math.min(
				(viewport.clientWidth - 32) / layout().width,
				(viewport.clientHeight - 32) / layout().height
			)
		);
		resetViewport();
	};
	const resetView = () => {
		setZoom(1);
		resetViewport();
	};
	const beginPan = (event: PointerEvent & { readonly currentTarget: HTMLDivElement }) => {
		if (event.button !== 0) return;
		if (event.target instanceof Element && event.target.closest("button") !== null) return;
		panOrigin = {
			pointerId: event.pointerId,
			pointerX: event.clientX,
			pointerY: event.clientY,
			scrollLeft: event.currentTarget.scrollLeft,
			scrollTop: event.currentTarget.scrollTop
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		setPanning(true);
	};
	const continuePan = (event: PointerEvent & { readonly currentTarget: HTMLDivElement }) => {
		if (panOrigin === undefined || panOrigin.pointerId !== event.pointerId) return;
		event.currentTarget.scrollLeft =
			panOrigin.scrollLeft - (event.clientX - panOrigin.pointerX);
		event.currentTarget.scrollTop = panOrigin.scrollTop - (event.clientY - panOrigin.pointerY);
	};
	const finishPan = (event: PointerEvent & { readonly currentTarget: HTMLDivElement }) => {
		if (panOrigin?.pointerId !== event.pointerId) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		panOrigin = undefined;
		setPanning(false);
	};
	const zoomWheel = (event: WheelEvent) => {
		if (!event.ctrlKey) return;
		event.preventDefault();
		setZoomLevel(zoom() + (event.deltaY < 0 ? 0.1 : -0.1));
	};

	onMount(() => requestBlueprints(""));
	onCleanup(() => {
		if (searchTimer !== undefined) clearTimeout(searchTimer);
	});

	return (
		<main aria-busy={loading() || indexBusy()} {...stylex.props(styles.route)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>
						Saved package evidence / Blueprint graphs
					</p>
					<h1 {...stylex.props(styles.title)}>Blueprint Graphs</h1>
					<p {...stylex.props(styles.intro)}>
						Inspect the graph exactly as it was saved in an uncooked .uasset. The local
						reader opens package bytes directly—without an editor process, asset load,
						compile, or selected Unreal project.
					</p>
				</div>
				<div {...stylex.props(styles.authorityBadges)}>
					<span {...stylex.props(styles.offlineBadge)}>LOCAL FILE · NO UNREAL</span>
					<span {...stylex.props(styles.readOnlyStamp)}>
						READ ONLY · SAVED PACKAGE · SCHEMA 1
					</span>
				</div>
			</header>

			<section
				aria-busy={indexBusy()}
				aria-label="Indexed Blueprints"
				{...stylex.props(styles.indexPanel)}
			>
				<div {...stylex.props(styles.indexPanelHeader)}>
					<div {...stylex.props(styles.indexIdentity)}>
						<span {...stylex.props(styles.indexMark)}>⌕</span>
						<span {...stylex.props(styles.indexIdentityCopy)}>
							<small {...stylex.props(styles.indexEyebrow)}>PROJECT INDEX</small>
							<strong {...stylex.props(styles.indexTitle)}>
								Find a saved Blueprint
							</strong>
						</span>
					</div>
					<Show when={indexedResult()}>
						{(catalog) => (
							<span {...stylex.props(styles.indexProject)}>
								{indexedBlueprints().status === "updating"
									? "SEARCHING"
									: catalog().projectName.toUpperCase()}
							</span>
						)}
					</Show>
				</div>

				<Show when={indexedBlueprints().status === "loading"}>
					<div aria-live="polite" role="status" {...stylex.props(styles.indexStatus)}>
						<span {...stylex.props(styles.loadingSpinner)} />
						<span {...stylex.props(styles.indexStatusCopy)}>
							<strong>Loading the saved package index</strong>
							<small>No package graph is decoded until you open a result.</small>
						</span>
					</div>
				</Show>

				<Show when={indexedBlueprints().status === "not_configured"}>
					<div {...stylex.props(styles.indexCallout)}>
						<span {...stylex.props(styles.indexStatusCopy)}>
							<strong>No Workbench project is selected</strong>
							<small>
								Choose a project to search its cached .uasset inventory, or open any
								package directly below.
							</small>
						</span>
						<button
							onClick={chooseProject}
							type="button"
							{...stylex.props(styles.indexAction)}
						>
							Choose project
						</button>
					</div>
				</Show>

				<Show when={indexFailure()}>
					{(failure) => (
						<div role="alert" {...stylex.props(styles.indexCallout, styles.indexError)}>
							<span {...stylex.props(styles.indexStatusCopy)}>
								<strong>{failure().message}</strong>
								<small>{failure().recovery}</small>
							</span>
							<button
								onClick={() => requestBlueprints(assetQuery())}
								type="button"
								{...stylex.props(styles.indexAction)}
							>
								Retry index
							</button>
						</div>
					)}
				</Show>

				<Show when={indexedBlueprints().status === "transport_failed"}>
					<div role="alert" {...stylex.props(styles.indexCallout, styles.indexError)}>
						<span {...stylex.props(styles.indexStatusCopy)}>
							<strong>The project index request could not be completed</strong>
							<small>
								Retry the local request. Direct path entry remains available and
								does not require Unreal.
							</small>
						</span>
						<button
							onClick={() => requestBlueprints(assetQuery())}
							type="button"
							{...stylex.props(styles.indexAction)}
						>
							Retry index
						</button>
					</div>
				</Show>

				<Show when={indexedResult()}>
					{(catalog) => (
						<div {...stylex.props(styles.indexBody)}>
							<label {...stylex.props(styles.indexSearchField)}>
								<span>Search asset name, package, path, or Blueprint class</span>
								<span {...stylex.props(styles.indexSearchControl)}>
									<span aria-hidden="true" {...stylex.props(styles.searchGlyph)}>
										⌕
									</span>
									<input
										aria-label="Search indexed Blueprints"
										autocomplete="off"
										onInput={(event) =>
											updateAssetQuery(event.currentTarget.value)
										}
										onKeyDown={searchKeyDown}
										placeholder="Try BP_Player, /Game/UI, or WidgetBlueprint"
										spellcheck={false}
										value={assetQuery()}
										{...stylex.props(styles.indexSearchInput)}
									/>
									<kbd {...stylex.props(styles.enterHint)}>ENTER TO OPEN</kbd>
								</span>
							</label>

							<Show
								when={catalog().assets.length > 0}
								fallback={
									<div {...stylex.props(styles.noIndexResults)}>
										<strong>
											No indexed Blueprints match “{assetQuery()}”
										</strong>
										<small>
											Try a shorter package name, or use direct path entry for
											an asset outside this project.
										</small>
									</div>
								}
							>
								<div
									aria-label="Blueprint search results"
									{...stylex.props(styles.indexResults)}
								>
									<For each={catalog().assets}>
										{(asset) => (
											<button
												aria-label={`Open ${asset.assetName} from project index`}
												onClick={() => openIndexedBlueprint(asset)}
												type="button"
												{...stylex.props(styles.indexResult)}
											>
												<span {...stylex.props(styles.assetMonogram)}>
													{asset.assetName.slice(0, 2).toUpperCase()}
												</span>
												<span {...stylex.props(styles.assetIdentity)}>
													<strong
														title={asset.assetName}
														{...stylex.props(styles.assetName)}
													>
														{asset.assetName}
													</strong>
													<small
														title={asset.packageName}
														{...stylex.props(styles.assetPackage)}
													>
														{asset.packageName}
													</small>
												</span>
												<span {...stylex.props(styles.assetClass)}>
													{asset.className}
												</span>
												<span
													aria-hidden="true"
													{...stylex.props(styles.openArrow)}
												>
													→
												</span>
											</button>
										)}
									</For>
								</div>
							</Show>
							<div aria-live="polite" {...stylex.props(styles.indexFooter)}>
								<span>
									{catalog().matchCount === catalog().assets.length
										? `${catalog().matchCount} indexed Blueprint${catalog().matchCount === 1 ? "" : "s"}`
										: `Showing ${catalog().assets.length} of ${catalog().matchCount} matches`}
								</span>
								<span>Header evidence only · graph decoded on open</span>
							</div>
						</div>
					)}
				</Show>
			</section>

			<form onSubmit={readPath} {...stylex.props(styles.pathBar)}>
				<label {...stylex.props(styles.pathField)}>
					<span>Direct package path</span>
					<input
						aria-label="Blueprint package path"
						onInput={(event) => setAssetPath(event.currentTarget.value)}
						placeholder="C:\Project\Content\Blueprints\BP_Example.uasset"
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
				<FailureNotice
					message="Workbench could not complete the local reader request."
					recovery="Verify the configured uasset executable, then retry. Unreal is not required."
					title="The local reader request failed"
				/>
			</Show>
			<Show when={failure()}>{(value) => <FailureNotice failure={value()} />}</Show>
			<Show when={loading()}>
				<div aria-live="polite" role="status" {...stylex.props(styles.loadingNotice)}>
					<span {...stylex.props(styles.loadingSpinner)} />
					<span {...stylex.props(styles.loadingCopy)}>
						<strong>Reading saved package</strong>
						<small>Decoding locally. No editor session will be started.</small>
					</span>
				</div>
			</Show>
			<Show when={cancelled()}>
				<div aria-live="polite" role="status" {...stylex.props(styles.cancelNotice)}>
					File selection cancelled. No package was opened or changed.
				</div>
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
						<p {...stylex.props(styles.emptyKicker)}>DIRECT FROM DISK</p>
						<h2>Open saved Blueprint evidence</h2>
						<p>
							Search the selected project's saved package index, paste an absolute
							path, or choose a .uasset from anywhere on disk. No running Unreal
							Editor is required.
						</p>
						<div {...stylex.props(styles.emptyFacts)}>
							<span>Positions preserved</span>
							<span>Pins + defaults</span>
							<span>Links + coverage</span>
						</div>
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
										topologyGaps().length === 0
											? styles.coverageDotReady
											: styles.coverageDotGap
									)}
								/>
								<span>
									<strong>
										{topologyGaps().length === 0
											? "Topology complete"
											: "Topology partial"}
									</strong>
									<small>
										{projection().coverage_gaps.length === 0
											? " · no recorded gaps"
											: " · " +
												projection().coverage_gaps.length +
												" recorded gaps"}
									</small>
								</span>
							</div>
						</section>

						<ProjectionCoverage
							gaps={projection().coverage_gaps}
							metadataGaps={metadataGaps()}
							outcome={ready()?.outcome ?? "complete"}
							topologyGaps={topologyGaps()}
						/>

						<Show when={ready()?.outcome === "partial"}>
							<section
								aria-label="Blueprint decode diagnostics"
								{...stylex.props(styles.diagnostics)}
							>
								<strong>Partial Blueprint decode</strong>
								<span>
									The graph remains inspectable, but some saved evidence could not
									be projected completely.
								</span>
								<ul {...stylex.props(styles.diagnosticList)}>
									<For each={ready()?.diagnostics}>
										{(diagnostic) => (
											<li>
												<code {...stylex.props(styles.diagnosticCode)}>
													{diagnostic.code}
												</code>{" "}
												{diagnostic.message}
											</li>
										)}
									</For>
								</ul>
							</section>
						</Show>

						<Show
							when={projection().graphs.length > 0}
							fallback={<GraphlessBlueprint objectPath={projection().object_path} />}
						>
							<div
								aria-label="Saved graphs"
								role="tablist"
								{...stylex.props(styles.graphTabs)}
							>
								<For each={projection().graphs}>
									{(item, index) => (
										<button
											aria-label={`${item.name}, ${item.nodes.length} nodes`}
											aria-pressed={graphIndex() === index()}
											onClick={() => chooseGraph(index())}
											type="button"
											{...stylex.props(
												styles.graphTab,
												graphIndex() === index() && styles.graphTabActive
											)}
										>
											<span
												title={item.name}
												{...stylex.props(styles.graphTabName)}
											>
												{item.name}
											</span>
											<small>{item.nodes.length}</small>
										</button>
									)}
								</For>
								<div {...stylex.props(styles.zoomControls)}>
									<span {...stylex.props(styles.panHint)}>
										Drag to pan · Ctrl+wheel to zoom
									</span>
									<button
										aria-label="Zoom out"
										onClick={() => setZoomLevel(zoom() - 0.1)}
										type="button"
										{...stylex.props(styles.zoomButton)}
									>
										−
									</button>
									<output
										aria-label="Graph zoom"
										{...stylex.props(styles.zoomOutput)}
									>
										{Math.round(zoom() * 100)}%
									</output>
									<button
										aria-label="Zoom in"
										onClick={() => setZoomLevel(zoom() + 0.1)}
										type="button"
										{...stylex.props(styles.zoomButton)}
									>
										+
									</button>
									<button
										onClick={fitGraph}
										type="button"
										{...stylex.props(styles.zoomButton, styles.zoomReset)}
									>
										Fit
									</button>
									<button
										onClick={resetView}
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
								<div
									aria-label="Graph viewport"
									onPointerCancel={finishPan}
									onPointerDown={beginPan}
									onPointerMove={continuePan}
									onPointerUp={finishPan}
									onWheel={zoomWheel}
									ref={(element) => {
										viewport = element;
									}}
									tabindex={0}
									{...stylex.props(
										styles.viewport,
										panning() && styles.viewportPanning
									)}
								>
									<div
										style={
											"width:" +
											layout().width * zoom() +
											"px;height:" +
											layout().height * zoom() +
											"px"
										}
									>
										<div
											style={
												"width:" +
												layout().width +
												"px;height:" +
												layout().height +
												"px;transform:scale(" +
												zoom() +
												")"
											}
											{...stylex.props(styles.canvas)}
										>
											<svg
												aria-hidden="true"
												height={layout().height}
												width={layout().width}
												{...stylex.props(styles.wires)}
											>
												<For each={graph()?.links}>
													{(link) => (
														<Show when={linkPath(layout(), link)}>
															{(path) => (
																<path
																	d={path()}
																	style={
																		"stroke:" +
																		pinToneColor(
																			pinTone(
																				graph() ===
																					undefined
																					? undefined
																					: findPin(
																							graph()!,
																							link.from
																						)
																			)
																		) +
																		";opacity:" +
																		(selectedNodePath() ===
																		undefined
																			? "0.8"
																			: selectedNodePath() ===
																						link.from
																							.node_object_path ||
																				  selectedNodePath() ===
																						link.to
																							.node_object_path
																				? "1"
																				: "0.18") +
																		";stroke-width:" +
																		(selectedNodePath() ===
																			link.from
																				.node_object_path ||
																		selectedNodePath() ===
																			link.to.node_object_path
																			? "3"
																			: "2")
																	}
																	{...stylex.props(styles.wire)}
																/>
															)}
														</Show>
													)}
												</For>
											</svg>
											<Show when={(graph()?.nodes.length ?? 0) === 0}>
												<div {...stylex.props(styles.emptyGraphCanvas)}>
													<strong>No nodes saved in this graph</strong>
													<span>
														The graph export exists, but its saved Nodes
														array is empty.
													</span>
												</div>
											</Show>
											<For each={graph()?.nodes}>
												{(node) => {
													const placed = () =>
														layout().nodes.get(node.object_path);
													return (
														<button
															aria-label={"Inspect " + node.title}
															onClick={() =>
																setSelectedNodePath(
																	node.object_path
																)
															}
															style={
																"left:" +
																(placed()?.x ?? 0) +
																"px;top:" +
																(placed()?.y ?? 0) +
																"px;width:" +
																NODE_WIDTH +
																"px;height:" +
																(placed()?.height ??
																	nodeHeight(node)) +
																"px"
															}
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
															<span
																{...stylex.props(styles.nodeHeader)}
															>
																<span
																	title={node.title}
																	{...stylex.props(
																		styles.nodeTitle
																	)}
																>
																	{node.title}
																</span>
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
																					<PinDot
																						pin={pin}
																					/>
																					<span>
																						{pinLabel(
																							pin
																						)}
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
																						{pinLabel(
																							pin
																						)}
																					</span>
																					<PinDot
																						pin={pin}
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
										fallback={
											<p>Select a node to inspect its saved evidence.</p>
										}
									>
										{(node) => <NodeInspector node={node()} />}
									</Show>
								</aside>
							</section>
						</Show>
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

function FailureNotice(
	props:
		| {
				readonly failure: FailedResult;
				readonly message?: never;
				readonly recovery?: never;
				readonly title?: never;
		  }
		| {
				readonly failure?: never;
				readonly message: string;
				readonly recovery: string;
				readonly title: string;
		  }
) {
	const title = () =>
		props.failure === undefined ? props.title : failureTitle(props.failure.reason);
	const message = () => (props.failure === undefined ? props.message : props.failure.message);
	const recovery = () => (props.failure === undefined ? props.recovery : props.failure.recovery);
	return (
		<section aria-label={title()} role="alert" {...stylex.props(styles.failure)}>
			<div {...stylex.props(styles.failureHeader)}>
				<span>READ FAILED</span>
				<strong>{title()}</strong>
			</div>
			<p>{message()}</p>
			<p {...stylex.props(styles.failureRecovery)}>{recovery()}</p>
			<Show when={props.failure?.assetPath}>
				{(path) => <code {...stylex.props(styles.failurePath)}>{path()}</code>}
			</Show>
		</section>
	);
}

function ProjectionCoverage(props: {
	readonly gaps: readonly BlueprintGraphCoverageGap[];
	readonly metadataGaps: readonly BlueprintGraphCoverageGap[];
	readonly outcome: "complete" | "partial";
	readonly topologyGaps: readonly BlueprintGraphCoverageGap[];
}) {
	const complete = () => props.outcome === "complete" && props.gaps.length === 0;
	const metadataOnly = () => props.topologyGaps.length === 0 && props.metadataGaps.length > 0;
	const decodeOnly = () =>
		props.outcome === "partial" &&
		props.topologyGaps.length === 0 &&
		props.metadataGaps.length === 0;
	return (
		<section
			aria-label="Projection coverage"
			{...stylex.props(
				styles.coveragePanel,
				complete() ? styles.coveragePanelComplete : styles.coveragePanelPartial
			)}
		>
			<span
				{...stylex.props(
					styles.coverageMark,
					complete() ? styles.coverageMarkComplete : styles.coverageMarkPartial
				)}
			>
				{complete() ? "✓" : "!"}
			</span>
			<div {...stylex.props(styles.coverageCopy)}>
				<strong {...stylex.props(styles.coverageHeadline)}>
					{complete()
						? "Complete saved-graph projection"
						: metadataOnly()
							? "Topology complete; specialized metadata partial"
							: decodeOnly()
								? "Topology complete; projection partial"
								: "Partial saved-graph projection"}
				</strong>
				<p {...stylex.props(styles.coverageText)}>
					{complete()
						? "Graph membership, nodes, pins, and links were projected without a recorded coverage gap."
						: metadataOnly()
							? "Native subclass tails or tagged properties remain opaque. This does not mean graph links are missing."
							: decodeOnly()
								? "The reader reported a partial native decode, but no topology coverage gap was recorded."
								: "One or more saved graph references could not be resolved. Shown links are evidence, but topology may be incomplete."}
				</p>
			</div>
			<Show when={props.gaps.length > 0}>
				<details {...stylex.props(styles.coverageDetails)}>
					<summary {...stylex.props(styles.coverageSummary)}>
						{props.gaps.length} coverage gaps
					</summary>
					<ul {...stylex.props(styles.gapList)}>
						<For each={props.gaps}>
							{(gap) => (
								<li {...stylex.props(styles.gapItem)}>
									<strong>{gapLabel(gap.reason)}</strong>
									<span>{gap.detail}</span>
									<code {...stylex.props(styles.gapCode)}>{gap.object_path}</code>
								</li>
							)}
						</For>
					</ul>
				</details>
			</Show>
		</section>
	);
}

function GraphlessBlueprint(props: { readonly objectPath: string }) {
	return (
		<section aria-label="Graphless Blueprint" {...stylex.props(styles.graphless)}>
			<span {...stylex.props(styles.graphlessMark)}>0</span>
			<p {...stylex.props(styles.emptyKicker)}>VALID BLUEPRINT PACKAGE</p>
			<h2>No saved editor graphs</h2>
			<p>
				The package was read successfully, but its Blueprint saved no editor graph exports.
				This is a valid graphless result, not a reader failure.
			</p>
			<code {...stylex.props(styles.graphlessPath)}>{props.objectPath}</code>
		</section>
	);
}

function PinEvidence(props: { readonly pin: BlueprintPin }) {
	const defaults = () => pinDefaults(props.pin);
	return (
		<article {...stylex.props(styles.pinEvidence)}>
			<div {...stylex.props(styles.pinEvidenceHeader)}>
				<i
					style={`border-color:${pinToneColor(pinTone(props.pin))}`}
					{...stylex.props(styles.pinEvidenceDot)}
				/>
				<strong title={pinLabel(props.pin)}>{pinLabel(props.pin)}</strong>
				<span>{props.pin.direction}</span>
			</div>
			<code {...stylex.props(styles.pinType)}>{pinTypeLabel(props.pin)}</code>
			<div {...stylex.props(styles.pinMeta)}>
				<span>{props.pin.linked_to.length} links</span>
				<Show when={props.pin.sub_pins.length > 0}>
					<span>{props.pin.sub_pins.length} sub-pins</span>
				</Show>
				<Show when={props.pin.parent_pin !== undefined}>
					<span>child pin</span>
				</Show>
			</div>
			<Show
				when={defaults().length > 0}
				fallback={<small {...stylex.props(styles.noDefault)}>No serialized default</small>}
			>
				<dl {...stylex.props(styles.pinDefaults)}>
					<For each={defaults()}>
						{(value) => (
							<div {...stylex.props(styles.pinDefaultRow)}>
								<dt {...stylex.props(styles.pinDefaultLabel)}>{value.label}</dt>
								<dd title={value.value} {...stylex.props(styles.pinDefaultValue)}>
									{value.value}
								</dd>
							</div>
						)}
					</For>
				</dl>
			</Show>
			<Show when={props.pin.tooltip !== ""}>
				<p {...stylex.props(styles.pinTooltip)}>{props.pin.tooltip}</p>
			</Show>
		</article>
	);
}

function NodeInspector(props: { readonly node: BlueprintNode }) {
	return (
		<div {...stylex.props(styles.inspectorContent)}>
			<p {...stylex.props(styles.inspectorLabel)}>SELECTED NODE</p>
			<h2 title={props.node.title} {...stylex.props(styles.inspectorTitle)}>
				{props.node.title}
			</h2>
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
					<dt>Native tail</dt>
					<dd>
						{props.node.subclass_tail_bytes === 0
							? "none"
							: `${props.node.subclass_tail_bytes} bytes · metadata unavailable`}
					</dd>
				</div>
			</dl>

			<div {...stylex.props(styles.propertyHeading)}>
				<span>Saved pin evidence</span>
				<small>{props.node.pins.length}</small>
			</div>
			<div aria-label="Saved pin evidence" {...stylex.props(styles.pinEvidenceList)}>
				<For
					each={props.node.pins}
					fallback={
						<p {...stylex.props(styles.inspectorEmpty)}>No pins were serialized.</p>
					}
				>
					{(pin) => <PinEvidence pin={pin} />}
				</For>
			</div>

			<div {...stylex.props(styles.propertyHeading)}>
				<span>Tagged properties</span>
				<small>{props.node.properties.length}</small>
			</div>
			<div {...stylex.props(styles.properties)}>
				<For
					each={props.node.properties}
					fallback={<p {...stylex.props(styles.inspectorEmpty)}>No tagged properties.</p>}
				>
					{(property) => (
						<details {...stylex.props(styles.property)}>
							<summary {...stylex.props(styles.propertySummary)}>
								<span title={property.name}>{property.name}</span>
								<small>{property.type}</small>
							</summary>
							<code {...stylex.props(styles.propertyValue)}>
								{JSON.stringify(property)}
							</code>
						</details>
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
	authorityBadges: {
		display: "grid",
		justifyItems: "end",
		gap: 6,
		flexShrink: 0
	},
	offlineBadge: {
		padding: "5px 8px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(76,183,130,.1)",
		color: tokens.colorSuccess,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		fontWeight: 700,
		letterSpacing: "0.08em"
	},
	readOnlyStamp: {
		flexShrink: 0,
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
	indexPanel: {
		marginBottom: 10,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurface,
		boxShadow: tokens.shadowCard,
		overflow: "hidden"
	},
	indexPanelHeader: {
		height: 52,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 16,
		padding: "0 14px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		backgroundColor: tokens.colorSurfaceRaised
	},
	indexIdentity: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		color: tokens.colorTextMuted
	},
	indexIdentityCopy: { display: "grid", gap: 2 },
	indexEyebrow: {
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 7,
		fontWeight: 700,
		letterSpacing: ".12em"
	},
	indexTitle: { color: tokens.colorTextStrong, fontSize: 11 },
	indexMark: {
		width: 27,
		height: 27,
		display: "grid",
		placeItems: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 18,
		lineHeight: 1
	},
	indexProject: {
		padding: "4px 7px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusBadge,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		fontWeight: 700,
		letterSpacing: ".09em"
	},
	indexStatus: {
		minHeight: 82,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 11,
		padding: 16,
		color: tokens.colorTextMuted,
		fontSize: 11,
		textAlign: "left"
	},
	indexStatusCopy: { display: "grid", gap: 3 },
	indexCallout: {
		minHeight: 72,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 20,
		padding: "12px 14px",
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorAccent,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	indexError: {
		borderLeftColor: tokens.colorDanger,
		backgroundColor: "rgba(235,87,87,.06)"
	},
	indexAction: {
		height: 32,
		flexShrink: 0,
		padding: "0 12px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorderStrong, ":hover": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		cursor: "pointer",
		fontSize: 10,
		fontWeight: 700,
		transitionProperty: "border-color, transform",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { ":active": "scale(.97)" }
	},
	indexBody: { display: "grid" },
	indexSearchField: {
		display: "grid",
		gap: 6,
		padding: "11px 12px 10px",
		color: tokens.colorTextMuted,
		fontSize: 9,
		fontWeight: 650,
		letterSpacing: ".05em",
		textTransform: "uppercase"
	},
	indexSearchControl: { position: "relative", display: "block" },
	searchGlyph: {
		position: "absolute",
		left: 11,
		top: "50%",
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 18,
		lineHeight: 1,
		pointerEvents: "none",
		transform: "translateY(-53%)"
	},
	indexSearchInput: {
		width: "100%",
		height: 40,
		padding: "0 132px 0 37px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorderStrong, ":focus": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		outline: "none",
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textTransform: "none",
		transitionProperty: "border-color, box-shadow",
		transitionDuration: tokens.motionFast,
		boxShadow: { ":focus": "0 0 0 3px rgba(228,242,34,.08)" }
	},
	enterHint: {
		position: "absolute",
		right: 9,
		top: "50%",
		padding: "3px 5px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 7,
		fontWeight: 700,
		transform: "translateY(-50%)"
	},
	indexResults: {
		maxHeight: 226,
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))",
		gap: 6,
		padding: "0 12px 10px",
		overflow: "auto"
	},
	indexResult: {
		minWidth: 0,
		height: 54,
		display: "grid",
		gridTemplateColumns: "30px minmax(0, 1fr) auto 16px",
		alignItems: "center",
		gap: 9,
		padding: "0 9px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: { default: tokens.colorBorder, ":hover": tokens.colorAccent },
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: tokens.colorSurfaceInset, ":hover": tokens.colorAccentWash },
		color: tokens.colorText,
		cursor: "pointer",
		textAlign: "left",
		transitionProperty: "border-color, background-color, transform",
		transitionDuration: tokens.motionFast,
		transitionTimingFunction: tokens.motionEaseOut,
		transform: { ":active": "scale(.992)" }
	},
	assetMonogram: {
		width: 28,
		height: 28,
		display: "grid",
		placeItems: "center",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: "rgba(91,192,235,.32)",
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(91,192,235,.08)",
		color: "#80d5f3",
		fontFamily: tokens.fontMono,
		fontSize: 8,
		fontWeight: 800
	},
	assetIdentity: {
		minWidth: 0,
		display: "grid",
		gap: 3,
		overflow: "hidden"
	},
	assetName: {
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 10,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	assetPackage: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	assetClass: {
		maxWidth: 116,
		padding: "3px 5px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	openArrow: { color: tokens.colorAccent, fontFamily: tokens.fontMono, fontSize: 14 },
	noIndexResults: {
		minHeight: 78,
		display: "grid",
		placeContent: "center",
		gap: 4,
		padding: "0 16px 11px",
		color: tokens.colorTextMuted,
		fontSize: 11,
		textAlign: "center"
	},
	indexFooter: {
		display: "flex",
		justifyContent: "space-between",
		gap: 16,
		padding: "8px 12px",
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		letterSpacing: ".04em",
		textTransform: "uppercase"
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
		gridTemplateColumns: "minmax(180px, .65fr) minmax(240px, 1fr)",
		gap: "6px 18px",
		marginTop: 12,
		padding: "13px 15px",
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorDanger,
		backgroundColor: "rgba(235,87,87,.08)",
		color: tokens.colorText,
		fontSize: 12
	},
	diagnostics: {
		display: "grid",
		gap: 4,
		marginTop: 10,
		padding: "11px 13px",
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorWarning,
		backgroundColor: "rgba(242,153,74,.08)",
		color: tokens.colorText,
		fontSize: 12
	},
	diagnosticList: {
		display: "grid",
		gap: 3,
		margin: "4px 0 0",
		paddingLeft: 18,
		color: tokens.colorTextMuted
	},
	diagnosticCode: {
		color: tokens.colorWarning,
		fontFamily: tokens.fontMono,
		fontSize: 10
	},
	failureHeader: {
		gridRow: "1 / span 3",
		display: "grid",
		alignContent: "start",
		gap: 4,
		minWidth: 0,
		color: tokens.colorTextStrong,
		fontSize: 13
	},
	failureRecovery: { margin: 0, color: tokens.colorTextMuted },
	failurePath: {
		minWidth: 0,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		overflowWrap: "anywhere"
	},
	loadingNotice: {
		display: "flex",
		alignItems: "center",
		gap: 11,
		marginTop: 12,
		padding: "10px 13px",
		borderLeftWidth: 3,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorAccent,
		backgroundColor: tokens.colorAccentWash,
		color: tokens.colorText,
		fontSize: 12
	},
	loadingSpinner: {
		width: 13,
		height: 13,
		flex: "0 0 auto",
		borderWidth: 2,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderTopColor: tokens.colorAccent,
		borderRadius: "50%",
		animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
		animationDuration: "700ms",
		animationIterationCount: "infinite",
		animationTimingFunction: "linear"
	},
	loadingCopy: { display: "grid", gap: 2 },
	cancelNotice: {
		marginTop: 12,
		padding: "9px 12px",
		borderLeftWidth: 2,
		borderLeftStyle: "solid",
		borderLeftColor: tokens.colorBorderStrong,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		fontSize: 11
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
	emptyKicker: {
		margin: "0 0 7px",
		color: tokens.colorAccent,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		letterSpacing: ".12em"
	},
	emptyFacts: {
		display: "flex",
		flexWrap: "wrap",
		justifyContent: "center",
		gap: 6,
		marginTop: 16,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 9
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
		fontSize: 11,
		whiteSpace: "nowrap"
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
	coveragePanel: {
		display: "grid",
		gridTemplateColumns: "auto minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 11,
		marginTop: 9,
		padding: "9px 12px",
		borderWidth: 1,
		borderStyle: "solid",
		borderRadius: tokens.radiusControl,
		fontSize: 11
	},
	coveragePanelComplete: {
		borderColor: "rgba(76,183,130,.25)",
		backgroundColor: "rgba(76,183,130,.055)"
	},
	coveragePanelPartial: {
		borderColor: "rgba(242,153,74,.3)",
		backgroundColor: "rgba(242,153,74,.065)"
	},
	coverageMark: {
		width: 19,
		height: 19,
		display: "grid",
		placeItems: "center",
		borderRadius: "50%",
		fontFamily: tokens.fontMono,
		fontSize: 10,
		fontWeight: 750
	},
	coverageMarkComplete: { backgroundColor: "rgba(76,183,130,.15)", color: tokens.colorSuccess },
	coverageMarkPartial: { backgroundColor: "rgba(242,153,74,.14)", color: tokens.colorWarning },
	coverageCopy: { minWidth: 0 },
	coverageHeadline: { color: tokens.colorText, fontSize: 11 },
	coverageText: { margin: "2px 0 0", color: tokens.colorTextMuted, lineHeight: 1.4 },
	coverageDetails: {
		position: "relative",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 9
	},
	coverageSummary: { cursor: "pointer", whiteSpace: "nowrap" },
	gapList: {
		position: "absolute",
		right: 0,
		zIndex: 5,
		width: 420,
		maxHeight: 280,
		margin: "8px 0 0",
		padding: 10,
		overflow: "auto",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised,
		boxShadow: tokens.shadowOverlay,
		listStyle: "none"
	},
	gapItem: {
		display: "grid",
		gap: 3,
		padding: "7px 6px",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder,
		lineHeight: 1.4
	},
	gapCode: { color: tokens.colorTextFaint, overflowWrap: "anywhere" },
	graphless: {
		minHeight: 420,
		display: "grid",
		placeContent: "center",
		justifyItems: "center",
		marginTop: 14,
		padding: 32,
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceInset,
		textAlign: "center"
	},
	graphlessMark: {
		width: 48,
		height: 48,
		display: "grid",
		placeItems: "center",
		marginBottom: 14,
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorderStrong,
		borderRadius: "50%",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 18
	},
	graphlessPath: {
		maxWidth: 640,
		marginTop: 10,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		overflowWrap: "anywhere"
	},
	graphTabs: {
		display: "flex",
		alignItems: "end",
		gap: 3,
		minWidth: 0,
		minHeight: 34,
		marginTop: 14,
		overflowX: "auto"
	},
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
		fontSize: 11,
		flex: "0 1 auto",
		minWidth: 0,
		maxWidth: 260
	},
	graphTabName: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	graphTabActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		borderTopColor: tokens.colorAccent
	},
	zoomControls: {
		position: "sticky",
		right: 0,
		zIndex: 2,
		marginLeft: "auto",
		display: "flex",
		alignItems: "center",
		gap: 2,
		paddingLeft: 10,
		backgroundColor: tokens.colorCanvas
	},
	panHint: {
		marginRight: 6,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		whiteSpace: "nowrap",
		display: { default: "inline", "@media (max-width: 1180px)": "none" }
	},
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
		height: "calc(100vh - 375px)",
		minHeight: 500,
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 330px",
			"@media (max-width: 1180px)": "minmax(0, 1fr) 280px"
		},
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
		outlineWidth: { default: 0, ":focus-visible": 1 },
		outlineStyle: "solid",
		outlineColor: tokens.colorAccent,
		outlineOffset: -2,
		cursor: "grab",
		touchAction: "none",
		backgroundColor: "#0a0c0f",
		backgroundImage:
			"linear-gradient(rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.08) 1px, transparent 1px), linear-gradient(rgba(103,113,126,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(103,113,126,.035) 1px, transparent 1px)",
		backgroundSize: "80px 80px, 80px 80px, 16px 16px, 16px 16px"
	},
	viewportPanning: { cursor: "grabbing", userSelect: "none" },
	canvas: { position: "relative", transformOrigin: "top left" },
	wires: {
		position: "absolute",
		inset: 0,
		overflow: "visible",
		pointerEvents: "none",
		fill: "none"
	},
	wire: {
		strokeWidth: 2,
		strokeLinecap: "round",
		opacity: 0.8,
		vectorEffect: "non-scaling-stroke",
		transitionProperty: "opacity, stroke-width",
		transitionDuration: tokens.motionFast
	},
	wireMuted: { opacity: 0.18 },
	wireSelected: { opacity: 1, strokeWidth: 3 },
	wireBoolean: { stroke: "#ef6a67", borderColor: "#ef6a67", backgroundColor: "#3a1819" },
	wireExec: { stroke: "#d8e0e8", borderColor: "#d8e0e8", backgroundColor: "#273039" },
	wireNumeric: { stroke: "#80d9ad", borderColor: "#80d9ad", backgroundColor: "#193228" },
	wireObject: { stroke: "#5bc0eb", borderColor: "#5bc0eb", backgroundColor: "#172f3a" },
	wireStruct: { stroke: "#f0b35b", borderColor: "#f0b35b", backgroundColor: "#382917" },
	wireText: { stroke: "#d78ce8", borderColor: "#d78ce8", backgroundColor: "#321c38" },
	wireWildcard: { stroke: "#8a919c", borderColor: "#8a919c", backgroundColor: "#24272c" },
	pinBoolean: { stroke: "#ef6a67", borderColor: "#ef6a67", backgroundColor: "#3a1819" },
	pinExec: { stroke: "#d8e0e8", borderColor: "#d8e0e8", backgroundColor: "#273039" },
	pinNumeric: { stroke: "#80d9ad", borderColor: "#80d9ad", backgroundColor: "#193228" },
	pinObject: { stroke: "#5bc0eb", borderColor: "#5bc0eb", backgroundColor: "#172f3a" },
	pinStruct: { stroke: "#f0b35b", borderColor: "#f0b35b", backgroundColor: "#382917" },
	pinText: { stroke: "#d78ce8", borderColor: "#d78ce8", backgroundColor: "#321c38" },
	pinWildcard: { stroke: "#8a919c", borderColor: "#8a919c", backgroundColor: "#24272c" },
	emptyGraphCanvas: {
		position: "absolute",
		left: GRAPH_MARGIN,
		top: GRAPH_MARGIN,
		display: "grid",
		gap: 5,
		padding: "12px 14px",
		borderWidth: 1,
		borderStyle: "dashed",
		borderColor: tokens.colorBorderStrong,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		fontSize: 11
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
	nodeTitle: {
		display: "block",
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
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
	pinSide: {
		minWidth: 0,
		display: "flex",
		alignItems: "center",
		gap: 6,
		overflow: "hidden",
		whiteSpace: "nowrap"
	},
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
	inspectorTitle: {
		margin: "10px 0 0",
		color: tokens.colorTextStrong,
		fontSize: 17,
		lineHeight: 1.25,
		overflowWrap: "anywhere"
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
	inspectorEmpty: {
		margin: 0,
		padding: "10px 0",
		color: tokens.colorTextFaint,
		fontSize: 10
	},
	pinEvidenceList: { display: "grid", gap: 7, paddingTop: 8 },
	pinEvidence: {
		minWidth: 0,
		display: "grid",
		gap: 6,
		padding: "9px 10px",
		borderWidth: 1,
		borderStyle: "solid",
		borderColor: tokens.colorBorder,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset
	},
	pinEvidenceHeader: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "auto minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 7,
		color: tokens.colorTextStrong,
		fontSize: 11
	},
	pinEvidenceDot: {
		width: 8,
		height: 8,
		borderWidth: 1,
		borderStyle: "solid",
		borderRadius: "50%"
	},
	pinType: {
		minWidth: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		overflowWrap: "anywhere"
	},
	pinMeta: {
		display: "flex",
		flexWrap: "wrap",
		gap: 4,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 8,
		textTransform: "uppercase"
	},
	pinDefaults: { display: "grid", gap: 4, margin: 0 },
	pinDefaultRow: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "88px minmax(0, 1fr)",
		gap: 7,
		fontSize: 9
	},
	pinDefaultLabel: { color: tokens.colorTextFaint },
	pinDefaultValue: {
		minWidth: 0,
		margin: 0,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	noDefault: { color: tokens.colorTextFaint, fontSize: 9 },
	pinTooltip: {
		margin: 0,
		paddingTop: 5,
		borderTopWidth: 1,
		borderTopStyle: "solid",
		borderTopColor: tokens.colorBorder,
		color: tokens.colorTextMuted,
		fontSize: 9,
		lineHeight: 1.4
	},
	properties: { display: "grid" },
	property: {
		minWidth: 0,
		padding: "9px 0",
		borderBottomWidth: 1,
		borderBottomStyle: "solid",
		borderBottomColor: tokens.colorBorder
	},
	propertySummary: {
		minWidth: 0,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		gap: 6,
		color: tokens.colorText,
		cursor: "pointer",
		fontSize: 10
	},
	propertyValue: {
		display: "block",
		maxHeight: 120,
		marginTop: 7,
		overflow: "auto",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 9,
		lineHeight: 1.45,
		overflowWrap: "anywhere"
	}
});

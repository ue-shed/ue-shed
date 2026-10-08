import {
	blueprintClassLabel as shortClass,
	blueprintPinDefaults as pinDefaults,
	blueprintPinLabel as pinLabel,
	blueprintPinTypeLabel as pinTypeLabel,
	isBlueprintTopologyGap as isTopologyGap,
	searchBlueprint,
	type BlueprintSearchHit
} from "@ue-shed/blueprints";
import * as stylex from "@stylexjs/stylex";
import type {
	BlueprintGraphCoverageGap,
	BlueprintGraphProjection,
	BlueprintDefinition,
	SavedProperty,
	SavedPropertyValue,
	BlueprintNode,
	BlueprintPin
} from "@ue-shed/protocol";
import { createEffectAction } from "@ue-shed/ui";
import { styles } from "./blueprint-graph-styles.js";
import { PinGlyph } from "./blueprint-graph-node.js";
import { BlueprintGraphFlowCanvas } from "./blueprint-graph-flow-canvas.js";
import type { Effect } from "effect";
import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { BlueprintGraphReadResult } from "./contract.js";
import type { BlueprintGraphFailureReason } from "./contract.js";

const GRAPH_SEARCH_LIMIT = 20;

type FailedResult = Extract<BlueprintGraphReadResult, { readonly status: "failed" }>;
type InspectorView = "blueprint" | "node";

export type BlueprintGraphReadEffect = Effect.Effect<BlueprintGraphReadResult, unknown>;
export type ReadyBlueprintGraphRead = Extract<
	BlueprintGraphReadResult,
	{ readonly status: "ready" }
>;

export interface BlueprintGraphOpenerControls {
	readonly open: (read: BlueprintGraphReadEffect) => void;
	readonly loading: boolean;
	readonly hasBlueprint: boolean;
	readonly observeSourceBusy: (read: () => boolean) => void;
}

export interface BlueprintGraphFooterControls {
	readonly open: (read: BlueprintGraphReadEffect) => void;
	readonly reveal: (objectPath: string) => void;
}

export interface BlueprintGraphTransportFailureCopy {
	readonly title: string;
	readonly message: string;
	readonly recovery: string;
}

export interface BlueprintGraphViewerProps {
	readonly opener: (controls: BlueprintGraphOpenerControls) => JSX.Element;
	readonly initialRead?: BlueprintGraphReadEffect | undefined;
	readonly failureActions?: (failure: FailedResult) => JSX.Element;
	readonly footer?: (
		read: ReadyBlueprintGraphRead,
		controls: BlueprintGraphFooterControls
	) => JSX.Element;
	readonly transportFailureCopy?: BlueprintGraphTransportFailureCopy;
}

function plural(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function gapLabel(reason: BlueprintGraphCoverageGap["reason"]): string {
	return reason.replaceAll("_", " ");
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
	// Materialize the one-shot JSX prop during setup, before entering the effect scope.
	const initialRead = props.initialRead;
	const openAction = createEffectAction();
	const [graphQuery, setGraphQuery] = createSignal("");
	const [graphSearchOpen, setGraphSearchOpen] = createSignal(false);
	let readSourceBusy: () => boolean = () => false;
	const [loading, setLoading] = createSignal(false);
	const [transportFailure, setTransportFailure] = createSignal(false);
	const [result, setResult] = createSignal<BlueprintGraphReadResult>();
	const [graphIndex, setGraphIndex] = createSignal(0);
	const [selectedNodePath, setSelectedNodePath] = createSignal<string>();
	const [inspectorView, setInspectorView] = createSignal<InspectorView>("node");

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
	const graphSearch = createMemo(() => {
		const value = blueprint();
		return value === undefined
			? { hits: [], truncated: false }
			: searchBlueprint({ blueprint: value, query: graphQuery() });
	});
	const searchContext = createMemo(() => {
		const context = new Map<string, string>();
		for (const item of blueprint()?.graphs ?? []) {
			context.set(item.object_path, item.name);
			for (const node of item.nodes) context.set(node.object_path, node.title);
		}
		return context;
	});
	const selectedNode = createMemo(() => {
		const path = selectedNodePath();
		return path === undefined
			? undefined
			: graph()?.nodes.find((node) => node.object_path === path);
	});
	const nodeCount = createMemo(
		() => blueprint()?.graphs.reduce((count, item) => count + item.nodes.length, 0) ?? 0
	);
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
	const selectNode = (path: string | undefined) => {
		setSelectedNodePath(path);
		if (path !== undefined) setInspectorView("node");
	};

	const accept = (next: BlueprintGraphReadResult) => {
		setLoading(false);
		if (next.status === "cancelled") return;
		setResult(next);
		if (next.status === "ready") {
			const firstNode = next.blueprint.graphs[0]?.nodes[0]?.object_path;
			setGraphIndex(0);
			setGraphQuery("");
			setSelectedNodePath(firstNode);
			setInspectorView(firstNode === undefined ? "blueprint" : "node");
		}
	};
	const run = (effect: BlueprintGraphReadEffect) => {
		setLoading(true);
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
	const closeWhenFocusLeaves =
		(close: () => void) => (event: FocusEvent & { readonly currentTarget: HTMLElement }) => {
			if (!(event.relatedTarget instanceof Node)) return close();
			if (!event.currentTarget.contains(event.relatedTarget)) close();
		};
	const chooseGraph = (index: number) => {
		setGraphIndex(index);
		setSelectedNodePath(blueprint()?.graphs[index]?.nodes[0]?.object_path);
	};
	const chooseSearchHit = (hit: BlueprintSearchHit) => {
		const index = blueprint()?.graphs.findIndex(
			(item) => item.object_path === hit.graphObjectPath
		);
		if (index === undefined || index < 0) return;
		chooseGraph(index);
		selectNode(hit.nodeObjectPath);
		setGraphSearchOpen(false);
	};

	onSettled(() => {
		if (initialRead !== undefined) run(initialRead);
	});

	// Create the opener once so its search state and request lifetime survive placement changes.
	const opener = props.opener({
		open: run,
		get loading() {
			return loading();
		},
		get hasBlueprint() {
			return blueprint() !== undefined;
		},
		observeSourceBusy: (read) => {
			// Setup-only wiring: capture the source accessor without writing reactive state.
			readSourceBusy = read;
		}
	});
	const sourceBusy = createMemo(() => readSourceBusy());
	const footerControls: BlueprintGraphFooterControls = {
		open: run,
		reveal: (target) => {
			const index = blueprint()?.graphs.findIndex(
				(item) =>
					item.object_path === target ||
					item.nodes.some((node) => node.object_path === target)
			);
			if (index !== undefined && index >= 0) {
				setGraphIndex(index);
				selectNode(target);
			}
		}
	};

	return (
		<main
			aria-busy={loading() || sourceBusy() ? "true" : "false"}
			{...stylex.attrs(styles.route)}
		>
			<header {...stylex.attrs(styles.header)}>
				<div {...stylex.attrs(styles.titleBlock)}>
					<h1 {...stylex.attrs(styles.title)}>Blueprint Graphs</h1>
					<p {...stylex.attrs(styles.intro)}>
						Inspect graphs exactly as saved in an uncooked .uasset, decoded from package
						bytes without an editor, asset load, or compile.
					</p>
				</div>
				<span {...stylex.attrs(styles.scopeStamp)}>Read-only · no Unreal required</span>
			</header>

			<Show when={transportFailure()}>
				<FailureNotice
					message={
						props.transportFailureCopy?.message ??
						"The saved package read request could not be completed."
					}
					recovery={
						props.transportFailureCopy?.recovery ??
						"Retry the read request. Unreal is not required."
					}
					title={
						props.transportFailureCopy?.title ?? "The saved package read request failed"
					}
				/>
			</Show>
			<Show when={failure()}>
				{(value) => (
					<FailureNotice failure={value()} actions={props.failureActions?.(value())} />
				)}
			</Show>
			<Show when={loading()}>
				<div aria-live="polite" role="status" {...stylex.attrs(styles.notice)}>
					<span {...stylex.attrs(styles.spinner)} />
					<strong>Reading saved package</strong>
					<span {...stylex.attrs(styles.noticeDetail)}>
						Decoding locally. No editor session will be started.
					</span>
				</div>
			</Show>
			<Show when={blueprint()} fallback={<Show when={!loading()}>{opener}</Show>}>
				{(projection) => (
					<>
						<section aria-label="Blueprint summary" {...stylex.attrs(styles.summary)}>
							<div {...stylex.attrs(styles.identity)}>
								<h2
									title={projection().object_path}
									{...stylex.attrs(styles.assetTitle)}
								>
									{projection().object_path.split(".").at(-1)}
								</h2>
								<span {...stylex.attrs(styles.assetMeta)}>
									<code {...stylex.attrs(styles.assetPackage)}>
										{projection().object_path.split(".")[0]}
									</code>
									<Show when={projection().definition.parent_class}>
										{(parent) => (
											<span title={parent()}>
												extends {shortClass(parent())}
											</span>
										)}
									</Show>
								</span>
							</div>
							{opener}
							<div {...stylex.attrs(styles.metrics)}>
								<Metric noun="graph" value={projection().graphs.length} />
								<Metric noun="node" value={nodeCount()} />
								<Metric noun="pin" value={pinCount()} />
								<Metric noun="link" value={linkCount()} />
							</div>
							<CoverageChip
								complete={
									ready()?.outcome === "complete" &&
									projection().coverage_gaps.length === 0
								}
								topologyComplete={topologyGaps().length === 0}
							/>
						</section>

						<ProjectionCoverage
							diagnostics={ready()?.diagnostics ?? []}
							gaps={projection().coverage_gaps}
							metadataGaps={metadataGaps()}
							outcome={ready()?.outcome ?? "complete"}
							topologyGaps={topologyGaps()}
						/>

						<section
							aria-label="Saved Blueprint graph"
							{...stylex.attrs(styles.workspace)}
						>
							<div {...stylex.attrs(styles.toolbar)}>
								<Show
									when={projection().graphs.length > 0}
									fallback={
										<span {...stylex.attrs(styles.toolbarNote)}>
											No saved graphs
										</span>
									}
								>
									<div
										aria-label="Saved graphs"
										role="tablist"
										{...stylex.attrs(styles.tabs)}
									>
										<For each={projection().graphs}>
											{(item, index) => (
												<button
													aria-label={`${item.name}, ${plural(item.nodes.length, "node")}`}
													aria-selected={
														graphIndex() === index() ? "true" : "false"
													}
													onClick={() => chooseGraph(index())}
													role="tab"
													type="button"
													{...stylex.attrs(
														styles.tab,
														graphIndex() === index() && styles.tabActive
													)}
												>
													<span
														title={item.name}
														{...stylex.attrs(styles.tabName)}
													>
														{item.name}
													</span>
													<span {...stylex.attrs(styles.tabCount)}>
														{item.nodes.length}
													</span>
												</button>
											)}
										</For>
									</div>
									<div
										aria-label="Graph search"
										onFocusOut={closeWhenFocusLeaves(() =>
											setGraphSearchOpen(false)
										)}
										role="search"
										{...stylex.attrs(styles.graphSearch)}
									>
										<label {...stylex.attrs(styles.graphSearchField)}>
											<span
												aria-hidden="true"
												{...stylex.attrs(styles.searchGlyph)}
											>
												⌕
											</span>
											<input
												aria-label="Search saved nodes and pins"
												onFocus={() => setGraphSearchOpen(true)}
												onInput={(event) => {
													setGraphQuery(event.currentTarget.value);
													setGraphSearchOpen(true);
												}}
												onKeyDown={(event) => {
													if (event.key !== "Escape") return;
													event.preventDefault();
													if (graphSearchOpen())
														setGraphSearchOpen(false);
													else setGraphQuery("");
												}}
												placeholder="Find a node or pin"
												spellcheck={false}
												type="search"
												value={graphQuery()}
												{...stylex.attrs(styles.graphSearchInput)}
											/>
										</label>
										<Show
											when={graphSearchOpen() && graphQuery().trim() !== ""}
										>
											<div {...stylex.attrs(styles.graphSearchMenu)}>
												<Show
													when={graphSearch().hits.length > 0}
													fallback={
														<p {...stylex.attrs(styles.menuNote)}>
															No saved nodes or pins match.
														</p>
													}
												>
													<ul
														aria-label="Graph search results"
														{...stylex.attrs(styles.hitList)}
													>
														<For
															each={graphSearch().hits.slice(
																0,
																GRAPH_SEARCH_LIMIT
															)}
														>
															{(hit) => (
																<li>
																	<button
																		aria-label={`${hit.kind} · ${hit.label}`}
																		onClick={() =>
																			chooseSearchHit(hit)
																		}
																		type="button"
																		{...stylex.attrs(
																			styles.hit
																		)}
																	>
																		<span
																			{...stylex.attrs(
																				styles.hitKind
																			)}
																		>
																			{hit.kind}
																		</span>
																		<span
																			{...stylex.attrs(
																				styles.hitLabel
																			)}
																		>
																			{hit.label}
																		</span>
																		<span
																			{...stylex.attrs(
																				styles.hitContext
																			)}
																		>
																			{searchContext().get(
																				hit.kind === "pin"
																					? hit.nodeObjectPath
																					: hit.graphObjectPath
																			)}
																		</span>
																	</button>
																</li>
															)}
														</For>
													</ul>
												</Show>
												<Show
													when={
														graphSearch().hits.length >
															GRAPH_SEARCH_LIMIT ||
														graphSearch().truncated
													}
												>
													<p {...stylex.attrs(styles.menuNote)}>
														Showing the first {GRAPH_SEARCH_LIMIT}{" "}
														matches. Refine the search to find more.
													</p>
												</Show>
											</div>
										</Show>
									</div>
								</Show>
							</div>

							<div {...stylex.attrs(styles.workspaceBody)}>
								<div {...stylex.attrs(styles.canvasFrame)}>
									<Show
										when={projection().graphs.length > 0}
										fallback={
											<GraphlessBlueprint
												objectPath={projection().object_path}
											/>
										}
									>
										<Show when={graph()} keyed>
											{(selectedGraph) => (
												<BlueprintGraphFlowCanvas
													graph={selectedGraph}
													onSelect={selectNode}
													selectedNodePath={selectedNodePath()}
												/>
											)}
										</Show>
									</Show>
								</div>

								<aside aria-label="Inspector" {...stylex.attrs(styles.inspector)}>
									<div
										aria-label="Inspector views"
										role="tablist"
										{...stylex.attrs(styles.tabs, styles.inspectorTabs)}
									>
										<button
											aria-selected={
												inspectorView() === "node" ? "true" : "false"
											}
											onClick={() => setInspectorView("node")}
											role="tab"
											type="button"
											{...stylex.attrs(
												styles.tab,
												inspectorView() === "node" && styles.tabActive
											)}
										>
											Node
										</button>
										<button
											aria-selected={
												inspectorView() === "blueprint" ? "true" : "false"
											}
											onClick={() => setInspectorView("blueprint")}
											role="tab"
											type="button"
											{...stylex.attrs(
												styles.tab,
												inspectorView() === "blueprint" && styles.tabActive
											)}
										>
											Blueprint
										</button>
									</div>
									<div {...stylex.attrs(styles.inspectorBody)}>
										<Show
											when={inspectorView() === "node"}
											fallback={
												<DefinitionInspector
													definition={projection().definition}
												/>
											}
										>
											<Show
												when={selectedNode()}
												fallback={
													<p {...stylex.attrs(styles.emptyNote)}>
														Select a node on the canvas to inspect its
														saved pins and properties.
													</p>
												}
											>
												{(node) => <NodeInspector node={node()} />}
											</Show>
										</Show>
									</div>
								</aside>
							</div>
						</section>
					</>
				)}
			</Show>
			<Show when={ready()}>{(read) => props.footer?.(read(), footerControls)}</Show>
		</main>
	);
}

function Metric(props: { readonly noun: string; readonly value: number }) {
	return (
		<span {...stylex.attrs(styles.metric)}>
			<strong {...stylex.attrs(styles.metricValue)}>{props.value.toLocaleString()}</strong>
			<span {...stylex.attrs(styles.metricLabel)}>
				{props.value === 1 ? props.noun : props.noun + "s"}
			</span>
		</span>
	);
}

function CoverageChip(props: { readonly complete: boolean; readonly topologyComplete: boolean }) {
	return (
		<span
			title={
				props.complete
					? "Graph membership, nodes, pins, and links were projected without a recorded coverage gap."
					: "Some saved evidence was not fully decoded. See the coverage notes below."
			}
			{...stylex.attrs(styles.coverageChip, !props.complete && styles.coverageChipPartial)}
		>
			<i
				{...stylex.attrs(
					styles.coverageDot,
					props.complete ? styles.coverageDotReady : styles.coverageDotGap
				)}
			/>
			{props.complete
				? "Fully decoded"
				: props.topologyComplete
					? "Topology complete"
					: "Topology partial"}
		</span>
	);
}

function FailureNotice(
	props: { readonly actions?: JSX.Element } & (
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
	)
) {
	const title = () =>
		props.failure === undefined ? props.title : failureTitle(props.failure.reason);
	const message = () => (props.failure === undefined ? props.message : props.failure.message);
	const recovery = () => (props.failure === undefined ? props.recovery : props.failure.recovery);
	return (
		<section aria-label={title()} role="alert" {...stylex.attrs(styles.callout, styles.danger)}>
			<span {...stylex.attrs(styles.calloutMark, styles.dangerMark)}>!</span>
			<div {...stylex.attrs(styles.calloutCopy)}>
				<strong {...stylex.attrs(styles.calloutTitle)}>{title()}</strong>
				<p {...stylex.attrs(styles.calloutText)}>{message()}</p>
				<p {...stylex.attrs(styles.calloutText)}>{recovery()}</p>
				<Show when={props.failure?.assetPath}>
					{(path) => <code {...stylex.attrs(styles.calloutCode)}>{path()}</code>}
				</Show>
				{props.actions}
			</div>
		</section>
	);
}

function ProjectionCoverage(props: {
	readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
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
		<Show when={!complete()}>
			<section
				aria-label="Projection coverage"
				{...stylex.attrs(styles.callout, styles.warning)}
			>
				<span {...stylex.attrs(styles.calloutMark, styles.warningMark)}>!</span>
				<div {...stylex.attrs(styles.calloutCopy)}>
					<strong {...stylex.attrs(styles.calloutTitle)}>
						{metadataOnly()
							? "Topology complete; specialized metadata partial"
							: decodeOnly()
								? "Topology complete; projection partial"
								: "Partial saved-graph projection"}
					</strong>
					<p {...stylex.attrs(styles.calloutText)}>
						{metadataOnly()
							? "Native subclass tails or tagged properties remain opaque. This does not mean graph links are missing."
							: decodeOnly()
								? "The reader reported a partial native decode, but no topology coverage gap was recorded."
								: "One or more saved graph references could not be resolved. Shown links are evidence, but topology may be incomplete."}
					</p>
					<Show when={props.outcome === "partial" && props.diagnostics.length > 0}>
						<ul
							aria-label="Blueprint decode diagnostics"
							{...stylex.attrs(styles.detailList)}
						>
							<For each={props.diagnostics}>
								{(diagnostic) => (
									<li>
										<code {...stylex.attrs(styles.diagnosticCode)}>
											{diagnostic.code}
										</code>{" "}
										{diagnostic.message}
									</li>
								)}
							</For>
						</ul>
					</Show>
					<Show when={props.gaps.length > 0}>
						<details {...stylex.attrs(styles.gapDetails)}>
							<summary {...stylex.attrs(styles.gapSummary)}>
								{plural(props.gaps.length, "coverage gap")}
							</summary>
							<ul {...stylex.attrs(styles.detailList)}>
								<For each={props.gaps}>
									{(gap) => (
										<li {...stylex.attrs(styles.gapItem)}>
											<strong>{gapLabel(gap.reason)}</strong>
											<span>{gap.detail}</span>
											<code {...stylex.attrs(styles.calloutCode)}>
												{gap.object_path}
											</code>
										</li>
									)}
								</For>
							</ul>
						</details>
					</Show>
				</div>
			</section>
		</Show>
	);
}

function GraphlessBlueprint(props: { readonly objectPath: string }) {
	return (
		<section aria-label="Graphless Blueprint" {...stylex.attrs(styles.emptyState)}>
			<h2 {...stylex.attrs(styles.emptyTitle)}>No saved editor graphs</h2>
			<p {...stylex.attrs(styles.emptyText)}>
				The package was read successfully, but its Blueprint saved no editor graph exports.
				This is a valid graphless result, not a reader failure. Its class definition is in
				the Blueprint tab.
			</p>
			<code {...stylex.attrs(styles.calloutCode)}>{props.objectPath}</code>
		</section>
	);
}

function SectionHeading(props: { readonly count?: number | undefined; readonly label: string }) {
	return (
		<h3 {...stylex.attrs(styles.sectionHeading)}>
			<span>{props.label}</span>
			<Show when={props.count !== undefined}>
				<span {...stylex.attrs(styles.sectionCount)}>{props.count}</span>
			</Show>
		</h3>
	);
}

function Fact(props: {
	readonly label: string;
	readonly mono?: boolean | undefined;
	readonly value: string;
}) {
	return (
		<div {...stylex.attrs(styles.fact)}>
			<dt {...stylex.attrs(styles.factLabel)}>{props.label}</dt>
			<dd {...stylex.attrs(styles.factValue, props.mono === true && styles.mono)}>
				{props.value}
			</dd>
		</div>
	);
}

function PinEvidence(props: { readonly pin: BlueprintPin }) {
	const defaults = () => pinDefaults(props.pin);
	const links = () => props.pin.linked_to.length;
	return (
		<li {...stylex.attrs(styles.pinEvidence)}>
			<div {...stylex.attrs(styles.pinEvidenceHeader)}>
				<PinGlyph pin={props.pin} />
				<strong title={pinLabel(props.pin)} {...stylex.attrs(styles.pinEvidenceName)}>
					{pinLabel(props.pin)}
				</strong>
				<span {...stylex.attrs(styles.pinDirection)}>
					{props.pin.direction === "input" ? "in" : "out"}
				</span>
			</div>
			<div {...stylex.attrs(styles.pinEvidenceMeta)}>
				<code {...stylex.attrs(styles.pinType)}>{pinTypeLabel(props.pin)}</code>
				<Show when={links() > 0}>
					<span>{plural(links(), "link")}</span>
				</Show>
				<Show when={props.pin.sub_pins.length > 0}>
					<span>{plural(props.pin.sub_pins.length, "sub-pin")}</span>
				</Show>
				<Show when={props.pin.parent_pin !== undefined}>
					<span>child pin</span>
				</Show>
			</div>
			<Show when={defaults().length > 0}>
				<dl {...stylex.attrs(styles.pinDefaults)}>
					<For each={defaults()}>
						{(value) => (
							<div {...stylex.attrs(styles.pinDefaultRow)}>
								<dt {...stylex.attrs(styles.factLabel)}>{value.label}</dt>
								<dd title={value.value} {...stylex.attrs(styles.pinDefaultValue)}>
									{value.value}
								</dd>
							</div>
						)}
					</For>
				</dl>
			</Show>
			<Show when={props.pin.tooltip !== ""}>
				<p {...stylex.attrs(styles.pinTooltip)}>{props.pin.tooltip}</p>
			</Show>
		</li>
	);
}

function SavedProperties(props: { readonly properties: readonly SavedProperty[] }) {
	return (
		<div {...stylex.attrs(styles.properties)}>
			<For
				each={props.properties.slice(0, 200)}
				fallback={<p {...stylex.attrs(styles.emptyNote)}>No tagged properties.</p>}
			>
				{(property) => (
					<details {...stylex.attrs(styles.property)}>
						<summary {...stylex.attrs(styles.propertySummary)}>
							<span title={property.name} {...stylex.attrs(styles.propertyName)}>
								{property.name}
							</span>
							<small {...stylex.attrs(styles.propertyType)}>{property.type}</small>
						</summary>
						<code {...stylex.attrs(styles.codeBlock)}>{JSON.stringify(property)}</code>
					</details>
				)}
			</For>
			<Show when={props.properties.length > 200}>
				<p {...stylex.attrs(styles.emptyNote)}>
					Showing the first 200 properties. Use the CLI for all saved properties.
				</p>
			</Show>
		</div>
	);
}

function SavedNativeData(props: { readonly value: SavedPropertyValue | undefined }) {
	const serialized = createMemo(() => (props.value ? JSON.stringify(props.value) : ""));
	return (
		<Show when={props.value !== undefined}>
			<details {...stylex.attrs(styles.property)}>
				<summary {...stylex.attrs(styles.propertySummary)}>Saved native data</summary>
				<code {...stylex.attrs(styles.codeBlock)}>{serialized().slice(0, 20000)}</code>
				<Show when={serialized().length > 20000}>
					<p {...stylex.attrs(styles.emptyNote)}>
						Showing the first 20,000 characters. Use the CLI for the complete record.
					</p>
				</Show>
			</details>
		</Show>
	);
}

function DefinitionInspector(props: { readonly definition: BlueprintDefinition }) {
	const nodeNames = createMemo(
		() =>
			new Map(
				props.definition.construction_script?.nodes.map((node) => [
					node.object_path,
					node.variable_name ?? node.object_path
				])
			)
	);
	const nodeName = (path: string) => nodeNames().get(path) ?? path;

	return (
		<section aria-label="Blueprint definition" {...stylex.attrs(styles.inspectorContent)}>
			<dl {...stylex.attrs(styles.facts)}>
				<Fact
					label="Parent class"
					mono
					value={props.definition.parent_class ?? "not serialized"}
				/>
			</dl>

			<SectionHeading count={props.definition.variables?.length} label="Variables" />
			<Show
				when={props.definition.variables !== null}
				fallback={
					<p {...stylex.attrs(styles.emptyNote)}>
						Variable declarations were not serialized or are unavailable.
					</p>
				}
			>
				<For
					each={props.definition.variables?.slice(0, 200)}
					fallback={<p {...stylex.attrs(styles.emptyNote)}>No variables declared.</p>}
				>
					{(variable) => (
						<details {...stylex.attrs(styles.entry)}>
							<summary {...stylex.attrs(styles.entrySummary)}>
								{variable.name ?? "unnamed variable"}
								<small {...stylex.attrs(styles.entryMeta)}>
									{` · ${variable.pin_type?.category ?? "type unavailable"} · ${variable.pin_type?.container_type ?? "unknown"}`}
								</small>
							</summary>
							<div {...stylex.attrs(styles.entryBody)}>
								<dl {...stylex.attrs(styles.facts)}>
									<Fact
										label="Category"
										value={variable.category?.source ?? "not serialized"}
									/>
									<Fact
										label="Flags"
										mono
										value={String(variable.property_flags ?? "not serialized")}
									/>
									<Fact
										label="Default"
										mono
										value={
											variable.default_value === null
												? "not serialized"
												: JSON.stringify(variable.default_value)
										}
									/>
								</dl>
								<SavedProperties properties={variable.properties} />
							</div>
						</details>
					)}
				</For>
				<Show when={(props.definition.variables?.length ?? 0) > 200}>
					<p {...stylex.attrs(styles.emptyNote)}>
						Showing the first 200 variables. Use the CLI for all variables.
					</p>
				</Show>
			</Show>

			<Show
				when={props.definition.default_object}
				fallback={
					<>
						<SectionHeading label="Class defaults" />
						<p {...stylex.attrs(styles.emptyNote)}>
							Saved class default object unavailable.
						</p>
					</>
				}
			>
				{(object) => (
					<>
						<SectionHeading count={object().properties.length} label="Class defaults" />
						<code title={object().object_path} {...stylex.attrs(styles.objectPath)}>
							{object().object_path}
						</code>
						<SavedProperties properties={object().properties} />
						<SavedNativeData value={object().native_data} />
					</>
				)}
			</Show>

			<Show
				when={props.definition.construction_script}
				fallback={
					<>
						<SectionHeading label="Components" />
						<p {...stylex.attrs(styles.emptyNote)}>
							Saved construction script unavailable.
						</p>
					</>
				}
			>
				{(scs) => (
					<>
						<SectionHeading count={scs().nodes.length} label="Components" />
						<dl {...stylex.attrs(styles.facts)}>
							<Fact
								label="Root order"
								value={
									scs().root_nodes?.slice(0, 200).map(nodeName).join(" → ") ??
									"not serialized"
								}
							/>
						</dl>
						<For each={scs().nodes.slice(0, 200)}>
							{(node) => (
								<details {...stylex.attrs(styles.entry)}>
									<summary {...stylex.attrs(styles.entrySummary)}>
										{node.variable_name ?? node.object_path}
										<small {...stylex.attrs(styles.entryMeta)}>
											{` · ${node.component_class ?? "class unavailable"}`}
										</small>
									</summary>
									<div {...stylex.attrs(styles.entryBody)}>
										<dl {...stylex.attrs(styles.facts)}>
											<Fact
												label="Children"
												value={
													node.children
														?.slice(0, 200)
														.map(nodeName)
														.join(" → ") ?? "not serialized"
												}
											/>
											<Fact
												label="Attach to"
												value={node.attach_to_name ?? "not serialized"}
											/>
											<Fact
												label="Parent"
												value={
													node.parent_component_name ?? "not serialized"
												}
											/>
											<Fact
												label="Owner class"
												value={
													node.parent_owner_class_name ?? "not serialized"
												}
											/>
											<Fact
												label="Native parent"
												value={
													node.parent_is_native === null
														? "not serialized"
														: String(node.parent_is_native)
												}
											/>
										</dl>
										<Show
											when={node.template}
											fallback={
												<p {...stylex.attrs(styles.emptyNote)}>
													Saved component template unavailable.
												</p>
											}
										>
											{(template) => (
												<>
													<code
														title={template().object_path}
														{...stylex.attrs(styles.objectPath)}
													>
														{template().object_path}
													</code>
													<SavedProperties
														properties={template().properties}
													/>
													<SavedNativeData
														value={template().native_data}
													/>
												</>
											)}
										</Show>
									</div>
								</details>
							)}
						</For>
						<Show when={scs().nodes.length > 200}>
							<p {...stylex.attrs(styles.emptyNote)}>
								Showing the first 200 components. Use the CLI for all components.
							</p>
						</Show>
						<Show
							when={
								(scs().root_nodes?.length ?? 0) > 200 ||
								scs().nodes.some((node) => (node.children?.length ?? 0) > 200)
							}
						>
							<p {...stylex.attrs(styles.emptyNote)}>
								Showing up to 200 root or child links per list. Use the CLI for the
								full hierarchy.
							</p>
						</Show>
					</>
				)}
			</Show>
		</section>
	);
}

function NodeInspector(props: { readonly node: BlueprintNode }) {
	const kind = createMemo(() => props.node.kind);
	return (
		<div {...stylex.attrs(styles.inspectorContent)}>
			<div {...stylex.attrs(styles.nodeHeading)}>
				<span
					{...stylex.attrs(
						styles.kindChip,
						kind() === "event" && styles.kindEvent,
						kind() === "function_call" && styles.kindFunction,
						(kind() === "variable_get" || kind() === "variable_set") &&
							styles.kindVariable
					)}
				>
					{kind().replaceAll("_", " ")}
				</span>
				<h2 title={props.node.title} {...stylex.attrs(styles.inspectorTitle)}>
					{props.node.title}
				</h2>
				<code title={props.node.class_path} {...stylex.attrs(styles.objectPath)}>
					{props.node.class_path}
				</code>
			</div>
			<dl {...stylex.attrs(styles.facts)}>
				<Fact
					label="Position"
					mono
					value={`${props.node.position.x}, ${props.node.position.y}`}
				/>
				<Fact label="GUID" mono value={props.node.guid ?? "not serialized"} />
				<Fact
					label="Native tail"
					value={
						props.node.subclass_tail_bytes === 0
							? "none"
							: `${props.node.subclass_tail_bytes} bytes · metadata unavailable`
					}
				/>
			</dl>

			<SectionHeading count={props.node.pins.length} label="Pins" />
			<ul aria-label="Saved pin evidence" {...stylex.attrs(styles.pinEvidenceList)}>
				<For
					each={props.node.pins}
					fallback={<li {...stylex.attrs(styles.emptyNote)}>No pins were serialized.</li>}
				>
					{(pin) => <PinEvidence pin={pin} />}
				</For>
			</ul>

			<SectionHeading count={props.node.properties.length} label="Tagged properties" />
			<SavedProperties properties={props.node.properties} />
		</div>
	);
}

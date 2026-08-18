import * as stylex from "@stylexjs/stylex";
import { MAX_TEXTURE_PREVIEW_BATCH_SIZE } from "@ue-shed/asset-audits/browser";
import type {
	DistributionBucket,
	TextureAuditQueryRunResult,
	TextureAuditQuerySummary,
	TextureAuditRecord,
	TextureAuditSearchPage,
	TextureDistributionSelection,
	TexturePreviewResult,
	TextureRecord
} from "@ue-shed/asset-audits/browser";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Schedule, Stream } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import type { TextureAuditClientApi } from "./texture-audit-client.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: Extract<TextureAuditQueryRunResult, { status: "failed" }>["error"];
	  }
	| {
			readonly status: "ready";
			readonly page: TextureAuditSearchPage;
			readonly summary: TextureAuditQuerySummary;
	  };

type ComparisonKind = TextureAuditRecord["comparisons"][number]["kind"];
type LocateFeedback =
	| { readonly status: "idle" }
	| { readonly objectPath: string; readonly status: "locating" }
	| EditorAssetLocateResult
	| {
			readonly message: string;
			readonly objectPath: string;
			readonly recovery: string;
			readonly status: "failed";
	  };

function locateLabel(feedback: LocateFeedback, objectPath: string): string {
	if (feedback.status === "idle" || feedback.objectPath !== objectPath) return "Locate in Unreal";
	if (feedback.status === "locating") return "Locating…";
	if (feedback.status === "located") return "Located";
	if (feedback.status === "failed") return "Failed";
	if (feedback.reason === "not_connected") return "Unreal offline";
	if (feedback.reason === "capability_missing") return "Plugin needed";
	if (feedback.reason === "asset_not_found") return "Not found";
	return "Unavailable";
}

function shortName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function evidenceLabel(evidence: TextureRecord["compression"] | TextureRecord["sRGB"]): string {
	return evidence.status === "available" ? String(evidence.value) : "Unavailable";
}

function evidenceReason(evidence: TextureRecord["compression"] | TextureRecord["sRGB"]): string {
	return evidence.status === "available"
		? `${evidence.source} evidence`
		: evidence.reason.replaceAll("_", " ");
}

function dimensionsLabel(record: TextureRecord): string {
	return record.dimensions.status === "available"
		? `${record.dimensions.value.width} × ${record.dimensions.value.height}`
		: "Dimensions unavailable";
}

function maximumDimensionLabel(record: TextureRecord): string {
	return record.dimensions.status === "available"
		? `${Math.max(record.dimensions.value.width, record.dimensions.value.height).toLocaleString()} px`
		: "Unavailable";
}

function bytesLabel(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
	return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function comparisonKindLabel(kind: ComparisonKind): string {
	if (kind === "texture_group") return "Texture group";
	if (kind === "folder") return "Folder";
	return "Project";
}

function failure(cause: unknown): Extract<ViewState, { status: "failed" }> {
	return {
		error: {
			code: "contract_failure",
			message: String(cause),
			recovery: "Restart Workbench. If the problem persists, verify package versions.",
			retrySafe: true
		},
		status: "failed"
	};
}

export function savedPreviewBatchPaths(
	page: TextureAuditSearchPage,
	selectedPath?: string
): ReadonlyArray<TextureRecord["objectPath"]> {
	const selected = page.records.find((record) => record.objectPath === selectedPath)?.objectPath;
	const candidates = [
		...(selected ? [selected] : []),
		...page.findings.map((finding) => finding.objectPath),
		...page.records.map((record) => record.objectPath)
	];
	const seen = new Set<string>();
	return candidates
		.filter((objectPath) => {
			if (seen.has(objectPath)) return false;
			seen.add(objectPath);
			return true;
		})
		.slice(0, MAX_TEXTURE_PREVIEW_BATCH_SIZE);
}

function savedPreviewBatchLabel(count: number, loading: boolean): string {
	if (count === 1) return loading ? "Generating saved preview…" : "Generate saved preview";
	return loading ? `Generating ${count} saved previews…` : `Generate ${count} saved previews`;
}

/** Bounded query presentation; full texture records remain in the Workbench main process. */
export function TextureAuditRoute(props: { readonly client: TextureAuditClientApi }) {
	const refreshAction = createEffectAction();
	const searchAction = createEffectAction();
	const detailAction = createEffectAction();
	const previewAction = createEffectAction();
	const offlinePreviewAction = createEffectAction();
	const locateAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [progress, setProgress] = createSignal<TaskProgress>({
		completed: 0,
		phase: "idle",
		stage: "texture_audit",
		total: 0
	});
	const [query, setQuery] = createSignal("");
	const [selection, setSelection] = createSignal<TextureDistributionSelection>();
	const [findingsOnly, setFindingsOnly] = createSignal(false);
	const [selectedPath, setSelectedPath] = createSignal<string>();
	const [record, setRecord] = createSignal<TextureAuditRecord>();
	const [comparisonKind, setComparisonKind] = createSignal<ComparisonKind>("project");
	const [preview, setPreview] = createSignal<TexturePreviewResult>();
	const [savedPreviews, setSavedPreviews] = createSignal<
		ReadonlyMap<string, TexturePreviewResult>
	>(new Map());
	const [offlinePreviewLoading, setOfflinePreviewLoading] = createSignal(false);
	const [locateFeedback, setLocateFeedback] = createSignal<LocateFeedback>({ status: "idle" });
	const activeComparison = createMemo(() => {
		const current = record();
		return (
			current?.comparisons.find((comparison) => comparison.kind === comparisonKind()) ??
			current?.comparisons[0]
		);
	});
	const offlineBatchPaths = () => {
		const current = state();
		return current.status === "ready"
			? savedPreviewBatchPaths(current.page, selectedPath())
			: [];
	};
	const availablePreview = () => {
		const current = preview();
		return current?.status === "available" ? current : undefined;
	};
	const unavailablePreview = () => {
		const current = preview();
		return current?.status === "unavailable" ? current : undefined;
	};
	const locateInProgress = (objectPath: string) => {
		const current = locateFeedback();
		return current.status === "locating" && current.objectPath === objectPath;
	};
	const locateProblem = (objectPath: string) => {
		const current = locateFeedback();
		return current.status !== "idle" &&
			current.objectPath === objectPath &&
			(current.status === "unavailable" || current.status === "failed")
			? current
			: undefined;
	};
	let searchGeneration = 0;

	const requestRecord = (objectPath: string) => {
		setSelectedPath(objectPath);
		setRecord(undefined);
		setPreview(savedPreviews().get(objectPath));
		setOfflinePreviewLoading(false);
		offlinePreviewAction.cancel();
		detailAction.run(props.client.record(objectPath), {
			onFailure: (cause) => setState(failure(cause)),
			onSuccess: (result) => {
				if (result.status !== "found") return setRecord(undefined);
				setRecord(result.record);
				setComparisonKind(result.record.defaultComparison);
			}
		});
		previewAction.run(props.client.loadPreview(objectPath), {
			onFailure: () => setPreview(savedPreviews().get(objectPath)),
			onSuccess: (result) =>
				setPreview(
					result.status === "available"
						? result
						: (savedPreviews().get(objectPath) ?? result)
				)
		});
	};

	const requestOfflinePreview = () => {
		const objectPath = selectedPath();
		if (!objectPath) return;
		const objectPaths = offlineBatchPaths();
		if (objectPaths.length === 0) return;
		setOfflinePreviewLoading(true);
		offlinePreviewAction.run(props.client.loadOfflinePreviews({ objectPaths }), {
			onFailure: () => setOfflinePreviewLoading(false),
			onSuccess: (result) => {
				setOfflinePreviewLoading(false);
				setSavedPreviews((current) => {
					const next = new Map(current);
					for (const item of result.previews) {
						if (item.status === "available") next.set(item.objectPath, item);
					}
					return next;
				});
				const selected = result.previews.find((item) => item.objectPath === objectPath);
				if (selected) setPreview(selected);
			}
		});
	};

	const locateAsset = (objectPath: string) => {
		setLocateFeedback({ objectPath, status: "locating" });
		locateAction.run(props.client.locateAsset(objectPath), {
			onFailure: (cause) =>
				setLocateFeedback({
					message: String(cause),
					objectPath,
					recovery: "Restart Workbench and retry asset navigation.",
					status: "failed"
				}),
			onSuccess: setLocateFeedback
		});
	};

	const requestPage = (cursor?: TextureRecord["objectPath"]) => {
		const generation = ++searchGeneration;
		searchAction.run(
			props.client.search({
				...(cursor === undefined ? undefined : { cursor }),
				findingsOnly: findingsOnly(),
				pageSize: 100,
				query: query(),
				...(selection() === undefined ? undefined : { selection: selection()! })
			}),
			{
				onFailure: (cause) => setState(failure(cause)),
				onSuccess: (result) => {
					if (generation !== searchGeneration || result.status !== "ready") return;
					const current = state();
					if (current.status !== "ready") return;
					setState({ ...current, page: result.page });
					const firstFindingPath = result.page.findings[0]?.objectPath;
					const next =
						result.page.records.find((item) => item.objectPath === selectedPath()) ??
						result.page.records.find((item) => item.objectPath === firstFindingPath) ??
						result.page.records[0];
					if (next) requestRecord(next.objectPath);
					else {
						setSelectedPath(undefined);
						setRecord(undefined);
						setPreview(undefined);
					}
				}
			}
		);
	};

	const applyRefresh = (result: TextureAuditQueryRunResult) => {
		progressSubscription.cancel();
		if (result.status === "completed") {
			setState({
				page: { findings: [], records: [], total: 0 },
				status: "ready",
				summary: result.summary
			});
			setSelectedPath(undefined);
			setRecord(undefined);
			setPreview(undefined);
			setSavedPreviews(new Map());
			requestPage();
		} else if (result.status === "failed") setState({ error: result.error, status: "failed" });
		else setState({ status: result.status });
	};

	const refresh = () => {
		setState({ status: "loading" });
		setProgress({ completed: 0, phase: "idle", stage: "texture_audit", total: 0 });
		progressSubscription.subscribe(
			Stream.fromEffectSchedule(props.client.progress(), Schedule.spaced("100 millis")),
			{ onValue: setProgress }
		);
		refreshAction.run(props.client.loadConfiguredProject(), {
			onFailure: (cause) => {
				progressSubscription.cancel();
				setState(failure(cause));
			},
			onSuccess: applyRefresh
		});
	};

	onMount(refresh);

	return (
		<main {...stylex.props(styles.page)}>
			<TaskProgressModal
				open={state().status === "loading"}
				progress={progress()}
				title="Building the texture audit"
				detail="Workbench is decoding Texture2D packages and evaluating their saved evidence against the active rule set."
			/>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.heading)}>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumb)}>
						Asset audits / Texture audit
					</nav>
					<div {...stylex.props(styles.titleRow)}>
						<h1 {...stylex.props(styles.title)}>Texture investigation</h1>
						<span {...stylex.props(styles.subtitle)}>
							Find an outlier, compare it with its peers, then hand it back to Unreal.
						</span>
					</div>
				</div>
				<button type="button" onClick={refresh} {...stylex.props(styles.rescanButton)}>
					Rescan saved assets
				</button>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.empty)}>Reading Texture2D evidence…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.empty)}>No project configured.</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.empty)}>Project selection cancelled.</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						return current.status === "failed" ? (
							<div {...stylex.props(styles.error)}>{current.error.message}</div>
						) : null;
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					{(() => {
						const current = state();
						if (current.status !== "ready") return null;
						return (
							<div {...stylex.props(styles.bench)}>
								<ScopeRail
									summary={current.summary}
									selection={selection()}
									findingsOnly={findingsOnly()}
									onFindingsOnly={(value) => {
										setFindingsOnly(value);
										requestPage();
									}}
									onSelect={(next) => {
										setSelection(next);
										requestPage();
									}}
								/>
								<section
									aria-label="Texture records"
									{...stylex.props(styles.catalog)}
								>
									<header {...stylex.props(styles.catalogHeader)}>
										<label {...stylex.props(styles.search)}>
											<span aria-hidden="true">⌕</span>
											<input
												aria-label="Search textures"
												value={query()}
												onInput={(event) => {
													setQuery(event.currentTarget.value);
													requestPage();
												}}
												placeholder="Object path…"
												{...stylex.props(styles.searchInput)}
											/>
										</label>
										<span {...stylex.props(styles.resultCount)}>
											{current.page.total.toLocaleString()} shown
										</span>
									</header>
									<div {...stylex.props(styles.columnLabels)}>
										<span>Asset</span>
										<span>Saved evidence</span>
									</div>
									<div {...stylex.props(styles.assetList)}>
										<For each={current.page.records}>
											{(item) => {
												const findingCount = () =>
													current.page.findings.filter(
														(finding) =>
															finding.objectPath === item.objectPath
													).length;
												const cached = () => {
													const result = savedPreviews().get(
														item.objectPath
													);
													return result?.status === "available"
														? result
														: undefined;
												};
												return (
													<button
														type="button"
														aria-pressed={
															selectedPath() === item.objectPath
														}
														onClick={() =>
															requestRecord(item.objectPath)
														}
														{...stylex.props(
															styles.assetRow,
															selectedPath() === item.objectPath &&
																styles.assetRowActive
														)}
													>
														<span {...stylex.props(styles.rowPreview)}>
															<Show
																when={cached()}
																fallback={<span>TX</span>}
															>
																{(image) => (
																	<img
																		src={`data:${image().mimeType};base64,${image().dataBase64}`}
																		alt=""
																		{...stylex.props(
																			styles.rowPreviewImage
																		)}
																	/>
																)}
															</Show>
														</span>
														<span
															{...stylex.props(styles.assetIdentity)}
														>
															<strong
																{...stylex.props(styles.assetName)}
															>
																{shortName(item.objectPath)}
															</strong>
															<small
																title={item.objectPath}
																{...stylex.props(styles.assetPath)}
															>
																{item.objectPath}
															</small>
														</span>
														<span {...stylex.props(styles.rowEvidence)}>
															<strong
																{...stylex.props(
																	styles.rowDimensions
																)}
															>
																{dimensionsLabel(item)}
															</strong>
															<small
																title={evidenceLabel(
																	item.textureGroup
																)}
																{...stylex.props(styles.rowGroup)}
															>
																{evidenceLabel(item.textureGroup)}
															</small>
														</span>
														<span
															{...stylex.props(
																styles.rowStatus,
																findingCount() > 0
																	? styles.rowWarning
																	: styles.rowPass
															)}
														>
															{findingCount() > 0
																? findingCount()
																: "✓"}
														</span>
													</button>
												);
											}}
										</For>
										<Show when={current.page.records.length === 0}>
											<p {...stylex.props(styles.noResults)}>
												No textures match this view.
											</p>
										</Show>
									</div>
									<Show when={current.page.nextCursor}>
										{(cursor) => (
											<button
												type="button"
												onClick={() => requestPage(cursor())}
												{...stylex.props(styles.nextPage)}
											>
												Next 100 textures
											</button>
										)}
									</Show>
								</section>
								<InvestigationPane
									record={record()}
									preview={availablePreview()}
									unavailablePreview={unavailablePreview()}
									offlinePreviewLoading={offlinePreviewLoading()}
									offlineBatchCount={offlineBatchPaths().length}
									comparison={activeComparison()}
									comparisonKind={comparisonKind()}
									locateFeedback={locateFeedback()}
									locateProblem={
										record()
											? locateProblem(record()!.record.objectPath)
											: undefined
									}
									locating={
										record()
											? locateInProgress(record()!.record.objectPath)
											: false
									}
									onComparison={setComparisonKind}
									onGeneratePreview={requestOfflinePreview}
									onLocate={locateAsset}
									onSelectPeer={requestRecord}
								/>
							</div>
						);
					})()}
				</Match>
			</Switch>
		</main>
	);
}

function ScopeRail(props: {
	readonly findingsOnly: boolean;
	readonly onFindingsOnly: (value: boolean) => void;
	readonly onSelect: (selection: TextureDistributionSelection | undefined) => void;
	readonly selection: TextureDistributionSelection | undefined;
	readonly summary: TextureAuditQuerySummary;
}) {
	const facets: ReadonlyArray<
		readonly [string, TextureDistributionSelection["kind"], readonly DistributionBucket[]]
	> = [
		["Maximum dimension", "maximumDimension", props.summary.distributions.maximumDimension],
		["Texture group", "textureGroup", props.summary.distributions.textureGroup],
		["Compression", "compression", props.summary.distributions.compression],
		["Color evidence", "sRGB", props.summary.distributions.sRGB]
	];
	return (
		<aside aria-label="Audit scope and distributions" {...stylex.props(styles.scopeRail)}>
			<section {...stylex.props(styles.auditSummary)}>
				<div {...stylex.props(styles.summaryFinding)}>
					<strong {...stylex.props(styles.summaryCount)}>
						{props.summary.findingCount.toLocaleString()}
					</strong>
					<span {...stylex.props(styles.summaryUnit)}>
						{props.summary.findingCount === 1 ? "finding" : "findings"}
					</span>
				</div>
				<dl {...stylex.props(styles.summaryFacts)}>
					<div {...stylex.props(styles.summaryFact)}>
						<dt {...stylex.props(styles.summaryTerm)}>Textures</dt>
						<dd {...stylex.props(styles.summaryValue)}>
							{props.summary.coverage.textureAssets.toLocaleString()}
						</dd>
					</div>
					<div {...stylex.props(styles.summaryFact)}>
						<dt {...stylex.props(styles.summaryTerm)}>Coverage</dt>
						<dd {...stylex.props(styles.summaryValue)}>
							{props.summary.status === "complete" ? "Complete" : "Partial"}
						</dd>
					</div>
					<div {...stylex.props(styles.summaryFact)}>
						<dt {...stylex.props(styles.summaryTerm)}>Diagnostics</dt>
						<dd {...stylex.props(styles.summaryValue)}>
							{props.summary.diagnosticCount.toLocaleString()}
						</dd>
					</div>
				</dl>
				<small {...stylex.props(styles.ruleSetName)} title={props.summary.ruleSetName}>
					Rules: {props.summary.ruleSetName}
				</small>
			</section>
			<button
				type="button"
				aria-pressed={props.findingsOnly}
				onClick={() => props.onFindingsOnly(!props.findingsOnly)}
				{...stylex.props(styles.findingsFilter, props.findingsOnly && styles.filterActive)}
			>
				<span>Findings only</span>
				<b>{props.summary.findingCount}</b>
			</button>
			<div {...stylex.props(styles.facetList)}>
				<For each={facets}>
					{([label, kind, buckets]) => {
						const maximum = Math.max(1, ...buckets.map((bucket) => bucket.count));
						return (
							<section {...stylex.props(styles.facet)}>
								<h2 {...stylex.props(styles.facetTitle)}>{label}</h2>
								<For each={buckets.slice(0, 6)}>
									{(bucket) => {
										const active = () =>
											props.selection?.kind === kind &&
											props.selection.key === bucket.key;
										return (
											<button
												type="button"
												aria-pressed={active()}
												onClick={() =>
													props.onSelect(
														active()
															? undefined
															: { key: bucket.key, kind }
													)
												}
												{...stylex.props(
													styles.facetButton,
													active() && styles.filterActive
												)}
											>
												<span {...stylex.props(styles.facetOptionLabel)}>
													{bucket.label}
												</span>
												<b {...stylex.props(styles.facetCount)}>
													{bucket.count}
												</b>
												<progress
													max={maximum}
													value={bucket.count}
													{...stylex.props(styles.facetBar)}
												/>
											</button>
										);
									}}
								</For>
							</section>
						);
					}}
				</For>
			</div>
		</aside>
	);
}

function InvestigationPane(props: {
	readonly comparison: TextureAuditRecord["comparisons"][number] | undefined;
	readonly comparisonKind: ComparisonKind;
	readonly locateFeedback: LocateFeedback;
	readonly locateProblem:
		| Extract<LocateFeedback, { status: "unavailable" | "failed" }>
		| undefined;
	readonly locating: boolean;
	readonly offlineBatchCount: number;
	readonly offlinePreviewLoading: boolean;
	readonly onComparison: (kind: ComparisonKind) => void;
	readonly onGeneratePreview: () => void;
	readonly onLocate: (objectPath: string) => void;
	readonly onSelectPeer: (objectPath: string) => void;
	readonly preview: Extract<TexturePreviewResult, { status: "available" }> | undefined;
	readonly record: TextureAuditRecord | undefined;
	readonly unavailablePreview:
		| Extract<TexturePreviewResult, { status: "unavailable" }>
		| undefined;
}) {
	return (
		<article aria-label="Texture investigation" {...stylex.props(styles.investigation)}>
			<Show
				when={props.record}
				fallback={
					<div {...stylex.props(styles.investigationEmpty)}>
						<strong>Select a texture</strong>
						<span>Its rule evidence and project peers will appear here.</span>
					</div>
				}
			>
				{(current) => {
					const item = () => current().record;
					return (
						<>
							<header {...stylex.props(styles.investigationHeader)}>
								<div {...stylex.props(styles.selectedIdentity)}>
									<small {...stylex.props(styles.selectedKicker)}>
										Selected texture
									</small>
									<h2 {...stylex.props(styles.selectedName)}>
										{shortName(item().objectPath)}
									</h2>
									<code
										title={item().objectPath}
										{...stylex.props(styles.selectedPath)}
									>
										{item().objectPath}
									</code>
								</div>
								<button
									type="button"
									aria-label={`Locate ${shortName(item().objectPath)} in Unreal`}
									disabled={props.locating}
									onClick={() => props.onLocate(item().objectPath)}
									{...stylex.props(styles.primaryAction)}
								>
									{locateLabel(props.locateFeedback, item().objectPath)}
								</button>
							</header>
							<Show when={props.locateProblem}>
								{(feedback) => (
									<p role="status" {...stylex.props(styles.locateMessage)}>
										{feedback().message} {feedback().recovery}
									</p>
								)}
							</Show>
							<div {...stylex.props(styles.selectedOverview)}>
								<div {...stylex.props(styles.previewFrame)}>
									<Show
										when={props.preview}
										fallback={
											<div {...stylex.props(styles.previewUnavailable)}>
												<strong>
													{props.unavailablePreview?.reason ===
													"offline_unavailable"
														? "Saved preview unavailable"
														: "No preview loaded"}
												</strong>
												<span>
													{props.unavailablePreview?.message ??
														"Live preview requires a connected editor."}
												</span>
												<button
													type="button"
													disabled={props.offlinePreviewLoading}
													onClick={props.onGeneratePreview}
													{...stylex.props(styles.secondaryAction)}
												>
													{savedPreviewBatchLabel(
														props.offlineBatchCount,
														props.offlinePreviewLoading
													)}
												</button>
											</div>
										}
									>
										{(image) => (
											<>
												<img
													src={`data:${image().mimeType};base64,${image().dataBase64}`}
													alt={`${image().authority === "live_editor" ? "Live" : "Saved"} preview of ${shortName(item().objectPath)}`}
													{...stylex.props(styles.previewImage)}
												/>
												<small
													aria-label="Preview authority"
													{...stylex.props(styles.previewAuthority)}
												>
													{image().authority === "live_editor"
														? "Live editor"
														: "Saved asset"}
												</small>
											</>
										)}
									</Show>
								</div>
								<section
									aria-label="Why this texture is flagged"
									{...stylex.props(styles.whyPanel)}
								>
									<header {...stylex.props(styles.whyHeader)}>
										<span>Why this texture</span>
										<b>{current().findings.length}</b>
									</header>
									<Show
										when={current().findings.length > 0}
										fallback={
											<div {...stylex.props(styles.noFinding)}>
												<strong>No active rule findings</strong>
												<span>
													Use the cohort comparison before treating this
													asset as normal.
												</span>
											</div>
										}
									>
										<For each={current().findings}>
											{(finding) => (
												<article {...stylex.props(styles.finding)}>
													<div {...stylex.props(styles.findingTitle)}>
														<span
															{...stylex.props(
																styles.findingSeverity
															)}
														>
															{finding.severity}
														</span>
														<code {...stylex.props(styles.findingRule)}>
															{finding.ruleId}
														</code>
													</div>
													<p {...stylex.props(styles.findingExplanation)}>
														{finding.explanation}
													</p>
													<div {...stylex.props(styles.findingValues)}>
														<FindingValues
															label="Expected"
															values={finding.expected}
														/>
														<FindingValues
															label="Actual"
															values={finding.actual}
														/>
													</div>
												</article>
											)}
										</For>
									</Show>
								</section>
							</div>
							<section
								aria-label="Peer comparison"
								{...stylex.props(styles.comparisonPanel)}
							>
								<header {...stylex.props(styles.sectionHeader)}>
									<div {...stylex.props(styles.comparisonIdentity)}>
										<h3 {...stylex.props(styles.comparisonTitle)}>
											Compared with
										</h3>
										<span
											title={props.comparison?.label}
											{...stylex.props(styles.comparisonLabel)}
										>
											{props.comparison?.label ?? "No comparison available"}
										</span>
									</div>
									<nav
										aria-label="Comparison cohort"
										{...stylex.props(styles.comparisonTabs)}
									>
										<For each={current().comparisons}>
											{(comparison) => (
												<button
													type="button"
													aria-pressed={
														props.comparisonKind === comparison.kind
													}
													onClick={() =>
														props.onComparison(comparison.kind)
													}
													{...stylex.props(
														styles.comparisonTab,
														props.comparisonKind === comparison.kind &&
															styles.comparisonTabActive
													)}
												>
													{comparisonKindLabel(comparison.kind)}
												</button>
											)}
										</For>
									</nav>
								</header>
								<Show when={props.comparison}>
									{(comparison) => (
										<>
											<div {...stylex.props(styles.comparisonMetrics)}>
												<ComparisonMetric
													label="Maximum dimension"
													metric={comparison().maximumDimension}
													format={(value) =>
														`${value.toLocaleString()} px`
													}
												/>
												<ComparisonMetric
													label="Package file"
													metric={comparison().packageFileBytes}
													format={bytesLabel}
												/>
												<div {...stylex.props(styles.cohortMetric)}>
													<small {...stylex.props(styles.metricLabel)}>
														Cohort
													</small>
													<strong {...stylex.props(styles.metricValue)}>
														{comparison().memberCount.toLocaleString()}{" "}
														textures
													</strong>
													<span {...stylex.props(styles.metricDetail)}>
														{comparison().findingCount.toLocaleString()}{" "}
														rule findings
													</span>
												</div>
											</div>
											<div {...stylex.props(styles.peerList)}>
												<header {...stylex.props(styles.peerHeader)}>
													<span {...stylex.props(styles.peerTitle)}>
														Representative peers
													</span>
													<small {...stylex.props(styles.peerSubtitle)}>
														Closest to the cohort median or selected
														value
													</small>
												</header>
												<For each={comparison().peers}>
													{(peer) => (
														<button
															type="button"
															onClick={() =>
																props.onSelectPeer(peer.objectPath)
															}
															{...stylex.props(styles.peerRow)}
														>
															<span
																{...stylex.props(
																	styles.peerIdentity
																)}
															>
																<strong
																	{...stylex.props(
																		styles.peerName
																	)}
																>
																	{shortName(peer.objectPath)}
																</strong>
																<small
																	title={peer.objectPath}
																	{...stylex.props(
																		styles.peerPath
																	)}
																>
																	{peer.objectPath}
																</small>
															</span>
															<b
																{...stylex.props(
																	styles.peerDimensions
																)}
															>
																{peer.dimensions.status ===
																"available"
																	? `${peer.dimensions.value.width} × ${peer.dimensions.value.height}`
																	: "Unavailable"}
															</b>
															<em
																{...stylex.props(styles.peerStatus)}
															>
																{peer.findingCount > 0
																	? `${peer.findingCount} finding`
																	: "Pass"}
															</em>
														</button>
													)}
												</For>
												<Show when={comparison().peers.length === 0}>
													<p {...stylex.props(styles.noPeers)}>
														No other textures belong to this cohort.
													</p>
												</Show>
											</div>
										</>
									)}
								</Show>
							</section>
							<section
								aria-label="Saved texture evidence"
								{...stylex.props(styles.evidencePanel)}
							>
								<EvidenceValue
									label="Dimensions"
									value={dimensionsLabel(item())}
									detail={maximumDimensionLabel(item())}
								/>
								<EvidenceValue
									label="Texture group"
									value={evidenceLabel(item().textureGroup)}
									detail={evidenceReason(item().textureGroup)}
								/>
								<EvidenceValue
									label="Compression"
									value={evidenceLabel(item().compression)}
									detail={evidenceReason(item().compression)}
								/>
								<EvidenceValue
									label="Color space"
									value={evidenceLabel(item().sRGB)}
									detail={evidenceReason(item().sRGB)}
								/>
								<EvidenceValue
									label="Mip generation"
									value={evidenceLabel(item().mipGeneration)}
									detail={evidenceReason(item().mipGeneration)}
								/>
								<EvidenceValue
									label="Package context"
									value={item().filePath}
									detail="Reverse usage references are not indexed by this audit yet."
								/>
							</section>
						</>
					);
				}}
			</Show>
		</article>
	);
}

function ComparisonMetric(props: {
	readonly format: (value: number) => string;
	readonly label: string;
	readonly metric: TextureAuditRecord["comparisons"][number]["maximumDimension"];
}) {
	return (
		<div {...stylex.props(styles.comparisonMetric)}>
			<small {...stylex.props(styles.metricLabel)}>{props.label}</small>
			<Show
				when={props.metric.status === "available" ? props.metric : undefined}
				fallback={
					<>
						<strong {...stylex.props(styles.metricValue)}>Unavailable</strong>
						<span {...stylex.props(styles.metricDetail)}>
							{props.metric.availableCount} comparable values
						</span>
					</>
				}
			>
				{(metric) => (
					<>
						<strong {...stylex.props(styles.metricValue)}>
							{props.format(metric().selected)}
						</strong>
						<span {...stylex.props(styles.metricDetail)}>
							Median {props.format(metric().median)} · {metric().percentile}th
							percentile
						</span>
					</>
				)}
			</Show>
		</div>
	);
}

function EvidenceValue(props: {
	readonly detail?: string;
	readonly label: string;
	readonly value: string;
}) {
	return (
		<div {...stylex.props(styles.evidenceValue)}>
			<small {...stylex.props(styles.evidenceLabel)}>{props.label}</small>
			<strong title={props.value} {...stylex.props(styles.evidenceData)}>
				{props.value}
			</strong>
			<Show when={props.detail}>
				{(detail) => <span {...stylex.props(styles.evidenceDetail)}>{detail()}</span>}
			</Show>
		</div>
	);
}

function FindingValues(props: {
	readonly label: string;
	readonly values: TextureAuditRecord["findings"][number]["actual"];
}) {
	return (
		<div {...stylex.props(styles.findingValueGroup)}>
			<small>{props.label}</small>
			<For each={props.values}>
				{(value) => (
					<span>
						{value.label}: <b>{value.value}</b>
					</span>
				)}
			</For>
		</div>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "12px 16px 16px",
		color: tokens.colorText,
		backgroundColor: "#10110f"
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 20,
		minHeight: 46,
		marginBottom: 8
	},
	heading: { minWidth: 0 },
	breadcrumb: { color: tokens.colorTextFaint, fontSize: 8 },
	titleRow: { display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 },
	title: { margin: "2px 0 0", fontSize: 18, fontWeight: 600, letterSpacing: 0 },
	subtitle: {
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	rescanButton: {
		flexShrink: 0,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "6px 10px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 9,
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 2 }
	},
	empty: {
		minHeight: 430,
		display: "grid",
		placeItems: "center",
		border: `1px dashed ${tokens.colorBorderStrong}`,
		color: tokens.colorTextMuted
	},
	error: {
		minHeight: 300,
		display: "grid",
		placeItems: "center",
		border: `1px solid ${tokens.colorDanger}`,
		color: "#efb2a6"
	},
	bench: {
		display: "grid",
		gridTemplateColumns: "220px minmax(360px, 430px) minmax(520px, 1fr)",
		gap: 8,
		height: "calc(100vh - 122px)",
		minHeight: 560,
		overflowX: "auto"
	},
	scopeRail: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#141613",
		overflowX: "hidden",
		overflowY: "auto"
	},
	auditSummary: { padding: 10, borderBottom: `1px solid ${tokens.colorBorder}` },
	summaryFinding: { display: "flex", alignItems: "baseline", gap: 6, marginBottom: 9 },
	summaryCount: { color: tokens.colorTextStrong, fontSize: 17, lineHeight: 1 },
	summaryUnit: { color: tokens.colorTextMuted, fontSize: 8 },
	summaryFacts: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5, margin: 0 },
	summaryFact: { minWidth: 0 },
	summaryTerm: { color: tokens.colorTextFaint, fontSize: 7 },
	summaryValue: {
		overflow: "hidden",
		margin: "2px 0 0",
		color: tokens.colorText,
		fontSize: 8,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	ruleSetName: {
		display: "block",
		overflow: "hidden",
		marginTop: 8,
		color: tokens.colorTextFaint,
		fontSize: 8,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	findingsFilter: {
		width: "100%",
		display: "flex",
		justifyContent: "space-between",
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#1c1f1a" },
		color: tokens.colorTextMuted,
		padding: "8px 10px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 9
	},
	filterActive: { backgroundColor: "#2b2118", color: "#f0cfaa" },
	facetList: { paddingBottom: 8 },
	facet: { padding: "8px 8px 3px", borderBottom: `1px solid ${tokens.colorBorder}` },
	facetTitle: {
		margin: "0 5px 4px",
		color: tokens.colorTextMuted,
		fontSize: 9,
		fontWeight: 600
	},
	facetButton: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) auto",
		gap: "2px 8px",
		border: 0,
		backgroundColor: { default: "transparent", ":hover": "#1c1f1a" },
		color: tokens.colorTextMuted,
		padding: "4px 5px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8,
		textAlign: "left"
	},
	facetOptionLabel: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	facetCount: { fontSize: 8, fontWeight: 500 },
	facetBar: { gridColumn: "1 / -1", width: "100%", height: 2, accentColor: "#8a7253" },
	catalog: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121411",
		overflow: "hidden"
	},
	catalogHeader: {
		display: "flex",
		alignItems: "center",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#171916"
	},
	search: {
		display: "flex",
		alignItems: "center",
		flex: 1,
		paddingLeft: 9,
		color: tokens.colorTextFaint
	},
	searchInput: {
		minWidth: 0,
		width: "100%",
		border: 0,
		backgroundColor: "transparent",
		color: tokens.colorText,
		padding: "8px",
		outline: "none",
		fontFamily: tokens.fontBody,
		fontSize: 9
	},
	resultCount: { padding: "0 9px", color: tokens.colorTextFaint, fontSize: 8 },
	columnLabels: {
		display: "grid",
		gridTemplateColumns: "1fr 128px",
		padding: "5px 10px 5px 48px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextFaint,
		fontSize: 8
	},
	assetList: { flex: 1, overflowX: "hidden", overflowY: "auto" },
	assetRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "34px minmax(0, 1fr) 112px 24px",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#1a1d18" },
		color: tokens.colorText,
		padding: "6px 8px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		textAlign: "left",
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	assetRowActive: {
		backgroundColor: "#252017",
		boxShadow: `inset 3px 0 ${tokens.colorWarningStrong}`
	},
	rowPreview: {
		display: "grid",
		placeItems: "center",
		width: 32,
		height: 32,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextFaint,
		fontSize: 8
	},
	rowPreviewImage: { width: "100%", height: "100%", objectFit: "cover" },
	assetIdentity: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
	assetName: {
		overflow: "hidden",
		fontSize: 10,
		fontWeight: 600,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	assetPath: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	rowEvidence: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
	rowDimensions: { fontSize: 9, fontWeight: 500, whiteSpace: "nowrap" },
	rowGroup: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	rowStatus: { display: "grid", placeItems: "center", width: 22, height: 22, fontSize: 8 },
	rowWarning: { backgroundColor: "#392519", color: "#f2bd86" },
	rowPass: { backgroundColor: "#1b281a", color: "#9fca8a" },
	noResults: { margin: "auto", padding: 30, color: tokens.colorTextMuted, fontSize: 9 },
	nextPage: {
		border: 0,
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "#171916", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorTextMuted,
		padding: 8,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 9
	},
	investigation: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#141613",
		overflowX: "hidden",
		overflowY: "auto"
	},
	investigationEmpty: {
		display: "grid",
		placeItems: "center",
		minHeight: 400,
		color: tokens.colorTextMuted
	},
	investigationHeader: {
		position: "sticky",
		top: 0,
		zIndex: 3,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
		padding: "8px 10px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#171916f5"
	},
	selectedIdentity: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
	selectedKicker: { color: tokens.colorTextFaint, fontSize: 7 },
	selectedName: {
		overflow: "hidden",
		margin: 0,
		fontSize: 14,
		fontWeight: 600,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	selectedPath: {
		display: "block",
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	primaryAction: {
		flexShrink: 0,
		border: `1px solid ${tokens.colorWarningStrong}`,
		backgroundColor: { default: "#2b2118", ":hover": "#38291d" },
		color: "#f0cfaa",
		padding: "6px 9px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8
	},
	secondaryAction: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "5px 8px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8
	},
	locateMessage: {
		margin: 0,
		padding: "5px 10px",
		color: tokens.colorWarningStrong,
		fontSize: 8
	},
	selectedOverview: {
		display: "grid",
		gridTemplateColumns: "minmax(180px, .75fr) minmax(280px, 1.25fr)",
		gap: 8,
		padding: 8
	},
	previewFrame: {
		position: "relative",
		display: "grid",
		placeItems: "center",
		minHeight: 210,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden"
	},
	previewImage: { display: "block", maxWidth: "100%", maxHeight: 260, objectFit: "contain" },
	previewAuthority: {
		position: "absolute",
		right: 5,
		bottom: 5,
		padding: "2px 5px",
		backgroundColor: "#0c0e0cd9",
		color: tokens.colorTextMuted,
		fontSize: 8
	},
	previewUnavailable: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: 7,
		padding: 14,
		color: tokens.colorTextMuted,
		fontSize: 8,
		textAlign: "center"
	},
	whyPanel: { border: `1px solid ${tokens.colorBorder}`, minWidth: 0 },
	whyHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "6px 8px",
		color: tokens.colorTextMuted,
		fontSize: 8
	},
	noFinding: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: 12,
		color: "#9fca8a",
		fontSize: 9
	},
	finding: { padding: 9, borderTop: `1px solid ${tokens.colorBorder}`, fontSize: 9 },
	findingTitle: {
		display: "flex",
		justifyContent: "space-between",
		gap: 8,
		color: tokens.colorWarningStrong
	},
	findingSeverity: { fontSize: 8, textTransform: "capitalize" },
	findingRule: {
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	findingExplanation: { margin: "6px 0", color: tokens.colorText, fontSize: 8, lineHeight: 1.4 },
	findingValues: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 5 },
	findingValueGroup: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		padding: 6,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontSize: 8
	},
	comparisonPanel: { margin: "0 8px 8px", border: `1px solid ${tokens.colorBorder}` },
	sectionHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 12,
		padding: "7px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	comparisonIdentity: { minWidth: 0 },
	comparisonTitle: { margin: 0, color: tokens.colorTextMuted, fontSize: 8, fontWeight: 500 },
	comparisonLabel: {
		display: "block",
		overflow: "hidden",
		maxWidth: 300,
		marginTop: 2,
		color: tokens.colorTextStrong,
		fontSize: 10,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	comparisonTabs: { display: "flex", gap: 4 },
	comparisonTab: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#1c1f1a" },
		color: tokens.colorTextMuted,
		padding: "4px 6px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 8
	},
	comparisonTabActive: {
		borderColor: tokens.colorWarningStrong,
		backgroundColor: "#2b2118",
		color: "#f0cfaa"
	},
	comparisonMetrics: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	comparisonMetric: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		minWidth: 0,
		padding: "8px 9px",
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	cohortMetric: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		minWidth: 0,
		padding: "8px 9px"
	},
	metricLabel: { color: tokens.colorTextFaint, fontSize: 7 },
	metricValue: {
		overflow: "hidden",
		fontSize: 11,
		fontWeight: 600,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	metricDetail: { color: tokens.colorTextMuted, fontSize: 8, lineHeight: 1.35 },
	peerList: { padding: 7 },
	peerHeader: { display: "flex", alignItems: "baseline", gap: 7, padding: "0 4px 5px" },
	peerTitle: { color: tokens.colorTextMuted, fontSize: 8 },
	peerSubtitle: { color: tokens.colorTextFaint, fontSize: 7 },
	peerRow: {
		width: "100%",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 100px 60px",
		alignItems: "center",
		gap: 8,
		border: 0,
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#1c1f1a" },
		color: tokens.colorText,
		padding: "6px 5px",
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		textAlign: "left"
	},
	peerIdentity: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
	peerName: {
		overflow: "hidden",
		fontSize: 9,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	peerPath: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	peerDimensions: { fontSize: 8, fontWeight: 500, whiteSpace: "nowrap" },
	peerStatus: {
		color: tokens.colorTextMuted,
		fontSize: 8,
		fontStyle: "normal",
		textAlign: "right"
	},
	noPeers: { margin: 0, padding: 10, color: tokens.colorTextMuted, fontSize: 8 },
	evidencePanel: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		margin: "0 8px 10px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		borderLeft: `1px solid ${tokens.colorBorder}`
	},
	evidenceValue: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		minWidth: 0,
		padding: "7px 8px",
		borderRight: `1px solid ${tokens.colorBorder}`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		fontSize: 8
	},
	evidenceLabel: { color: tokens.colorTextFaint, fontSize: 7 },
	evidenceData: {
		overflow: "hidden",
		fontSize: 8,
		fontWeight: 500,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	evidenceDetail: {
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontSize: 7,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	}
});

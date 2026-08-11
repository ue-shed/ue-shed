import * as stylex from "@stylexjs/stylex";
import type {
	TextCorpusFocus,
	TextCorpusQueryRunResult,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextReviewLens,
	TextReviewSignal,
	TextQualityQueryRunResult,
	TextQualityQuerySummary,
	TextQualityRuleDocument,
	TextUnitSearchResult
} from "@ue-shed/game-text/browser";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect, Schedule, Stream } from "effect";
import { For, Match, Show, Switch, createSignal, onMount, type Accessor } from "solid-js";
import type { GameTextClientShape } from "./game-text-client.js";
import { GameTextQualityWorkspace } from "./game-text-quality-workspace.js";
import {
	identityLabel,
	primaryContext,
	sourceText,
	textContext,
	type CapabilityFilter
} from "./game-text-view.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: Extract<TextCorpusQueryRunResult, { status: "failed" }>["error"];
	  }
	| { readonly status: "ready" };

type CopyFeedback =
	| { readonly status: "idle" }
	| { readonly status: "copied"; readonly target: string }
	| { readonly status: "failed"; readonly target: string };

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

function locateLabel(feedback: LocateFeedback, objectPath: string, idleLabel: string): string {
	if (feedback.status === "idle" || feedback.objectPath !== objectPath) return idleLabel;
	if (feedback.status === "locating") return "Locating…";
	if (feedback.status === "located") return "Located";
	if (feedback.status === "failed") return "Failed";
	if (feedback.reason === "not_connected") return "Unreal offline";
	if (feedback.reason === "capability_missing") return "Plugin needed";
	if (feedback.reason === "asset_not_found") return "Not found";
	return "Unavailable";
}

const filters: readonly { readonly value: CapabilityFilter; readonly label: string }[] = [
	{ value: "all", label: "All text" },
	{ value: "source_editable", label: "Supported sources" },
	{ value: "read_only", label: "Evidence only" }
];

const reviewLenses: readonly {
	readonly count: (summary: TextCorpusQuerySummary) => number;
	readonly detail: string;
	readonly label: string;
	readonly value: TextReviewLens;
}[] = [
	{
		count: (summary) => summary.review.all,
		detail: "All saved game text",
		label: "All lines",
		value: "all"
	},
	{
		count: (summary) => summary.review.shared,
		detail: "Identity used in 2+ places",
		label: "Shared",
		value: "shared"
	},
	{
		count: (summary) => summary.review.duplicateSource,
		detail: "Same words, different IDs",
		label: "Duplicate source",
		value: "duplicate_source"
	},
	{
		count: (summary) => summary.review.long,
		detail: "40+ source characters",
		label: "Long lines",
		value: "long"
	},
	{
		count: (summary) => summary.review.unresolved,
		detail: "No stable namespace and key",
		label: "Unresolved ID",
		value: "unresolved"
	},
	{
		count: (summary) => summary.review.conflicting,
		detail: "One ID, multiple source values",
		label: "Source conflicts",
		value: "conflicting"
	}
];

function signalLabel(signal: TextReviewSignal): string {
	if (signal === "duplicate_source") return "Duplicate source";
	if (signal === "evidence_only") return "Evidence only";
	if (signal === "unresolved") return "Unresolved ID";
	if (signal === "conflicting") return "Source conflict";
	if (signal === "shared") return "Shared";
	return "40+ chars";
}

function sourceKind(unit: TextUnitSearchResult): string {
	if (unit.locationKinds.length > 1) return "Multiple sources";
	const kind = unit.locationKinds[0];
	if (kind === "string_table_entry") return "String Table";
	if (kind === "data_table_cell") return "DataTable";
	return "Asset property";
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

function OccurrenceCard(props: {
	readonly locateFeedback: LocateFeedback;
	readonly occurrence: TextCorpusFocus["occurrences"][number];
	readonly onLocate: (objectPath: string) => void;
}) {
	const context = textContext(props.occurrence.location);
	const isCurrentLocate = () =>
		props.locateFeedback.status !== "idle" &&
		props.locateFeedback.objectPath === props.occurrence.location.objectPath;
	return (
		<article {...stylex.props(styles.occurrence)}>
			<header {...stylex.props(styles.occurrenceHeader)}>
				<div {...stylex.props(styles.contextIdentity)}>
					<small>{context.kind}</small>
					<strong>{context.title}</strong>
					<span>{context.detail}</span>
				</div>
				<span {...stylex.props(styles.occurrenceActions)}>
					<span
						{...stylex.props(
							styles.authority,
							props.occurrence.editCapability === "source_editable"
								? styles.editable
								: styles.readOnly
						)}
					>
						{props.occurrence.editCapability === "source_editable"
							? "Supported source"
							: "Evidence only"}
					</span>
					<button
						type="button"
						disabled={isCurrentLocate() && props.locateFeedback.status === "locating"}
						onClick={() => props.onLocate(props.occurrence.location.objectPath)}
						{...stylex.props(styles.locateButton)}
					>
						{locateLabel(
							props.locateFeedback,
							props.occurrence.location.objectPath,
							"Locate in Unreal"
						)}
					</button>
				</span>
			</header>
			<Show
				when={
					isCurrentLocate() &&
					(props.locateFeedback.status === "unavailable" ||
						props.locateFeedback.status === "failed")
						? props.locateFeedback
						: undefined
				}
			>
				{(feedback) => (
					<p role="status" {...stylex.props(styles.locateMessage)}>
						{feedback().message} {feedback().recovery}
					</p>
				)}
			</Show>
			<details {...stylex.props(styles.sourceDetails)}>
				<summary>Unreal source details</summary>
				<code {...stylex.props(styles.objectPath)}>
					{props.occurrence.location.objectPath}
				</code>
				<span {...stylex.props(styles.packageFile)}>{props.occurrence.packageFile}</span>
			</details>
		</article>
	);
}

/** Bounded query presentation; the renderer never receives the whole corpus. */
export function GameTextRoute(props: { readonly client: GameTextClientShape }) {
	const refreshAction = createEffectAction();
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const locateAction = createEffectAction();
	const qualityAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [progress, setProgress] = createSignal<TaskProgress>({
		completed: 0,
		phase: "idle",
		stage: "game_text",
		total: 0
	});
	const [summary, setSummary] = createSignal<TextCorpusQuerySummary>();
	const [page, setPage] = createSignal<TextCorpusSearchPage>({ total: 0, units: [] });
	const [query, setQuery] = createSignal("");
	const [capability, setCapability] = createSignal<CapabilityFilter>("all");
	const [lens, setLens] = createSignal<TextReviewLens>("all");
	const [selectedId, setSelectedId] = createSignal<TextUnitSearchResult["id"]>();
	const [focus, setFocus] = createSignal<TextCorpusFocus>();
	const [locateFeedback, setLocateFeedback] = createSignal<LocateFeedback>({ status: "idle" });
	const [mode, setMode] = createSignal<"corpus" | "quality">("corpus");
	const [qualitySummary, setQualitySummary] = createSignal<TextQualityQuerySummary>();
	const [qualityDocument, setQualityDocument] = createSignal<TextQualityRuleDocument>();
	const [qualityFailure, setQualityFailure] =
		createSignal<Extract<TextQualityQueryRunResult, { status: "failed" }>["error"]>();
	let searchGeneration = 0;
	let focusGeneration = 0;

	const requestFocus = (id: TextUnitSearchResult["id"]) => {
		const generation = ++focusGeneration;
		focusAction.run(props.client.focus({ id, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === focusGeneration) setState(failure(cause));
			},
			onSuccess: (result) => {
				if (generation !== focusGeneration) return;
				if (result.status === "found") setFocus(result.focus);
				else setFocus(undefined);
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

	const requestPage = (
		options: {
			readonly capability?: CapabilityFilter;
			readonly cursor?: TextUnitSearchResult["id"];
			readonly lens?: TextReviewLens;
			readonly query?: string;
		} = {}
	) => {
		const generation = ++searchGeneration;
		searchAction.run(
			props.client.search({
				capability: options.capability ?? capability(),
				...(options.cursor === undefined ? {} : { cursor: options.cursor }),
				lens: options.lens ?? lens(),
				pageSize: 50,
				query: options.query ?? query()
			}),
			{
				onFailure: (cause) => {
					if (generation === searchGeneration) setState(failure(cause));
				},
				onSuccess: (result) => {
					if (generation !== searchGeneration || result.status !== "ready") return;
					if (state().status !== "ready") return;
					setPage(result.page);
					const next =
						result.page.units.find((unit) => unit.id === selectedId()) ??
						result.page.units[0];
					setSelectedId(next?.id);
					if (next) requestFocus(next.id);
					else {
						focusGeneration += 1;
						setFocus(undefined);
					}
				}
			}
		);
	};

	const applyRefresh = (result: TextCorpusQueryRunResult) => {
		progressSubscription.cancel();
		if (result.status === "completed") {
			setSummary(result.summary);
			setPage({ total: 0, units: [] });
			setSelectedId(undefined);
			focusGeneration += 1;
			setFocus(undefined);
			setState({ status: "ready" });
			requestPage();
		} else if (result.status === "failed") {
			setState({ error: result.error, status: "failed" });
		} else setState({ status: result.status });
	};

	const refresh = () => {
		setMode("corpus");
		setQualitySummary(undefined);
		setQualityDocument(undefined);
		setQualityFailure(undefined);
		setState({ status: "loading" });
		setProgress({ completed: 0, phase: "idle", stage: "game_text", total: 0 });
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

	const loadQualityRules = () => {
		setQualityFailure(undefined);
		qualityAction.run(props.client.chooseQualityRules(), {
			onFailure: (cause) =>
				setQualityFailure({
					code: "contract_failure",
					message: String(cause),
					recovery: "Restart Workbench and retry loading the rule document.",
					retrySafe: true
				}),
			onSuccess: (result) => {
				if (result.status === "completed") {
					setQualitySummary(result.summary);
					setQualityDocument(result.document);
					setMode("quality");
				} else if (result.status === "failed") setQualityFailure(result.error);
			}
		});
	};

	onMount(refresh);

	return (
		<main {...stylex.props(styles.page)}>
			<TaskProgressModal
				open={state().status === "loading"}
				progress={progress()}
				title="Loading saved game text"
				detail="Workbench is decoding the packages selected by the project index and preserving every text identity and occurrence."
			/>
			<header {...stylex.props(styles.header)}>
				<div>
					<nav aria-label="Breadcrumb" {...stylex.props(styles.breadcrumb)}>
						Game text / {mode() === "quality" ? "Quality review" : "Text browser"}
					</nav>
					<h1 {...stylex.props(styles.title)}>Game text workbench</h1>
					<p {...stylex.props(styles.subtitle)}>
						Review source, identity, authored context, and every known use.
					</p>
				</div>
				<span {...stylex.props(styles.headerActions)}>
					<button type="button" onClick={refresh} {...stylex.props(styles.button)}>
						Rescan
					</button>
				</span>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.empty)}>Reading saved game text…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.empty)}>
						Choose an Unreal project from the Workbench header.
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.empty)}>Project selection cancelled.</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						return current.status === "failed" ? (
							<div {...stylex.props(styles.error)}>
								<strong>{current.error.message}</strong>
								<span>{current.error.recovery}</span>
							</div>
						) : null;
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					<Show when={summary()}>
						{(currentSummary) => (
							<>
								<div
									role="tablist"
									aria-label="Game Text view"
									{...stylex.props(styles.modeTabs)}
								>
									<button
										type="button"
										role="tab"
										aria-selected={mode() === "corpus"}
										onClick={() => setMode("corpus")}
										{...stylex.props(
											styles.modeTab,
											mode() === "corpus" && styles.modeTabActive
										)}
									>
										Text browser
									</button>
									<button
										type="button"
										role="tab"
										aria-selected={mode() === "quality"}
										onClick={() => setMode("quality")}
										{...stylex.props(
											styles.modeTab,
											mode() === "quality" && styles.modeTabActive
										)}
									>
										Quality review
										<Show when={qualitySummary()}>
											{(quality) => <b>{quality().findingCount}</b>}
										</Show>
									</button>
								</div>
								<Show when={mode() === "quality" ? qualityFailure() : undefined}>
									{(error) => (
										<div role="alert" {...stylex.props(styles.qualityError)}>
											<strong>{error().message}</strong>
											<span>{error().recovery}</span>
										</div>
									)}
								</Show>
								<Show
									when={mode() === "quality"}
									fallback={
										<TextCorpusWorkspace
											summary={currentSummary()}
											page={page}
											query={query}
											capability={capability}
											lens={lens}
											selectedId={selectedId}
											focus={focus}
											locateFeedback={locateFeedback}
											onQuery={(value) => {
												setQuery(value);
												requestPage({ query: value });
											}}
											onCapability={(value) => {
												setCapability(value);
												requestPage({ capability: value });
											}}
											onLens={(value) => {
												setLens(value);
												requestPage({ lens: value });
											}}
											onNextPage={(cursor) => requestPage({ cursor })}
											onLocate={locateAsset}
											onSelect={(id) => {
												setSelectedId(id);
												requestFocus(id);
											}}
										/>
									}
								>
									<Show
										when={qualitySummary()}
										fallback={
											<section
												aria-label="Quality rules setup"
												{...stylex.props(styles.qualitySetup)}
											>
												<small
													{...stylex.props(styles.qualitySetupEyebrow)}
												>
													PROJECT-AUTHORED QUALITY
												</small>
												<h2 {...stylex.props(styles.qualitySetupTitle)}>
													Review text against your rules
												</h2>
												<p {...stylex.props(styles.qualitySetupCopy)}>
													Load a rule file to check character limits and
													terminology across the saved text already shown
													in Workbench.
												</p>
												<button
													type="button"
													onClick={loadQualityRules}
													{...stylex.props(styles.qualityButton)}
												>
													Load quality rules
												</button>
											</section>
										}
									>
										{(quality) => (
											<Show when={qualityDocument()}>
												{(document) => (
													<GameTextQualityWorkspace
														client={props.client}
														document={document()}
														onReplaceRules={loadQualityRules}
														onReviewed={(result) =>
															setQualitySummary(result.summary)
														}
														summary={quality()}
													/>
												)}
											</Show>
										)}
									</Show>
								</Show>
							</>
						)}
					</Show>
				</Match>
			</Switch>
		</main>
	);
}

function TextCorpusWorkspace(props: {
	readonly summary: TextCorpusQuerySummary;
	readonly page: Accessor<TextCorpusSearchPage>;
	readonly query: Accessor<string>;
	readonly capability: Accessor<CapabilityFilter>;
	readonly lens: Accessor<TextReviewLens>;
	readonly selectedId: Accessor<TextUnitSearchResult["id"] | undefined>;
	readonly focus: Accessor<TextCorpusFocus | undefined>;
	readonly locateFeedback: Accessor<LocateFeedback>;
	readonly onQuery: (value: string) => void;
	readonly onCapability: (value: CapabilityFilter) => void;
	readonly onLens: (value: TextReviewLens) => void;
	readonly onLocate: (objectPath: string) => void;
	readonly onNextPage: (cursor: TextUnitSearchResult["id"]) => void;
	readonly onSelect: (id: TextUnitSearchResult["id"]) => void;
}) {
	const copyAction = createEffectAction();
	const [copyFeedback, setCopyFeedback] = createSignal<CopyFeedback>({ status: "idle" });

	const settleCopy = (feedback: Exclude<CopyFeedback, { status: "idle" }>) => {
		setCopyFeedback(feedback);
	};
	const copyValue = (target: string, value: string) => {
		copyAction.run(
			Effect.tryPromise({
				catch: () => undefined,
				try: () => navigator.clipboard.writeText(value)
			}),
			{
				onFailure: () => settleCopy({ status: "failed", target }),
				onSuccess: () => settleCopy({ status: "copied", target })
			}
		);
	};
	const copyLabel = (target: string, idleLabel: string) => {
		const feedback = copyFeedback();
		if (feedback.status === "idle" || feedback.target !== target) return idleLabel;
		return feedback.status === "copied" ? "Copied" : "Failed";
	};
	const copyStatus = (target: string): CopyFeedback["status"] => {
		const feedback = copyFeedback();
		return feedback.status !== "idle" && feedback.target === target ? feedback.status : "idle";
	};

	const coverage = props.summary.coverage;
	return (
		<div {...stylex.props(styles.workspace)}>
			<section aria-label="Search game text" {...stylex.props(styles.tools)}>
				<div {...stylex.props(styles.searchField)}>
					<span aria-hidden="true" {...stylex.props(styles.searchGlyph)}>
						⌕
					</span>
					<input
						autofocus
						type="search"
						value={props.query()}
						onInput={(event) => props.onQuery(event.currentTarget.value)}
						placeholder="Search exact source wording…"
						aria-label="Search game text"
						{...stylex.props(styles.searchInput)}
					/>
				</div>
				<span {...stylex.props(styles.matchCount)}>{props.page().total} matches</span>
				<div aria-label="Source support" role="group" {...stylex.props(styles.filters)}>
					<For each={filters}>
						{(filter) => (
							<button
								type="button"
								aria-pressed={props.capability() === filter.value}
								onClick={() => props.onCapability(filter.value)}
								{...stylex.props(
									styles.filterButton,
									props.capability() === filter.value && styles.filterActive
								)}
							>
								{filter.label}
							</button>
						)}
					</For>
				</div>
			</section>
			<div {...stylex.props(styles.grid)}>
				<aside aria-label="Review lenses" {...stylex.props(styles.reviewRail)}>
					<section aria-label="Saved text coverage" {...stylex.props(styles.railSection)}>
						<header {...stylex.props(styles.railHeader)}>
							<span>Saved text</span>
							<strong
								{...stylex.props(
									styles.coverageState,
									props.summary.status === "complete"
										? styles.complete
										: styles.partial
								)}
							>
								{props.summary.status === "partial" ? "PARTIAL" : "COMPLETE"}
							</strong>
						</header>
						<div {...stylex.props(styles.railMetrics)}>
							<CorpusMetric
								label="Units"
								value={coverage.textUnits}
								detail="identities"
							/>
							<CorpusMetric
								label="Uses"
								value={coverage.textOccurrences}
								detail={`${coverage.inspectedPackages} packages`}
							/>
						</div>
						<Show when={coverage.unsupportedTextProperties > 0}>
							<p {...stylex.props(styles.coverageWarning)}>
								<b>{coverage.unsupportedTextProperties}</b> unsupported text
								properties remain visible as coverage gaps.
							</p>
						</Show>
					</section>
					<section {...stylex.props(styles.railSection)}>
						<header {...stylex.props(styles.railLabel)}>Review queue</header>
						<div
							role="group"
							aria-label="Text review lens"
							{...stylex.props(styles.lensList)}
						>
							<For each={reviewLenses}>
								{(item) => (
									<button
										type="button"
										aria-pressed={props.lens() === item.value}
										onClick={() => props.onLens(item.value)}
										{...stylex.props(
											styles.lensButton,
											props.lens() === item.value && styles.lensActive
										)}
									>
										<span {...stylex.props(styles.lensCopy)}>
											<strong>{item.label}</strong>
											<small>{item.detail}</small>
										</span>
										<b {...stylex.props(styles.lensCount)}>
											{item.count(props.summary)}
										</b>
									</button>
								)}
							</For>
						</div>
					</section>
					<section {...stylex.props(styles.sourceBreakdown)}>
						<header {...stylex.props(styles.railLabel)}>Source evidence</header>
						<span {...stylex.props(styles.sourceRow)}>
							String Tables <b>{props.summary.sources.stringTable}</b>
						</span>
						<span {...stylex.props(styles.sourceRow)}>
							DataTables <b>{props.summary.sources.dataTable}</b>
						</span>
						<span {...stylex.props(styles.sourceRow)}>
							Asset properties <b>{props.summary.sources.assetProperty}</b>
						</span>
					</section>
				</aside>
				<section aria-label="Text units" {...stylex.props(styles.results)}>
					<header {...stylex.props(styles.resultsHeader)}>
						<span {...stylex.props(styles.resultsTitle)}>
							<strong>Source lines</strong>
							<small>Unreal identity · Authored context · Primary source</small>
						</span>
						<b>{props.page().total}</b>
					</header>
					<Show
						when={props.page().units.length > 0}
						fallback={
							<p {...stylex.props(styles.noMatches)}>
								No text matches this search and authority filter.
							</p>
						}
					>
						<For each={props.page().units}>
							{(unit) => {
								const preview = primaryContext(unit);
								const context = preview.context
									? textContext(preview.context.location)
									: undefined;
								const text = sourceText(unit);
								const identity = identityLabel(unit);
								const textCopyTarget = `${unit.id}:text`;
								const identityCopyTarget = `${unit.id}:identity`;
								const rowLocatePath =
									unit.occurrenceCount === 1
										? preview.context?.location.objectPath
										: undefined;
								const rowLocateStatus = (): LocateFeedback["status"] => {
									const feedback = props.locateFeedback();
									return rowLocatePath !== undefined &&
										feedback.status !== "idle" &&
										feedback.objectPath === rowLocatePath
										? feedback.status
										: "idle";
								};
								return (
									<div
										aria-current={
											props.selectedId() === unit.id ? "true" : undefined
										}
										onClick={() => props.onSelect(unit.id)}
										{...stylex.props(
											styles.resultRow,
											props.selectedId() === unit.id && styles.resultActive
										)}
									>
										<div {...stylex.props(styles.resultLead)}>
											<strong
												title={text}
												{...stylex.props(styles.resultText)}
											>
												{text}
											</strong>
											<span {...stylex.props(styles.rowCounts)}>
												{unit.wordCount}w · {unit.characterCount}c ·{" "}
												{unit.occurrenceCount}{" "}
												{unit.occurrenceCount === 1 ? "use" : "uses"}
											</span>
										</div>
										<span
											title={
												context
													? `${context.title} — ${context.detail}`
													: "Context unavailable"
											}
											{...stylex.props(styles.resultContext)}
										>
											<strong>
												{context?.title ?? "Context unavailable"}
											</strong>
											<small>
												{" "}
												· {context?.detail ?? "No decoded source location"}
												{preview.additional > 0
													? ` · +${preview.additional}`
													: ""}
											</small>
										</span>
										<div {...stylex.props(styles.resultEvidence)}>
											<code
												title={identity}
												{...stylex.props(styles.resultIdentity)}
											>
												{identity}
											</code>
											<span {...stylex.props(styles.resultSource)}>
												{sourceKind(unit)}
												<small
													{...stylex.props(
														styles.sourceAuthority,
														preview.context?.editCapability ===
															"source_editable"
															? styles.sourceSupported
															: styles.sourceEvidence
													)}
												>
													{preview.context?.editCapability ===
													"source_editable"
														? "supported"
														: "evidence"}
												</small>
											</span>
										</div>
										<Show when={unit.reviewSignals.length > 0}>
											<div {...stylex.props(styles.signalRow)}>
												<For each={unit.reviewSignals}>
													{(signal) => (
														<span {...stylex.props(styles.signal)}>
															{signalLabel(signal)}
														</span>
													)}
												</For>
											</div>
										</Show>
										<span {...stylex.props(styles.rowActions)}>
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													props.onSelect(unit.id);
													if (rowLocatePath)
														props.onLocate(rowLocatePath);
												}}
												disabled={
													rowLocatePath !== undefined &&
													rowLocateStatus() === "locating"
												}
												aria-label={
													rowLocatePath
														? `Locate the asset using ${text} in Unreal`
														: `Show ${unit.occurrenceCount} uses for ${text}`
												}
												{...stylex.props(styles.rowAction)}
											>
												{rowLocatePath
													? locateLabel(
															props.locateFeedback(),
															rowLocatePath,
															"Locate"
														)
													: "Show uses"}
											</button>
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													copyValue(textCopyTarget, text);
												}}
												aria-label={`Copy source text ${text}`}
												{...stylex.props(
													styles.rowAction,
													copyStatus(textCopyTarget) === "copied" &&
														styles.rowActionSuccess,
													copyStatus(textCopyTarget) === "failed" &&
														styles.rowActionFailure
												)}
											>
												{copyLabel(textCopyTarget, "Copy text")}
											</button>
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													copyValue(identityCopyTarget, identity);
												}}
												aria-label={`Copy Unreal identity ${identity}`}
												{...stylex.props(
													styles.rowAction,
													copyStatus(identityCopyTarget) === "copied" &&
														styles.rowActionSuccess,
													copyStatus(identityCopyTarget) === "failed" &&
														styles.rowActionFailure
												)}
											>
												{copyLabel(identityCopyTarget, "Copy ID")}
											</button>
										</span>
									</div>
								);
							}}
						</For>
					</Show>
					<Show when={props.page().nextCursor}>
						{(cursor) => (
							<button
								type="button"
								onClick={() => props.onNextPage(cursor())}
								{...stylex.props(styles.nextPage)}
							>
								Next page
							</button>
						)}
					</Show>
					<footer {...stylex.props(styles.resultsFooter)}>
						<span>
							Showing {props.page().units.length} of {props.page().total} matches
						</span>
						<span>{coverage.textUnits} text entries</span>
					</footer>
				</section>
				<FocusPanel
					focus={props.focus()}
					locateFeedback={props.locateFeedback()}
					onLocate={props.onLocate}
				/>
			</div>
		</div>
	);
}

function CorpusMetric(props: {
	readonly detail: string;
	readonly label: string;
	readonly value: number;
}) {
	return (
		<div {...stylex.props(styles.corpusMetric)}>
			<small {...stylex.props(styles.metricLabel)}>{props.label}</small>
			<strong {...stylex.props(styles.metricValue)}>{props.value.toLocaleString()}</strong>
			<span {...stylex.props(styles.metricDetail)}>{props.detail}</span>
		</div>
	);
}

function FocusPanel(props: {
	readonly focus: TextCorpusFocus | undefined;
	readonly locateFeedback: LocateFeedback;
	readonly onLocate: (objectPath: string) => void;
}) {
	return (
		<aside aria-label="Text focus" {...stylex.props(styles.focus)}>
			<Show
				when={props.focus}
				fallback={
					<p {...stylex.props(styles.focusEmpty)}>
						Select text to see where it is authored and every known place it occurs.
					</p>
				}
			>
				{(result) => (
					<>
						<header {...stylex.props(styles.focusHeader)}>
							<small {...stylex.props(styles.focusEyebrow)}>
								Source under review
							</small>
							<blockquote {...stylex.props(styles.focusQuote)}>
								“{sourceText(result().unit)}”
							</blockquote>
							<div {...stylex.props(styles.focusMeta)}>
								<span>{result().unit.wordCount} words</span>
								<span>{result().unit.characterCount} characters</span>
								<span>
									{result().totalOccurrences}{" "}
									{result().totalOccurrences === 1 ? "use" : "uses"}
								</span>
							</div>
							<div {...stylex.props(styles.focusIdentity)}>
								<small>Unreal identity</small>
								<code>{identityLabel(result().unit)}</code>
							</div>
							<Show when={result().unit.reviewSignals.length > 0}>
								<div {...stylex.props(styles.focusSignals)}>
									<For each={result().unit.reviewSignals}>
										{(signal) => (
											<span {...stylex.props(styles.signal)}>
												{signalLabel(signal)}
											</span>
										)}
									</For>
								</div>
							</Show>
						</header>
						<section
							aria-label="Text occurrences"
							{...stylex.props(styles.occurrences)}
						>
							<header {...stylex.props(styles.sectionHeader)}>
								<span>Authored and gathered context</span>
								<b>{result().totalOccurrences}</b>
							</header>
							<For each={result().occurrences}>
								{(occurrence) => (
									<OccurrenceCard
										locateFeedback={props.locateFeedback}
										occurrence={occurrence}
										onLocate={props.onLocate}
									/>
								)}
							</For>
						</section>
						<Show when={result().diagnostics.length > 0}>
							<section
								aria-label="Focused coverage notes"
								{...stylex.props(styles.diagnostics)}
							>
								<header {...stylex.props(styles.sectionHeader)}>
									<span>Coverage notes</span>
									<b>{result().diagnostics.length}</b>
								</header>
								<For each={result().diagnostics}>
									{(diagnostic) => (
										<article {...stylex.props(styles.diagnostic)}>
											<strong>{diagnostic.code.replaceAll("_", " ")}</strong>
											<p>{diagnostic.message}</p>
											<code>{diagnostic.packageFile}</code>
										</article>
									)}
								</For>
							</section>
						</Show>
					</>
				)}
			</Show>
		</aside>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "16px 22px 22px",
		color: tokens.colorText,
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		backgroundColor: "#100f0e",
		backgroundImage: "none"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 24,
		marginBottom: 10
	},
	breadcrumb: {
		color: tokens.colorAccent,
		fontSize: 8,
		letterSpacing: ".04em"
	},
	title: {
		margin: "3px 0 0",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 19,
		fontWeight: 600,
		letterSpacing: 0
	},
	subtitle: { margin: "2px 0 0", color: tokens.colorTextMuted, fontSize: 10 },
	button: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "6px 10px",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 10,
		letterSpacing: 0,
		transition: `transform ${tokens.motionFast} cubic-bezier(.23, 1, .32, 1)`,
		":active": { transform: "scale(.97)" },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 2 }
	},
	headerActions: { display: "flex", alignItems: "center", gap: 6 },
	qualityButton: {
		border: "1px solid #884a36",
		backgroundColor: { default: "#382019", ":hover": "#4a291f" },
		color: "#ffd0bf",
		padding: "6px 10px",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 10
	},
	qualitySetup: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 10,
		maxWidth: 560,
		minHeight: 280,
		margin: "48px auto 0",
		padding: "28px 30px",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311",
		boxShadow: "inset 3px 0 #e87655",
		color: tokens.colorTextMuted,
		fontSize: 10,
		lineHeight: 1.5
	},
	qualitySetupEyebrow: { color: "#e87655", fontSize: 8, letterSpacing: ".08em" },
	qualitySetupTitle: {
		margin: "4px 0 0",
		color: tokens.colorTextStrong,
		fontSize: 19,
		fontWeight: 600
	},
	qualitySetupCopy: { maxWidth: 430, margin: 0 },
	modeTabs: {
		display: "flex",
		alignItems: "stretch",
		marginBottom: 8,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	modeTab: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		border: 0,
		borderRight: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "#151311", ":hover": "#211d1a" },
		color: tokens.colorTextMuted,
		padding: "7px 12px",
		fontSize: 10,
		cursor: "pointer",
		opacity: { default: 1, ":disabled": 0.45 }
	},
	modeTabActive: {
		color: "#ffd0bf",
		backgroundColor: "#2b1d18",
		boxShadow: "inset 0 -2px #e87655"
	},
	qualityError: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		marginBottom: 8,
		padding: "8px 10px",
		border: `1px solid ${tokens.colorDanger}`,
		color: "#efaa91",
		fontSize: 9
	},
	empty: {
		minHeight: 380,
		display: "grid",
		placeItems: "center",
		border: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted
	},
	error: {
		minHeight: 300,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 10,
		border: `1px solid ${tokens.colorDanger}`,
		color: "#e39b86"
	},
	workspace: { display: "flex", flexDirection: "column", gap: 8 },
	coverage: {
		display: "grid",
		gridTemplateColumns: "minmax(175px, 1.2fr) repeat(4, minmax(110px, .7fr))",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311e8"
	},
	corpusStatus: {
		display: "grid",
		gridTemplateColumns: "auto minmax(0, 1fr)",
		alignContent: "center",
		gap: "3px 8px",
		padding: "7px 10px",
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	coverageState: { padding: "2px 5px", fontSize: 8, letterSpacing: 0 },
	complete: { color: "#b9dfa5", backgroundColor: "#1e2a1d" },
	partial: { color: "#efaa91", backgroundColor: "#382019" },
	corpusName: { alignSelf: "center", fontSize: 10, fontWeight: 500 },
	corpusDetail: {
		gridColumn: "1 / -1",
		color: tokens.colorTextFaint,
		fontSize: 8,
		letterSpacing: 0
	},
	corpusMetric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 3,
		padding: "7px 10px",
		borderRight: `1px solid ${tokens.colorBorder}`,
		fontSize: 8
	},
	metricLabel: {
		color: tokens.colorTextFaint,
		fontSize: 8,
		letterSpacing: ".03em"
	},
	metricValue: { color: tokens.colorTextStrong, fontSize: 12, fontWeight: 600, lineHeight: 1.1 },
	metricDetail: {
		gridColumn: "1 / -1",
		color: tokens.colorTextFaint,
		fontSize: 8
	},
	gapValue: { color: "#ef805f", fontSize: 12, fontWeight: 600, lineHeight: 1.1 },
	gapMetric: {
		display: "grid",
		gridTemplateColumns: "auto 1fr",
		alignItems: "end",
		gap: "2px 8px",
		padding: "7px 10px",
		fontSize: 8
	},
	gapMetricWarning: { backgroundColor: "#181513", color: "#efaa91" },
	tools: {
		display: "flex",
		alignItems: "stretch",
		minHeight: 36,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	searchField: { display: "flex", alignItems: "center", minWidth: 0, flex: 1 },
	searchGlyph: { paddingLeft: 10, color: tokens.colorTextFaint, fontSize: 14 },
	searchInput: {
		minWidth: 0,
		flex: 1,
		border: 0,
		backgroundColor: "transparent",
		color: tokens.colorText,
		padding: "7px 9px",
		outline: "none",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 11,
		"::placeholder": { color: tokens.colorTextFaint }
	},
	matchCount: {
		flexShrink: 0,
		display: "grid",
		placeItems: "center",
		minWidth: 90,
		padding: "0 12px",
		borderLeft: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 10
	},
	filters: { display: "flex", borderLeft: `1px solid ${tokens.colorBorder}` },
	filterButton: {
		border: 0,
		borderLeft: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "#171513", ":hover": "#28231f" },
		color: tokens.colorTextMuted,
		padding: "7px 9px",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 9,
		letterSpacing: 0,
		transition: `transform ${tokens.motionFast} cubic-bezier(.23, 1, .32, 1)`,
		":active": { transform: "scale(.97)" },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	filterActive: {
		color: "#ffd0bf",
		backgroundColor: "#352019",
		boxShadow: "inset 0 -2px #e87655"
	},
	grid: {
		display: "grid",
		gridTemplateColumns: "206px minmax(360px, 440px) minmax(420px, 1fr)",
		gap: 8
	},
	reviewRail: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 178px)",
		minHeight: 500,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		overflow: "auto"
	},
	railSection: { borderBottom: `1px solid ${tokens.colorBorder}` },
	railHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "8px 9px",
		fontSize: 10
	},
	railLabel: {
		padding: "7px 9px 5px",
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".04em"
	},
	railMetrics: {
		display: "grid",
		gridTemplateColumns: "1fr 1fr",
		borderTop: `1px solid ${tokens.colorBorder}`
	},
	coverageWarning: {
		margin: 0,
		padding: "7px 9px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: "#d9a18d",
		fontSize: 9,
		lineHeight: 1.45
	},
	lensList: { display: "flex", flexDirection: "column" },
	lensButton: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		width: "100%",
		border: 0,
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: tokens.colorTextMuted,
		padding: "7px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 9,
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: -2 }
	},
	lensActive: { color: "#f2d2c6", backgroundColor: "#2b1d18", boxShadow: "inset 3px 0 #e87655" },
	lensCopy: { display: "flex", minWidth: 0, flexDirection: "column", gap: 1 },
	lensCount: { flexShrink: 0, color: tokens.colorText, fontVariantNumeric: "tabular-nums" },
	sourceBreakdown: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		paddingBottom: 9,
		fontSize: 9,
		color: tokens.colorTextMuted
	},
	sourceRow: { display: "flex", justifyContent: "space-between", padding: "0 9px" },
	results: {
		display: "flex",
		flexDirection: "column",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		height: "calc(100vh - 178px)",
		minHeight: 500,
		overflow: "auto"
	},
	resultsHeader: {
		position: "sticky",
		top: 0,
		zIndex: 2,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
		padding: "7px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#191715f5",
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".03em"
	},
	resultsTitle: { display: "flex", flexDirection: "column", gap: 2 },
	resultRow: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "stretch",
		gap: 5,
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#201c19" },
		color: tokens.colorText,
		minHeight: 86,
		padding: "8px 9px",
		textAlign: "left",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif'
	},
	resultActive: { backgroundColor: "#2b1d18", boxShadow: "inset 3px 0 #e87655" },
	resultLead: { display: "flex", justifyContent: "space-between", alignItems: "start", gap: 8 },
	resultText: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 600,
		lineHeight: 1.25,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	resultIdentity: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: "#bbb2a9",
		fontFamily: tokens.fontBody,
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	rowCounts: { flexShrink: 0, color: tokens.colorTextFaint, fontSize: 9, whiteSpace: "nowrap" },
	resultContext: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: "#d3cbc3",
		fontSize: 10,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	resultEvidence: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		minWidth: 0
	},
	resultSource: {
		display: "flex",
		alignItems: "center",
		overflow: "hidden",
		gap: 5,
		minWidth: 0,
		fontSize: 9,
		whiteSpace: "nowrap"
	},
	sourceAuthority: { padding: "1px 4px", fontSize: 8, fontWeight: 500 },
	sourceSupported: { color: "#9fca8a", backgroundColor: "#1b281a" },
	sourceEvidence: { color: "#b7aea5", backgroundColor: "#24201d" },
	signalRow: { display: "flex", flexWrap: "wrap", gap: 3, color: "#d4a18e", fontSize: 8 },
	signal: { padding: "1px 4px", backgroundColor: "#30201a", border: "1px solid #533025" },
	rowActions: { display: "flex", justifyContent: "flex-start", gap: 3, whiteSpace: "nowrap" },
	rowAction: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "#181614", ":hover": "#302a25" },
		color: tokens.colorTextMuted,
		minWidth: 0,
		padding: "4px 6px",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 9,
		lineHeight: 1,
		opacity: { default: 1, ":disabled": 0.55 },
		":active": { transform: "scale(.97)" },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	rowActionSuccess: { color: "#a9d897", borderColor: "#41643a", backgroundColor: "#1b281a" },
	rowActionFailure: { color: "#efaa91", borderColor: "#754132", backgroundColor: "#382019" },
	lengthCount: { justifySelf: "center", color: tokens.colorTextMuted, fontSize: 9 },
	occurrenceCount: { justifySelf: "center", color: "#e9b19d", fontSize: 11 },
	noMatches: { padding: 40, color: tokens.colorTextMuted, textAlign: "center", fontSize: 10 },
	nextPage: {
		border: 0,
		backgroundColor: { default: "#211d1a", ":hover": "#302a25" },
		color: tokens.colorTextMuted,
		padding: 12,
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 10,
		letterSpacing: ".08em"
	},
	resultsFooter: {
		position: "sticky",
		bottom: 0,
		display: "flex",
		justifyContent: "space-between",
		marginTop: "auto",
		padding: "6px 10px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#171513f5",
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: 0
	},
	focus: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311",
		height: "calc(100vh - 178px)",
		minHeight: 500,
		overflow: "auto",
		scrollbarColor: `${tokens.colorBorderStrong} ${tokens.colorSurfaceInset}`
	},
	focusEmpty: { padding: 24, color: tokens.colorTextMuted, fontSize: 11, lineHeight: 1.6 },
	focusHeader: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		padding: "9px 11px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	focusEyebrow: {
		color: tokens.colorTextFaint,
		fontSize: 9,
		letterSpacing: ".03em"
	},
	focusQuote: {
		margin: "3px 0 2px",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 20,
		fontWeight: 600,
		lineHeight: 1.3
	},
	focusMeta: { display: "flex", gap: 8, color: "#c19382", fontSize: 9 },
	focusIdentity: {
		display: "grid",
		gridTemplateColumns: "90px minmax(0, 1fr)",
		gap: 8,
		padding: "6px 0",
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	focusSignals: { display: "flex", flexWrap: "wrap", gap: 4, color: "#e0a58f", fontSize: 9 },
	identityDetails: {
		color: tokens.colorTextMuted,
		fontSize: 8,
		marginTop: 3
	},
	occurrences: { margin: 8, border: `1px solid ${tokens.colorBorder}` },
	diagnostics: { margin: "0 8px 10px", border: `1px solid ${tokens.colorBorder}` },
	sectionHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "6px 8px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9,
		letterSpacing: ".03em"
	},
	occurrence: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		padding: "7px 8px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		fontSize: 10
	},
	occurrenceHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		gap: 12
	},
	occurrenceActions: {
		display: "flex",
		alignItems: "center",
		flexShrink: 0,
		gap: 5
	},
	contextIdentity: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		minWidth: 0,
		color: tokens.colorTextMuted
	},
	authority: { flexShrink: 0, padding: "2px 5px", fontSize: 8, letterSpacing: 0 },
	editable: { color: "#9fca8a", backgroundColor: "#1b281a" },
	readOnly: { color: "#b7aea5", backgroundColor: "#24201d" },
	locateButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "#181614", ":hover": "#302a25" },
		color: tokens.colorTextMuted,
		padding: "3px 6px",
		cursor: "pointer",
		fontFamily: '"Segoe UI Variable", "Segoe UI", sans-serif',
		fontSize: 9,
		opacity: { default: 1, ":disabled": 0.55 },
		":active": { transform: "scale(.97)" },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	locateMessage: {
		margin: 0,
		padding: "5px 6px",
		borderLeft: "2px solid #754132",
		backgroundColor: "#241915",
		color: "#efaa91",
		fontSize: 9,
		lineHeight: 1.45
	},
	objectPath: {
		overflow: "hidden",
		color: "#d8d0c8",
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	packageFile: {
		display: "block",
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 8,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	sourceDetails: {
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextFaint,
		fontSize: 8,
		marginTop: 4,
		paddingTop: 5
	},
	diagnostic: { padding: 10, borderBottom: `1px solid ${tokens.colorBorder}`, fontSize: 8 }
});

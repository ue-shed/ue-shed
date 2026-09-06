import type { GameTextInvestigationPreset, TextQualityFilter } from "@ue-shed/game-text/browser";
import { InvestigationActions } from "@ue-shed/ui/investigation-actions";
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
	TextQualityRuleUpdateResult,
	TextUnitSearchResult
} from "@ue-shed/game-text/browser";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Effect, Schedule, Stream } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	batch,
	createSignal,
	onCleanup,
	onMount,
	type Accessor
} from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextQualityWorkspace } from "./game-text-quality-workspace.js";
import { createGameTextRuleState, type RuleEditorState } from "./game-text-rule-state.js";
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
	if (feedback.status === "locating") return "Opening…";
	if (feedback.status === "located") return "Opened";
	if (feedback.status === "failed") return "Failed";
	if (feedback.reason === "not_connected") return "Unreal offline";
	if (feedback.reason === "capability_missing") return "Plugin needed";
	if (feedback.reason === "asset_not_found") return "Not found";
	return "Unavailable";
}

const filters: readonly { readonly value: CapabilityFilter; readonly label: string }[] = [
	{ value: "all", label: "All text" },
	{ value: "source_editable", label: "Source editable" },
	{ value: "read_only", label: "Read only" }
];

const reviewLenses: readonly {
	readonly count: (summary: TextCorpusQuerySummary) => number;
	readonly label: string;
	readonly value: TextReviewLens;
}[] = [
	{ count: (summary) => summary.review.all, label: "All text", value: "all" },
	{ count: (summary) => summary.review.shared, label: "Shared identity", value: "shared" },
	{
		count: (summary) => summary.review.duplicateSource,
		label: "Duplicate source",
		value: "duplicate_source"
	},
	{
		count: (summary) => summary.review.long,
		label: "Over 40 characters",
		value: "long"
	},
	{ count: (summary) => summary.review.unresolved, label: "Unresolved ID", value: "unresolved" },
	{
		count: (summary) => summary.review.conflicting,
		label: "Source conflicts",
		value: "conflicting"
	}
];

function signalLabel(signal: TextReviewSignal): string {
	if (signal === "duplicate_source") return "Duplicate source";
	if (signal === "evidence_only") return "Read only";
	if (signal === "unresolved") return "Unresolved ID";
	if (signal === "conflicting") return "Source conflict";
	if (signal === "shared") return "Shared identity";
	return "Over 40 characters";
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

function FailureCard(props: {
	readonly title: string;
	readonly detail: string | undefined;
	readonly onRetry: () => void;
}) {
	return (
		<section role="alert" {...stylex.props(styles.failureCard)}>
			<strong {...stylex.props(styles.failureTitle)}>{props.title}</strong>
			<p {...stylex.props(styles.failureCopy)}>
				Try again. If it keeps failing, restart Workbench and verify package versions.
			</p>
			<button type="button" onClick={props.onRetry} {...stylex.props(styles.button)}>
				Retry
			</button>
			<Show when={props.detail}>
				{(detail) => (
					<details {...stylex.props(styles.technicalDetails)}>
						<summary {...stylex.props(styles.techSummary)}>Technical details</summary>
						<pre {...stylex.props(styles.techPre)}>{detail()}</pre>
					</details>
				)}
			</Show>
		</section>
	);
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
					<small {...stylex.props(styles.contextKind)}>{context.kind}</small>
					<strong {...stylex.props(styles.contextTitle)}>{context.title}</strong>
					<span {...stylex.props(styles.contextDetail)}>{context.detail}</span>
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
							? "Source editable"
							: "Read only"}
					</span>
					<button
						type="button"
						disabled={isCurrentLocate() && props.locateFeedback.status === "locating"}
						onClick={() => props.onLocate(props.occurrence.location.objectPath)}
						aria-label={`Open package for ${context.title}`}
						{...stylex.props(styles.locateButton)}
					>
						{locateLabel(
							props.locateFeedback,
							props.occurrence.location.objectPath,
							"Open package"
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
						<strong>Couldn’t open the package.</strong> {feedback().message}{" "}
						{feedback().recovery}
					</p>
				)}
			</Show>
			<details {...stylex.props(styles.sourceDetails)}>
				<summary {...stylex.props(styles.detailsSummary)}>Technical details</summary>
				<code {...stylex.props(styles.objectPath)}>
					{props.occurrence.location.objectPath}
				</code>
				<span {...stylex.props(styles.packageFile)}>{props.occurrence.packageFile}</span>
			</details>
		</article>
	);
}

/** Bounded query presentation; the renderer never receives the whole corpus. */
export interface GameTextPreferences {
	readonly mode?: "corpus" | "quality";
	readonly qualityFilter?: TextQualityFilter;
	readonly qualityDocument?: TextQualityRuleDocument | undefined;
	readonly qualityEditor?: RuleEditorState | undefined;
	readonly query: string;
	readonly capability: CapabilityFilter;
	readonly lens: TextReviewLens;
	readonly selectedId: TextUnitSearchResult["id"] | undefined;
}
export function GameTextRoute(props: {
	readonly client: GameTextClientApi;
	readonly initialPreferences?: GameTextPreferences | undefined;
	readonly onPreferencesChange?: (preferences: GameTextPreferences) => void;
}) {
	const [qualityFilter, setQualityFilter] = createSignal<TextQualityFilter>(
		props.initialPreferences?.qualityFilter ?? "all"
	);
	const [investigationRevision, setInvestigationRevision] = createSignal(0);
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
	const [query, setQuery] = createSignal<string>(props.initialPreferences?.query ?? "");
	const [capability, setCapability] = createSignal<CapabilityFilter>(
		props.initialPreferences?.capability ?? "all"
	);
	const [lens, setLens] = createSignal<TextReviewLens>(props.initialPreferences?.lens ?? "all");
	const [selectedId, setSelectedId] = createSignal<TextUnitSearchResult["id"] | undefined>(
		props.initialPreferences?.selectedId ?? undefined
	);
	const [focus, setFocus] = createSignal<TextCorpusFocus>();
	const [locateFeedback, setLocateFeedback] = createSignal<LocateFeedback>({ status: "idle" });
	const [mode, setMode] = createSignal<"corpus" | "quality">(
		props.initialPreferences?.mode ?? "corpus"
	);
	const [qualitySummary, setQualitySummary] = createSignal<TextQualityQuerySummary>();
	const [qualityDocument, setQualityDocument] = createSignal<TextQualityRuleDocument | undefined>(
		props.initialPreferences?.qualityDocument
	);
	const [qualityFailure, setQualityFailure] =
		createSignal<
			Extract<
				TextQualityQueryRunResult | TextQualityRuleUpdateResult,
				{ status: "failed" }
			>["error"]
		>();
	let searchGeneration = 0;
	let focusGeneration = 0;
	const initialQualityDocument = props.initialPreferences?.qualityDocument;
	const qualityEditor = createGameTextRuleState({
		client: props.client,
		initialState:
			props.initialPreferences?.qualityEditor ??
			(initialQualityDocument
				? {
						draft: initialQualityDocument,
						savedDocument: initialQualityDocument
					}
				: undefined),
		onReviewed: (result) => {
			setQualityDocument(result.document);
			setQualitySummary(result.summary);
			setInvestigationRevision((value) => value + 1);
		}
	});

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
				...(options.cursor === undefined ? undefined : { cursor: options.cursor }),
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
		setInvestigationRevision((value) => value + 1);
		if (result.status === "completed") {
			setSummary(result.summary);
			setPage({ total: 0, units: [] });

			focusGeneration += 1;
			setFocus(undefined);
			setState({ status: "ready" });
			requestPage();
			const document = qualityDocument();
			if (document)
				qualityAction.run(props.client.previewQualityRules(document), {
					onSuccess: (result) => {
						if (result.status === "completed") setQualitySummary(result.summary);
						else if (result.status === "failed") setQualityFailure(result.error);
					}
				});
		} else if (result.status === "failed") {
			setState({ error: result.error, status: "failed" });
		} else setState({ status: result.status });
	};

	const load = (refresh: boolean) => {
		if (refresh) {
			qualityEditor.replace(undefined);
			setMode("corpus");
			setQualityDocument(undefined);
		}
		setQualitySummary(undefined);
		setQualityFailure(undefined);
		setState({ status: "loading" });
		setProgress({ completed: 0, phase: "idle", stage: "game_text", total: 0 });
		progressSubscription.subscribe(
			Stream.fromEffectSchedule(props.client.progress(), Schedule.spaced("100 millis")),
			{ onValue: setProgress }
		);
		refreshAction.run(props.client.loadConfiguredProject(refresh), {
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
					batch(() => {
						qualityEditor.replace(result.document);
						setQualitySummary(result.summary);
						setQualityDocument(result.document);
					});
					setMode("quality");
				} else if (result.status === "failed") setQualityFailure(result.error);
			}
		});
	};

	onCleanup(() =>
		props.onPreferencesChange?.({
			mode: mode(),
			qualityDocument: qualityDocument(),
			qualityEditor: qualityEditor.state(),
			qualityFilter: qualityFilter(),
			query: query(),
			capability: capability(),
			lens: lens(),
			selectedId: selectedId()
		})
	);
	const restoreInvestigation = (preset: GameTextInvestigationPreset) => {
		qualityEditor.replace(undefined);
		setQuery(preset.query.query);
		setCapability(preset.query.capability);
		setLens(preset.query.lens ?? "all");
		setMode(preset.query.mode);
		setQualityFilter(preset.query.qualityFilter);
		setQualityDocument(preset.rules);
		qualityEditor.replace(preset.rules, false);
		setSelectedId(undefined);
		load(false);
	};
	const refresh = () => load(true);
	onMount(() => load(false));

	return (
		<main {...stylex.props(styles.page)}>
			<TaskProgressModal
				open={state().status === "loading"}
				progress={progress()}
				title="Loading saved game text"
				detail="Workbench is decoding the packages selected by the project index and preserving every text identity and occurrence."
			/>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.headerLead)}>
					<h1 {...stylex.props(styles.title)}>Game text</h1>
					<p {...stylex.props(styles.subtitle)}>
						Find player-facing text and jump straight back to its package and property.
					</p>
				</div>
				<span {...stylex.props(styles.headerActions)}>
					<button type="button" onClick={refresh} {...stylex.props(styles.button)}>
						Rescan
					</button>
				</span>
			</header>
			<Show when={props.client.investigations}>
				{(client) => (
					<InvestigationActions
						client={client()}
						disabled={state().status !== "ready"}
						revision={[investigationRevision(), qualityDocument()]}
						query={{
							mode: mode(),
							query: query(),
							capability: capability(),
							lens: lens(),
							qualityFilter: qualityFilter()
						}}
						onOpen={restoreInvestigation}
					/>
				)}
			</Show>
			<Switch>
				<Match when={state().status === "loading"}>
					<p role="status" {...stylex.props(styles.loadingLine)}>
						Loading saved game text…
					</p>
				</Match>
				<Match when={state().status === "not_configured"}>
					<section {...stylex.props(styles.noticeCard)}>
						<strong {...stylex.props(styles.noticeTitle)}>
							No project is configured.
						</strong>
						<p {...stylex.props(styles.noticeCopy)}>
							Choose an Unreal project in the Workbench header, then rescan.
						</p>
						<button type="button" onClick={refresh} {...stylex.props(styles.button)}>
							Retry
						</button>
					</section>
				</Match>
				<Match when={state().status === "cancelled"}>
					<section {...stylex.props(styles.noticeCard)}>
						<strong {...stylex.props(styles.noticeTitle)}>
							Project selection was cancelled.
						</strong>
						<p {...stylex.props(styles.noticeCopy)}>
							Pick a project to load its saved game text.
						</p>
						<button type="button" onClick={refresh} {...stylex.props(styles.button)}>
							Retry
						</button>
					</section>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						return current.status === "failed" ? (
							<FailureCard
								title="Couldn’t load saved game text."
								detail={current.error.message}
								onRetry={refresh}
							/>
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
										Text
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
										Quality
										<Show when={qualitySummary()}>
											{(quality) => (
												<b {...stylex.props(styles.tabCount)}>
													{quality().findingCount}
												</b>
											)}
										</Show>
									</button>
								</div>
								<Show when={mode() === "quality" ? qualityFailure() : undefined}>
									{(error) => (
										<FailureCard
											title="Couldn’t load the rule file."
											detail={error().message}
											onRetry={loadQualityRules}
										/>
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
												<h2 {...stylex.props(styles.qualitySetupTitle)}>
													Quality
												</h2>
												<p {...stylex.props(styles.qualitySetupCopy)}>
													Load a rule file to check character limits and
													terminology across the saved text.
												</p>
												<button
													type="button"
													onClick={loadQualityRules}
													{...stylex.props(styles.qualityButton)}
												>
													Load rules
												</button>
											</section>
										}
									>
										{(quality) => (
											<Show when={qualityDocument()}>
												{(document) => (
													<GameTextQualityWorkspace
														filter={qualityFilter()}
														onFilterChange={setQualityFilter}
														client={props.client}
														document={document()}
														onReplaceRules={loadQualityRules}
														editor={qualityEditor}
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
			<form
				aria-label="Search game text"
				onSubmit={(event) => {
					event.preventDefault();
					props.onQuery(props.query());
				}}
				{...stylex.props(styles.queryBar)}
			>
				<input
					autofocus
					type="search"
					value={props.query()}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
					placeholder="Search source text…"
					aria-label="Search game text"
					{...stylex.props(styles.searchInput)}
				/>
				<div
					aria-label="Filter by source support"
					role="group"
					{...stylex.props(styles.filters)}
				>
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
				<select
					aria-label="Review lens"
					value={props.lens()}
					onChange={(event) => {
						const chosen = reviewLenses.find(
							(item) => item.value === event.currentTarget.value
						);
						if (chosen !== undefined) props.onLens(chosen.value);
					}}
					{...stylex.props(styles.lensSelect)}
				>
					<For each={reviewLenses}>
						{(item) => <option value={item.value}>{item.label}</option>}
					</For>
				</select>
				<button type="submit" {...stylex.props(styles.button)}>
					Search
				</button>
			</form>
			<p {...stylex.props(styles.statsLine)}>
				<span>{coverage.textUnits.toLocaleString()} identities</span>
				<span>{coverage.textOccurrences.toLocaleString()} occurrences</span>
				<span>
					{coverage.inspectedPackages}/{coverage.discoveredPackages} packages read
				</span>
				<span
					{...stylex.props(
						styles.statsState,
						props.summary.status === "complete" ? styles.complete : styles.partial
					)}
				>
					{props.summary.status === "complete" ? "Complete" : "Partial"}
				</span>
				<Show when={coverage.unsupportedTextProperties > 0}>
					<span {...stylex.props(styles.statsWarning)}>
						{coverage.unsupportedTextProperties} properties not decoded
					</span>
				</Show>
			</p>
			<div {...stylex.props(styles.grid)}>
				<section aria-label="Results" {...stylex.props(styles.results)}>
					<header {...stylex.props(styles.resultsHeader)}>
						<span {...stylex.props(styles.resultsTitle)}>Results</span>
						<b {...stylex.props(styles.headerCount)}>{props.page().total}</b>
					</header>
					<Show
						when={props.page().units.length > 0}
						fallback={
							<p {...stylex.props(styles.noMatches)}>
								No matches. Widen the search or clear filters.
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
												{unit.wordCount} words · {unit.characterCount}{" "}
												characters · {unit.occurrenceCount}{" "}
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
												{context?.title ?? "No authored context found"}
											</strong>
											<small>
												{" "}
												·{" "}
												{context?.detail ??
													"This text has no decoded source location"}
												{preview.additional > 0
													? ` · +${preview.additional}`
													: ""}
											</small>
										</span>
										<div {...stylex.props(styles.resultMeta)}>
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
															? styles.sourceEditable
															: styles.sourceReadOnly
													)}
												>
													{preview.context?.editCapability ===
													"source_editable"
														? "Source editable"
														: "Read only"}
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
														? `Open package for ${text}`
														: `Show ${unit.occurrenceCount} uses of ${text}`
												}
												{...stylex.props(styles.rowAction)}
											>
												{rowLocatePath
													? locateLabel(
															props.locateFeedback(),
															rowLocatePath,
															"Open package"
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
						<span>{coverage.textUnits.toLocaleString()} text entries</span>
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
						Select a result to see its identity, authored context, and every place it
						appears.
					</p>
				}
			>
				{(result) => (
					<>
						<header {...stylex.props(styles.focusHeader)}>
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
								<small {...stylex.props(styles.focusIdentityLabel)}>
									Unreal identity
								</small>
								<code {...stylex.props(styles.focusIdentityValue)}>
									{identityLabel(result().unit)}
								</code>
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
						<section aria-label="Occurrences" {...stylex.props(styles.occurrences)}>
							<header {...stylex.props(styles.sectionHeader)}>
								<span>Where it appears</span>
								<b {...stylex.props(styles.headerCount)}>
									{result().totalOccurrences}
								</b>
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
								aria-label="Coverage notes"
								{...stylex.props(styles.diagnostics)}
							>
								<header {...stylex.props(styles.sectionHeader)}>
									<span>Coverage notes</span>
									<b>{result().diagnostics.length}</b>
								</header>
								<For each={result().diagnostics}>
									{(diagnostic) => (
										<article {...stylex.props(styles.diagnostic)}>
											<strong {...stylex.props(styles.diagnosticTitle)}>
												{diagnostic.code.replaceAll("_", " ")}
											</strong>
											<p {...stylex.props(styles.diagnosticMessage)}>
												{diagnostic.message}
											</p>
											<code {...stylex.props(styles.diagnosticPackage)}>
												{diagnostic.packageFile}
											</code>
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
		padding: `${tokens.space5} ${tokens.space6} ${tokens.space6}`,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		backgroundColor: tokens.colorCanvas,
		backgroundImage: "none"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: tokens.space6,
		paddingBottom: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		marginBottom: tokens.space5
	},
	headerLead: { display: "flex", flexDirection: "column", gap: tokens.space1 },
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	subtitle: {
		maxWidth: 560,
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.5
	},
	button: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500,
		whiteSpace: "nowrap",
		transition: `transform ${tokens.motionFast} cubic-bezier(.23, 1, .32, 1)`,
		":active": { transform: "scale(.97)" },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 2 }
	},
	headerActions: { display: "flex", alignItems: "center", flexShrink: 0, gap: tokens.space2 },
	loadingLine: {
		minHeight: 320,
		display: "grid",
		placeItems: "center",
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	noticeCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		maxWidth: 520,
		padding: tokens.space4,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusControl
	},
	noticeTitle: { color: tokens.colorTextStrong, fontSize: 14 },
	noticeCopy: { margin: 0, color: tokens.colorTextMuted, fontSize: 13, lineHeight: 1.5 },
	failureCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		maxWidth: 520,
		padding: tokens.space4,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusControl
	},
	failureTitle: { color: tokens.colorTextStrong, fontSize: 14 },
	failureCopy: {
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.5
	},
	technicalDetails: {
		width: "100%",
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	techSummary: { cursor: "pointer", color: tokens.colorTextSubtle },
	techPre: {
		margin: `${tokens.space2} 0 0`,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		whiteSpace: "pre-wrap",
		wordBreak: "break-word"
	},
	modeTabs: {
		display: "flex",
		alignItems: "stretch",
		gap: tokens.space1,
		marginBottom: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	modeTab: {
		display: "flex",
		alignItems: "center",
		gap: tokens.space2,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: "transparent",
		borderBottomStyle: "solid",
		borderBottomWidth: 2,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 13,
		fontWeight: 500
	},
	tabCount: {
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	modeTabActive: {
		borderBottomColor: tokens.colorAccent,
		color: tokens.colorTextStrong,
		backgroundColor: "transparent"
	},
	qualitySetup: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space3,
		maxWidth: 520,
		minHeight: 240,
		margin: `${tokens.space6} auto 0`,
		padding: tokens.space5,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextMuted,
		fontSize: 13,
		lineHeight: 1.5
	},
	qualitySetupTitle: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 16,
		fontWeight: 590
	},
	qualitySetupCopy: { maxWidth: 430, margin: 0 },
	qualityButton: {
		borderColor: tokens.colorAccent,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 590
	},
	workspace: { display: "flex", flexDirection: "column", gap: tokens.space3 },
	queryBar: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: tokens.space2,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurfaceInset,
		borderRadius: tokens.radiusControl
	},
	searchInput: {
		flex: 1,
		minWidth: 220,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextStrong,
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		borderRadius: tokens.radiusControl,
		"::placeholder": { color: tokens.colorTextFaint },
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	filters: {
		display: "flex",
		gap: 2,
		padding: 2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		borderRadius: tokens.radiusControl
	},
	filterButton: {
		borderStyle: "none",
		borderWidth: 0,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		padding: `${tokens.space1} ${tokens.space2}`,
		borderRadius: tokens.radiusBadge,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		transition: `background-color ${tokens.motionFast} ease`
	},
	filterActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		fontWeight: 500
	},
	lensSelect: {
		maxWidth: 200,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 12,
		borderRadius: tokens.radiusControl
	},
	statsLine: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: tokens.space4,
		margin: 0,
		color: tokens.colorTextFaint,
		fontSize: 12
	},
	statsState: { padding: "1px 6px", borderRadius: tokens.radiusBadge, fontSize: 11 },
	complete: {
		color: tokens.colorSuccess,
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	partial: {
		color: tokens.colorWarning,
		backgroundColor: "rgba(242, 153, 74, 0.12)"
	},
	statsWarning: { color: tokens.colorWarning },
	grid: {
		display: "grid",
		gridTemplateColumns: "minmax(360px, 1fr) minmax(340px, .8fr)",
		gap: tokens.space3,
		alignItems: "start"
	},
	results: {
		display: "flex",
		flexDirection: "column",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		height: "calc(100vh - 300px)",
		minHeight: 420,
		overflow: "auto",
		borderRadius: tokens.radiusControl
	},
	resultsHeader: {
		position: "sticky",
		top: 0,
		zIndex: 2,
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space3,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		fontSize: 12
	},
	resultsTitle: { color: tokens.colorTextStrong, fontWeight: 590 },
	headerCount: {
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontWeight: 500,
		fontVariantNumeric: "tabular-nums"
	},
	resultRow: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		padding: `${tokens.space3} ${tokens.space4}`,
		textAlign: "left",
		cursor: "pointer",
		fontFamily: tokens.fontBody
	},
	resultActive: { backgroundColor: "rgba(255, 255, 255, 0.07)" },
	resultLead: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		gap: tokens.space2
	},
	resultText: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 500,
		lineHeight: 1.35,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	rowCounts: {
		flexShrink: 0,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap"
	},
	resultContext: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: tokens.colorTextMuted,
		fontSize: 12,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	resultMeta: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: tokens.space2,
		minWidth: 0
	},
	resultIdentity: {
		display: "block",
		overflow: "hidden",
		minWidth: 0,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	resultSource: {
		display: "flex",
		alignItems: "center",
		flexShrink: 0,
		gap: tokens.space1,
		fontSize: 11,
		color: tokens.colorTextFaint,
		whiteSpace: "nowrap"
	},
	sourceAuthority: {
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		fontSize: 11,
		fontWeight: 500
	},
	sourceEditable: {
		color: tokens.colorSuccess,
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	sourceReadOnly: {
		color: tokens.colorTextMuted,
		backgroundColor: "rgba(255, 255, 255, 0.05)"
	},
	signalRow: {
		display: "flex",
		flexWrap: "wrap",
		gap: tokens.space1,
		fontSize: 11
	},
	signal: {
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		color: tokens.colorWarning,
		backgroundColor: "rgba(242, 153, 74, 0.12)",
		borderColor: "rgba(242, 153, 74, 0.25)",
		borderStyle: "solid",
		borderWidth: 1
	},
	rowActions: {
		display: "flex",
		justifyContent: "flex-start",
		gap: tokens.space1,
		marginTop: tokens.space1,
		whiteSpace: "nowrap"
	},
	rowAction: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceRaised },
		color: tokens.colorTextMuted,
		minWidth: 0,
		padding: "3px 7px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		lineHeight: 1.4,
		opacity: { default: 1, ":disabled": 0.5 },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	rowActionSuccess: {
		color: tokens.colorSuccess,
		borderColor: "rgba(76, 183, 130, 0.45)",
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	rowActionFailure: {
		color: tokens.colorDanger,
		borderColor: "rgba(235, 87, 87, 0.45)",
		backgroundColor: "rgba(235, 87, 87, 0.1)"
	},
	noMatches: {
		padding: tokens.space6,
		color: tokens.colorTextMuted,
		textAlign: "center",
		fontSize: 12
	},
	nextPage: {
		borderStyle: "none",
		borderWidth: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceInset },
		color: tokens.colorTextMuted,
		padding: tokens.space3,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12
	},
	resultsFooter: {
		position: "sticky",
		bottom: 0,
		display: "flex",
		justifyContent: "space-between",
		marginTop: "auto",
		padding: `${tokens.space2} ${tokens.space4}`,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	focus: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: tokens.colorSurface,
		height: "calc(100vh - 300px)",
		minHeight: 420,
		overflow: "auto",
		borderRadius: tokens.radiusControl
	},
	focusEmpty: {
		padding: tokens.space4,
		color: tokens.colorTextMuted,
		fontSize: 12,
		lineHeight: 1.6
	},
	focusHeader: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		padding: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	focusQuote: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 17,
		fontWeight: 590,
		lineHeight: 1.3,
		letterSpacing: "-0.01em"
	},
	focusMeta: {
		display: "flex",
		flexWrap: "wrap",
		gap: tokens.space3,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	focusIdentity: {
		display: "grid",
		gridTemplateColumns: "110px minmax(0, 1fr)",
		alignItems: "baseline",
		gap: tokens.space2,
		paddingTop: tokens.space2,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1
	},
	focusIdentityLabel: { color: tokens.colorTextSubtle, fontSize: 11 },
	focusIdentityValue: {
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	focusSignals: {
		display: "flex",
		flexWrap: "wrap",
		gap: tokens.space1,
		fontSize: 11
	},
	occurrences: {
		display: "flex",
		flexDirection: "column",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	diagnostics: {
		display: "flex",
		flexDirection: "column",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	sectionHeader: {
		position: "sticky",
		top: 0,
		zIndex: 1,
		display: "flex",
		justifyContent: "space-between",
		padding: `${tokens.space2} ${tokens.space4}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	occurrence: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		padding: tokens.space3,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		fontSize: 12
	},
	occurrenceHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "start",
		gap: tokens.space3
	},
	occurrenceActions: {
		display: "flex",
		alignItems: "center",
		flexShrink: 0,
		gap: tokens.space2
	},
	contextIdentity: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		minWidth: 0
	},
	contextKind: { color: tokens.colorTextFaint, fontSize: 11 },
	contextTitle: { color: tokens.colorText, fontWeight: 500 },
	contextDetail: {
		color: tokens.colorTextMuted,
		fontSize: 11,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	authority: {
		flexShrink: 0,
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		fontSize: 11
	},
	editable: {
		color: tokens.colorSuccess,
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	readOnly: {
		color: tokens.colorTextMuted,
		backgroundColor: "rgba(255, 255, 255, 0.05)"
	},
	locateButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "3px 8px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 11,
		opacity: { default: 1, ":disabled": 0.5 },
		":focus-visible": { outline: `2px solid ${tokens.colorAccent}`, outlineOffset: 1 }
	},
	locateMessage: {
		margin: 0,
		padding: tokens.space2,
		borderColor: "rgba(235, 87, 87, 0.4)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		color: tokens.colorDanger,
		fontSize: 11,
		lineHeight: 1.45
	},
	objectPath: {
		display: "block",
		overflow: "hidden",
		marginTop: tokens.space1,
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	packageFile: {
		display: "block",
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	sourceDetails: {
		marginTop: 0,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		paddingTop: tokens.space1,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	detailsSummary: { cursor: "pointer", color: tokens.colorTextSubtle },
	diagnostic: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		padding: `${tokens.space2} ${tokens.space4}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	diagnosticTitle: { color: tokens.colorWarning, textTransform: "capitalize" },
	diagnosticMessage: {
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.45
	},
	diagnosticPackage: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	}
});

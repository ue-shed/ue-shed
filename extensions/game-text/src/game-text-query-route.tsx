import * as stylex from "@stylexjs/stylex";
import {
	textLocationLabel,
	textCountLabel,
	textReviewSignalLabel,
	type GameTextInvestigationPreset,
	type TextCorpusFocus,
	type TextCorpusQueryRunResult,
	type TextCorpusQuerySummary,
	type TextCorpusSearchPage,
	type TextCorpusSearchRequest,
	type TextOccurrence,
	type TextQualityFindingId,
	type TextQualityFilter,
	type TextQualityQueryRunResult,
	type TextQualityQuerySummary,
	type GameTextRuleDocument,
	type TextQualityRuleUpdateResult,
	type TextUnitId
} from "@ue-shed/game-text/browser";
import { Button, Chip, createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { InvestigationActions } from "@ue-shed/ui/investigation-actions";
import { TaskProgressModal, type TaskProgress } from "@ue-shed/ui/task-progress";
import { Effect, Schedule, Stream } from "effect";
import { For, Show, createEffect, createSignal, onSettled, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { GameTextClientApi } from "./game-text-client.js";
import { CopyButton } from "./game-text-copy-button.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { ReadProblems, CoverageNotes } from "./game-text-read-problems.js";
import { GameTextQualityWorkspace } from "./game-text-quality-workspace.js";
import { GameTextLocalizationQuality } from "./game-text-localization-quality.js";
import { GameTextReports } from "./game-text-reports.js";
import { createGameTextRuleState } from "./game-text-rule-state.js";
import {
	readGameTextPreferences,
	saveGameTextPreferences,
	type GameTextPreferences
} from "./game-text-preferences.js";
import { createGameTextLocalizationState } from "./game-text-localization-state.js";
import {
	createGameTextEdits,
	StagedEditsButton,
	StagedEditsPanel
} from "./game-text-translation-edits.js";
import {
	LocalizationControls,
	LocalizationChips,
	ReviewChips,
	TranslationsDetail,
	GatheredDetail
} from "./game-text-localization-view.js";
import { GameTextResultRows } from "./game-text-result-rows.js";
import {
	createGameTextOperations,
	OperationPanel,
	SyncWithUnreal,
	UnrealSteps
} from "./game-text-operations.js";
import { identityLabel, locationDetail, sourceText } from "./game-text-view.js";
import { styles } from "./game-text-styles.js";

export { CopyButton } from "./game-text-copy-button.js";
export type { GameTextPreferences } from "./game-text-preferences.js";

const lenses = [
	{ value: "all", label: "All text" },
	{ value: "shared", label: "Used in several places" },
	{ value: "duplicate_source", label: "Same text, different keys" },
	{ value: "long", label: "Long text" },
	{ value: "unresolved", label: "Not localizable" },
	{ value: "conflicting", label: "Same key, different text" }
] as const;

function scanTime(value: string | undefined): string {
	if (!value) return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	const today = date.toDateString() === new Date().toDateString();
	return (
		(today ? "" : date.toLocaleDateString() + " ") +
		date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
	);
}

function focusStats(focus: TextCorpusFocus): string {
	return [
		textCountLabel(focus.unit.characterCount, "character"),
		textCountLabel(focus.unit.wordCount, "word"),
		textCountLabel(focus.totalOccurrences, "location")
	].join(" · ");
}

export function GameTextRoute(props: {
	readonly client: GameTextClientApi;
	readonly initialPreferences?: GameTextPreferences | undefined;
	readonly onPreferencesChange?: (preferences: GameTextPreferences) => void;
	readonly projectKey?: string | undefined;
	readonly onOpenDataAuthoring?: (objectPath: string) => void;
}) {
	const initial = untrack(() => props.initialPreferences);
	const [query, setQuery] = createSignal(initial?.query ?? "");
	const [capability, setCapability] = createSignal(initial?.capability ?? "all");
	const [lens, setLens] = createSignal(initial?.lens ?? "all");
	const [withoutNotes, setWithoutNotes] = createSignal(initial?.withoutNotes ?? false);
	const [mode, setMode] = createSignal<"corpus" | "quality" | "reports">(
		initial?.mode ?? "corpus"
	);
	const [qualityFilter, setQualityFilter] = createSignal(initial?.qualityFilter ?? "all");
	const [selectedId, setSelectedId] = createSignal<TextUnitId | undefined>(initial?.selectedId);
	const [selectedFindingId, setSelectedFindingId] = createSignal<
		TextQualityFindingId | undefined
	>(initial?.selectedFindingId);
	const [summary, setSummary] = createSignal<TextCorpusQuerySummary>();
	const [page, setPage] = createSignal<TextCorpusSearchPage>();
	const [focus, setFocus] = createSignal<TextCorpusFocus>();
	const [searching, setSearching] = createSignal(true);
	const [loading, setLoading] = createSignal(true);
	const [memoryReady, setMemoryReady] = createSignal(false);
	const [projectKey, setProjectKey] = createSignal(untrack(() => props.projectKey));
	const [error, setError] = createSignal<string>();
	const [scanNotice, setScanNotice] = createSignal<string>();
	const [qualityFailure, setQualityFailure] =
		createSignal<Extract<TextQualityQueryRunResult, { status: "failed" }>["error"]>();
	const [workspaceFindingCount, setWorkspaceFindingCount] = createSignal<number>();
	const workspaceCountAction = createEffectAction();
	const sourceFilter = (): TextQualityFilter =>
		qualityFilter() === "character_budget"
			? "character_budget"
			: qualityFilter() === "terminology"
				? "terminology"
				: "all";
	const [qualitySummary, setQualitySummary] = createSignal<TextQualityQuerySummary>();
	const qualityTabCount = () =>
		localization.target() && props.client.localizationQualitySearch
			? workspaceFindingCount()
			: qualitySummary()?.findingCount;
	const [qualityDocument, setQualityDocument] = createSignal<GameTextRuleDocument | undefined>(
		initial?.qualityDocument
	);
	const [progress, setProgress] = createSignal<TaskProgress>({
		completed: 0,
		total: 0,
		phase: "idle",
		stage: "game_text"
	});
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const refreshAction = createEffectAction();
	const qualityAction = createEffectAction();
	const memoryAction = createEffectAction();
	const persistAction = createEffectAction();
	const progressSubscription = createEffectSubscription();
	let searchGeneration = 0;
	let focusGeneration = 0;
	const localization = createGameTextLocalizationState({
		client: props.client,
		initial,
		summary,
		selectedUnit: selectedId,
		onPending: () => {
			searchGeneration++;
			searchAction.cancel();
			setSearching(true);
			setPage(undefined);
		}
	});
	const operations = createGameTextOperations({
		client: props.client,
		target: localization.target,
		scanning: loading,
		revision: summary,
		onCompleted: () => load(false)
	});
	const edits = createGameTextEdits({
		client: props.client,
		target: localization.target,
		nativeCulture: () => localization.active()?.target.nativeCulture ?? undefined,
		busy: () => loading() || operations.busy(),
		onWritten: () => load(false)
	});
	const editor = createGameTextRuleState({
		client: props.client,
		initialState:
			initial?.qualityEditor ??
			(initial?.qualityDocument
				? {
						draft: initial.qualityDocument,
						savedDocument: initial.qualityDocument
					}
				: undefined),
		onReviewed: (result) => {
			setQualityFailure(undefined);
			setQualityDocument(result.document);
			setQualitySummary(result.summary);
		}
	});

	const requestFocus = (id: TextUnitId, cursor?: TextCorpusFocus["nextOccurrenceCursor"]) => {
		const generation = ++focusGeneration;
		focusAction.run(
			props.client.focus({
				id,
				pageSize: 50,
				...(cursor ? { occurrenceCursor: cursor } : undefined)
			}),
			{
				onFailure: (cause) => {
					if (generation === focusGeneration) setError(String(cause));
				},
				onSuccess: (result) => {
					if (generation !== focusGeneration) return;
					if (result.status === "found") {
						setFocus((previous) =>
							cursor && previous?.unit.id === id
								? {
										...result.focus,
										occurrences: [
											...previous.occurrences,
											...result.focus.occurrences
										]
									}
								: result.focus
						);
					} else {
						setFocus(undefined);
						if (result.status === "not_found") setSelectedId(undefined);
					}
				}
			}
		);
	};

	const searchRequest = (): TextCorpusSearchRequest => {
		const selected = localization.selection();
		return {
			query: query(),
			capability: capability(),
			lens: lens(),
			withoutNotes: withoutNotes(),
			...(selected ? { localization: selected } : undefined),
			pageSize: 50
		};
	};
	const moreResults = () => {
		const current = untrack(page);
		const request = searchRequest();
		if (current?.localization?.nextCursor)
			requestPage({ ...request, localizationCursor: current.localization.nextCursor });
		else if (current?.nextCursor) requestPage({ ...request, cursor: current.nextCursor });
	};
	const requestPage = (request: TextCorpusSearchRequest, debounce = false) => {
		const generation = ++searchGeneration;
		setError(undefined);
		setSearching(true);
		searchAction.run(
			(debounce ? Effect.sleep("120 millis") : Effect.void).pipe(
				Effect.flatMap(() => props.client.search(request))
			),
			{
				onFailure: (cause) => {
					if (generation === searchGeneration) {
						setSearching(false);
						setPage(undefined);
						setError(String(cause));
					}
				},
				onSuccess: (result) => {
					if (generation !== searchGeneration) return;
					if (result.status === "ready") {
						setPage((previous) =>
							(request.cursor || request.localizationCursor) && previous
								? {
										...result.page,
										units: [...previous.units, ...result.page.units],
										...(result.page.localization && previous.localization
											? {
													localization: {
														...result.page.localization,
														lines: [
															...previous.localization.lines,
															...result.page.localization.lines
														]
													}
												}
											: undefined)
									}
								: result.page
						);
						setSearching(false);
					} else {
						setPage(undefined);
						setSearching(false);
						setError("The saved assets changed. Rescan the project to search again.");
					}
				}
			}
		);
	};

	const applyQuality = (result: TextQualityQueryRunResult | TextQualityRuleUpdateResult) => {
		if (result.status === "completed") {
			setQualityFailure(undefined);
			setQualityDocument(result.document);
			setQualitySummary(result.summary);
			editor.replace(result.document);
		} else if (result.status === "failed") setQualityFailure(result.error);
	};

	const load = (refresh: boolean, choose = false) => {
		setLoading(true);
		setError(undefined);
		setScanNotice(undefined);
		setProgress({ completed: 0, total: 0, phase: "idle", stage: "game_text" });
		progressSubscription.subscribe(
			Stream.fromEffectSchedule(props.client.progress(), Schedule.spaced("100 millis")),
			{ onValue: setProgress }
		);
		refreshAction.run(
			choose
				? props.client.chooseProjectAndScan()
				: props.client.loadConfiguredProject(refresh),
			{
				onFailure: (cause) => {
					progressSubscription.cancel();
					setLoading(false);
					setError(String(cause));
				},
				onSuccess: (result: TextCorpusQueryRunResult) => {
					progressSubscription.cancel();
					setLoading(false);
					if (result.status === "completed") {
						localization.load();
						setSummary(result.summary);
						if (!untrack(projectKey) && props.client.projectKey) {
							memoryAction.run(props.client.projectKey(), {
								onSuccess: setProjectKey
							});
						}
					} else if (result.status === "failed") {
						setError(result.error.message + " " + result.error.recovery);
					} else if (result.status === "cancelled") {
						setScanNotice("Project selection was cancelled. Choose a project to scan.");
					}
				}
			}
		);
	};

	const restore = (preferences: GameTextPreferences) => {
		focusGeneration++;
		setFocus(undefined);
		setQualitySummary(undefined);
		setQualityFailure(undefined);
		localization.restore(preferences);
		setQuery(preferences.query);
		setCapability(preferences.capability);
		setLens(preferences.lens);
		setWithoutNotes(preferences.withoutNotes ?? false);
		setMode(preferences.mode ?? "corpus");
		setQualityFilter(preferences.qualityFilter ?? "all");
		setSelectedId(preferences.selectedId);
		setSelectedFindingId(preferences.selectedFindingId);
		setQualityDocument(preferences.qualityDocument);
		editor.replace(preferences.qualityDocument);
	};

	// Requests consume committed state, including preferences restored during the first load.
	createEffect(
		() => ({
			summary: summary(),
			request: searchRequest(),
			ready: localization.ready(),
			loading: loading()
		}),
		({ summary: current, request, ready, loading: busy }) => {
			if (current && ready && !busy) requestPage(request, true);
		}
	);
	createEffect(
		() => ({ summary: summary(), id: selectedId() }),
		({ summary: current, id }) => {
			if (current && id) requestFocus(id);
			else {
				focusGeneration++;
				focusAction.cancel();
				setFocus(undefined);
			}
		}
	);
	createEffect(
		() => ({ summary: summary(), document: qualityDocument() }),
		({ summary: current, document }) => {
			if (!current || !document) return;
			qualityAction.run(props.client.previewQualityRules(document), {
				onSuccess: (reviewed) => {
					if (reviewed.status === "completed") {
						setQualityFailure(undefined);
						setQualitySummary(reviewed.summary);
					} else applyQuality(reviewed);
				},
				onFailure: (cause) => setError(String(cause))
			});
		}
	);

	createEffect(
		() => ({
			ready: memoryReady(),
			key: projectKey(),
			preferences: {
				query: query(),
				capability: capability(),
				lens: lens(),
				withoutNotes: withoutNotes(),
				mode: mode(),
				qualityFilter: qualityFilter(),
				selectedId: selectedId(),
				selectedFindingId: selectedFindingId(),
				qualityDocument: qualityDocument(),
				qualityEditor: editor.state(),
				localizationTarget: localization.target(),
				localizationCulture: localization.culture(),
				localizationState: localization.state(),
				localizationReview: localization.review(),
				searchTranslations: localization.searchTranslations(),
				selectedLocalizationId: localization.selectedId()
			}
		}),
		({ ready, key, preferences }) => {
			if (!ready) return;
			props.onPreferencesChange?.(preferences);
			if (key)
				persistAction.run(saveGameTextPreferences(key, preferences), {
					onSuccess: () => undefined
				});
		}
	);

	onSettled(() => {
		memoryAction.run(
			Effect.gen(function* () {
				const key =
					props.projectKey ??
					(props.client.projectKey ? yield* props.client.projectKey() : undefined);
				const preferences = key ? yield* readGameTextPreferences(key) : undefined;
				return { key, preferences };
			}),
			{
				onSuccess: ({ key, preferences }) => {
					setProjectKey(key);
					if (!initial && preferences) restore(preferences);
					setMemoryReady(true);
					load(false);
				},
				onFailure: () => {
					setMemoryReady(true);
					load(false);
				}
			}
		);
	});

	const loadRules = (create?: boolean) => {
		setQualityFailure(undefined);
		const operation =
			create === undefined
				? props.client.chooseQualityRules()
				: props.client.createStarterRules?.(create);
		if (!operation) return;
		qualityAction.run(operation, {
			onSuccess: applyQuality,
			onFailure: (cause) => setError(String(cause))
		});
	};
	const reloadRules = () => {
		setQualityFailure(undefined);
		qualityAction.run(
			props.client.reloadQualityRules?.() ?? props.client.chooseQualityRules(),
			{
				onSuccess: applyQuality,
				onFailure: (cause) => setError(String(cause))
			}
		);
	};
	const restorePreset = (preset: GameTextInvestigationPreset) => {
		restore({
			...preset.query,
			withoutNotes: preset.query.withoutNotes ?? false,
			lens: preset.query.lens ?? "all",
			selectedId: undefined,
			qualityDocument: preset.rules
		});
		load(false);
	};
	createEffect(
		() => ({
			active: localization.active(),
			culture: localization.culture(),
			document: qualityDocument(),
			summary: qualitySummary()
		}),
		({ active, culture }) => {
			workspaceCountAction.cancel();
			setWorkspaceFindingCount(undefined);
			if (!active || !props.client.localizationQualitySearch) return;
			workspaceCountAction.run(
				props.client.localizationQualitySearch({
					target: active.target.name,
					filter: "all",
					...(culture ? { culture } : undefined)
				}),
				{
					onSuccess: (result) => {
						if (result.status === "ready") setWorkspaceFindingCount(result.page.total);
					}
				}
			);
		}
	);
	createEffect(
		() => ({ ready: localization.ready(), active: localization.active(), mode: mode() }),
		(state) => {
			if (state.ready && !state.active && state.mode === "reports") setMode("corpus");
		}
	);
	const exports = (): JSX.Element => (
		<Show when={props.client.investigations}>
			{(client) => (
				<div {...stylex.attrs(styles.exports)}>
					<InvestigationActions
						compact
						blocked={operations.busy()}
						client={client()}
						disabled={
							!summary() || (mode() === "corpus" ? searching() : !qualitySummary())
						}
						revision={[summary(), qualitySummary()]}
						query={{
							mode: mode() === "quality" ? "quality" : "corpus",
							query: query(),
							capability: capability(),
							lens: lens(),
							withoutNotes: withoutNotes(),
							qualityFilter: sourceFilter()
						}}
						onOpen={restorePreset}
					/>
				</div>
			)}
		</Show>
	);

	const rulesSetup = () => (
		<section aria-label="Quality rules setup" {...stylex.attrs(styles.card)}>
			<p>
				<strong>Set up writing checks</strong> with a rules file for character limits and
				terminology. The starter file contains examples you can customize.
			</p>
			<Show when={qualityFailure()}>
				{(issue) => (
					<p role="alert">
						{issue().message} {issue().recovery}
					</p>
				)}
			</Show>
			<div {...stylex.attrs(styles.bar)}>
				<Show when={props.client.createStarterRules}>
					<Button
						tone="primary"
						disabled={operations.busy()}
						onClick={() => loadRules(false)}
					>
						Create rules file
					</Button>
				</Show>
				<Show when={qualityFailure()?.code === "already_exists"}>
					<Button disabled={operations.busy()} onClick={() => loadRules(true)}>
						Load existing rules
					</Button>
				</Show>
				<Button disabled={operations.busy()} onClick={() => loadRules()}>
					Load rules
				</Button>
			</div>
		</section>
	);
	return (
		<main {...stylex.attrs(styles.page)}>
			<TaskProgressModal
				open={loading() && progress().phase !== "idle"}
				progress={progress()}
				title="Scanning saved game text"
				detail="Reading the project's saved assets."
			/>
			<div {...stylex.attrs(styles.toolbar)}>
				<div role="tablist" aria-label="Game Text view" {...stylex.attrs(styles.bar)}>
					<button
						type="button"
						role="tab"
						aria-selected={mode() === "corpus" ? "true" : "false"}
						onClick={() => setMode("corpus")}
						{...stylex.attrs(styles.button, mode() === "corpus" && styles.selected)}
					>
						Text
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode() === "quality" ? "true" : "false"}
						onClick={() => setMode("quality")}
						{...stylex.attrs(styles.button, mode() === "quality" && styles.selected)}
					>
						Quality checks
						{qualityFailure()?.code === "invalid_rules"
							? " (rules invalid)"
							: qualityTabCount() !== undefined
								? " (" + qualityTabCount() + ")"
								: ""}
					</button>
					<Show when={localization.active()}>
						<button
							type="button"
							role="tab"
							aria-selected={mode() === "reports" ? "true" : "false"}
							onClick={() => setMode("reports")}
							{...stylex.attrs(
								styles.button,
								mode() === "reports" && styles.selected
							)}
						>
							Reports
						</button>
					</Show>
				</div>
				<LocalizationControls
					model={localization}
					disabled={operations.busy()}
					syncAction={
						<SyncWithUnreal
							model={operations}
							pending={localization.active()?.notSynced ?? 0}
						/>
					}
				/>
				<StagedEditsButton model={edits} />
				<UnrealSteps model={operations} />
				<Show when={summary()}>
					{(current) => (
						<span {...stylex.attrs(styles.coverage)}>
							<Show
								when={localization.ready()}
								fallback={
									<span role="status">
										{localization.error()
											? "Translations unavailable"
											: "Loading translations…"}
									</span>
								}
							>
								<b>
									{(
										localization.active()?.lines ?? current().counts.all
									).toLocaleString()}
								</b>{" "}
								{(localization.active()?.lines ?? current().counts.all) === 1
									? "line"
									: "lines"}{" "}
								{localization.active() ? "· " : "in "}
							</Show>
							<b>{current().coverage.inspectedPackages.toLocaleString()}</b>{" "}
							{current().coverage.inspectedPackages === 1 ? "asset" : "assets"}
							<Show when={current().scannedAt}>
								{" "}
								· scanned {scanTime(current().scannedAt)}
							</Show>
							<ReadProblems summary={current()} />
						</span>
					)}
				</Show>
				<Show when={summary()}>
					<Button
						size="compact"
						disabled={loading() || operations.busy()}
						title={operations.reason()}
						onClick={() => load(true)}
					>
						Rescan
					</Button>
				</Show>
			</div>
			<OperationPanel model={operations} />
			<StagedEditsPanel model={edits} />
			<Show when={localization.error()}>
				<p role="alert" {...stylex.attrs(styles.problemMessage)}>
					{localization.error()}
				</p>
			</Show>
			<Show when={scanNotice()}>
				<p role="status" {...stylex.attrs(styles.problemMessage)}>
					{scanNotice()}
				</p>
			</Show>
			<Show when={error()}>
				{(message) => (
					<div role="alert" {...stylex.attrs(styles.card)}>
						{message()}
						<Button onClick={() => load(true)}>Retry</Button>
					</div>
				)}
			</Show>
			<Show when={mode() === "quality" && qualitySummary() && qualityFailure()}>
				<p role="alert" {...stylex.attrs(styles.card)}>
					{qualityFailure()?.message} {qualityFailure()?.recovery}
					<Button onClick={() => loadRules()}>Load rules</Button>
				</p>
			</Show>
			<Show
				when={summary()}
				fallback={
					<div {...stylex.attrs(styles.empty)}>
						<Show
							when={!loading()}
							fallback={<span role="status">Loading saved game text…</span>}
						>
							<p>
								Game Text reads the project's saved assets, so Unreal does not need
								to be running.
							</p>
							<Button tone="primary" onClick={() => load(true, !projectKey())}>
								Scan project
							</Button>
						</Show>
					</div>
				}
			>
				<Show
					when={mode() !== "reports"}
					fallback={
						<Show
							when={localization.ready()}
							fallback={
								<p role="status" {...stylex.attrs(styles.empty)}>
									Loading translations…
								</p>
							}
						>
							<Show when={localization.target()}>
								{(target) => (
									<GameTextReports
										disabled={operations.busy()}
										client={props.client}
										target={target()}
										revision={summary()}
									/>
								)}
							</Show>
						</Show>
					}
				>
					<Show
						when={mode() === "corpus"}
						fallback={
							<Show
								when={
									localization.target() && props.client.localizationQualitySearch
								}
								fallback={
									<Show when={qualitySummary()} fallback={rulesSetup()}>
										{(quality) => (
											<Show when={qualityDocument()}>
												{(document) => (
													<GameTextQualityWorkspace
														disabled={operations.busy()}
														client={props.client}
														summary={quality()}
														document={document()}
														editor={editor}
														filter={sourceFilter()}
														onFilterChange={setQualityFilter}
														onReplaceRules={reloadRules}
														onLoadRules={() => loadRules()}
														selectedId={selectedFindingId()}
														onSelectionChange={setSelectedFindingId}
														exports={exports()}
														onShowText={(id) => {
															localization.setSelectedId(undefined);
															setSelectedId(id);
															setMode("corpus");
														}}
													/>
												)}
											</Show>
										)}
									</Show>
								}
							>
								<Show
									when={localization.ready()}
									fallback={
										<p role="status" {...stylex.attrs(styles.empty)}>
											Loading translations…
										</p>
									}
								>
									<GameTextLocalizationQuality
										disabled={operations.busy()}
										client={props.client}
										localization={localization}
										summary={qualitySummary()}
										document={qualityDocument()}
										editor={editor}
										setup={rulesSetup()}
										exports={exports()}
										filter={qualityFilter()}
										onFilterChange={setQualityFilter}
										selectedId={selectedFindingId()}
										onSelectionChange={setSelectedFindingId}
										onLoadRules={() => loadRules()}
										onReloadRules={reloadRules}
										onShowText={(id) => {
											localization.setSelectedId(undefined);
											setSelectedId(id);
											setMode("corpus");
										}}
									/>
								</Show>
							</Show>
						}
					>
						<div {...stylex.attrs(styles.workspace)}>
							<div {...stylex.attrs(styles.bar)}>
								<div {...stylex.attrs(styles.search)}>
									<svg
										aria-hidden="true"
										viewBox="0 0 24 24"
										{...stylex.attrs(styles.searchIcon)}
									>
										<circle cx="10" cy="10" r="6" />
										<path d="M15 15 L21 21" />
									</svg>
									<input
										autofocus
										type="search"
										aria-label="Search game text"
										placeholder={
											localization.culture() &&
											localization.searchTranslations()
												? "Search text and translations"
												: "Search text"
										}
										maxlength={512}
										disabled={loading()}
										value={query()}
										{...stylex.attrs(styles.input)}
										onInput={(event) => setQuery(event.currentTarget.value)}
										onKeyDown={(event) => {
											if (event.key === "Enter" && localization.ready())
												requestPage(searchRequest());
										}}
									/>
									<span role="status" {...stylex.attrs(styles.count)}>
										{localization.error() && !localization.ready()
											? "Translations unavailable"
											: searching() || !page()
												? "Searching…"
												: page()?.total === 1
													? "1 match"
													: page()?.total.toLocaleString() + " matches"}
									</span>
								</div>
								<Show when={localization.active() && localization.culture()}>
									<Chip
										label="Search translations"
										toggle
										selected={localization.searchTranslations()}
										onClick={() =>
											localization.setSearchTranslations(
												!localization.searchTranslations()
											)
										}
									/>
								</Show>
								<Chip
									label="Editable"
									toggle
									disabled={loading()}
									selected={capability() === "source_editable"}
									count={searching() ? undefined : page()?.counts.editable}
									onClick={() => {
										const next =
											capability() === "source_editable"
												? "all"
												: "source_editable";
										setCapability(next);
									}}
								/>
								<Chip
									label="Read only"
									toggle
									disabled={loading()}
									selected={capability() === "read_only"}
									count={searching() ? undefined : page()?.counts.readOnly}
									onClick={() => {
										const next =
											capability() === "read_only" ? "all" : "read_only";
										setCapability(next);
									}}
								/>
								<Chip
									label="No translator notes"
									toggle
									disabled={loading()}
									selected={withoutNotes()}
									count={searching() ? undefined : page()?.counts.withoutNotes}
									onClick={() => {
										const next = !withoutNotes();
										setWithoutNotes(next);
									}}
								/>
							</div>
							<div {...stylex.attrs(styles.bar)}>
								<For
									each={lenses.filter(
										(item) =>
											item.value === "all" ||
											item.value === lens() ||
											(page()?.counts[item.value] ?? 0) > 0
									)}
								>
									{(item) => (
										<Chip
											label={item.label}
											disabled={loading()}
											count={
												searching() ? undefined : page()?.counts[item.value]
											}
											selected={lens() === item.value}
											onClick={() => {
												setLens(item.value);
											}}
										/>
									)}
								</For>
								<Show
									when={
										!searching() &&
										page() &&
										lens() === "all" &&
										lenses
											.slice(1)
											.every((item) => page()?.counts[item.value] === 0)
									}
								>
									<span {...stylex.attrs(styles.muted)}>
										Nothing reused, duplicated, too long or unlocalizable
									</span>
								</Show>
								<LocalizationChips
									model={localization}
									counts={page()?.localization?.stateCounts}
									searching={searching()}
								/>
								<ReviewChips
									model={localization}
									counts={page()?.localization?.reviewCounts}
									searching={searching()}
								/>
								{exports()}
							</div>
							<div {...stylex.attrs(styles.grid)}>
								<section aria-label="Results" {...stylex.attrs(styles.pane)}>
									<GameTextResultRows
										page={page()}
										culture={localization.culture()}
										selectedId={selectedId()}
										selectedLocalizationId={localization.selectedId()}
										onSelect={(unit, line) => {
											setSelectedId(unit);
											localization.setSelectedId(line);
										}}
									/>
									<Show
										when={
											localization.ready() &&
											!searching() &&
											page()?.total === 0
										}
									>
										<p {...stylex.attrs(styles.empty)}>
											No text matches these filters.
										</p>
									</Show>
									<Show
										when={
											page()?.localization?.nextCursor ?? page()?.nextCursor
										}
									>
										<Button disabled={searching()} onClick={moreResults}>
											Show{" "}
											{Math.min(
												50,
												(page()?.total ?? 0) -
													(page()?.localization?.lines.length ??
														page()?.units.length ??
														0)
											)}{" "}
											more
										</Button>
									</Show>
								</section>
								<aside aria-label="Text focus" {...stylex.attrs(styles.pane)}>
									<Show
										when={focus()}
										fallback={
											<Show
												when={
													localization.detail()?.origin.kind ===
													"evidence"
														? localization.detail()
														: undefined
												}
												fallback={
													<p {...stylex.attrs(styles.empty)}>
														{localization.detailLoading()
															? "Loading translations…"
															: "Select a line to see its key, translator notes and every place it appears."}
													</p>
												}
											>
												{(gathered) => (
													<div {...stylex.attrs(styles.detail)}>
														<GatheredDetail focus={gathered()} />
														<TranslationsDetail
															model={localization}
															edits={edits}
															review={{
																client: props.client,
																busy:
																	loading() || operations.busy(),
																onChanged: () => load(false)
															}}
														/>
													</div>
												)}
											</Show>
										}
									>
										{(current) => (
											<div {...stylex.attrs(styles.detail)}>
												<div {...stylex.attrs(styles.bar)}>
													<h2 {...stylex.attrs(styles.title)}>
														{sourceText(current().unit)}
													</h2>
													<CopyButton
														label="Copy text"
														value={sourceText(current().unit)}
													/>
												</div>
												<div {...stylex.attrs(styles.bar)}>
													<code {...stylex.attrs(styles.mono)}>
														{identityLabel(current().unit)}
													</code>
													<Show
														when={
															current().unit.identity.status !==
															"unresolved"
														}
													>
														<CopyButton
															label="Copy key"
															value={identityLabel(current().unit)}
														/>
													</Show>
												</div>
												<span {...stylex.attrs(styles.muted)}>
													{focusStats(current())}
												</span>
												<Show
													when={current().unit.reviewSignals.some(
														(signal) => signal !== "evidence_only"
													)}
												>
													<span {...stylex.attrs(styles.warning)}>
														{current()
															.unit.reviewSignals.filter(
																(signal) =>
																	signal !== "evidence_only"
															)
															.map(textReviewSignalLabel)
															.join(" · ")}
													</span>
												</Show>
												<h3 {...stylex.attrs(styles.section)}>
													Where it appears
												</h3>
												<For each={current().occurrences}>
													{(occurrence) => (
														<OccurrenceCard
															client={props.client}
															occurrence={occurrence}
															conflicting={
																current().unit.source.status ===
																"conflicting"
															}
															onOpenDataAuthoring={
																props.onOpenDataAuthoring
															}
														/>
													)}
												</For>
												<TranslationsDetail
													model={localization}
													edits={edits}
													review={{
														client: props.client,
														busy: loading() || operations.busy(),
														onChanged: () => load(false)
													}}
												/>
												<CoverageNotes
													diagnostics={current().diagnostics}
												/>
												<Show when={current().nextOccurrenceCursor}>
													{(cursor) => (
														<Button
															onClick={() =>
																requestFocus(
																	current().unit.id,
																	cursor()
																)
															}
														>
															Show{" "}
															{textCountLabel(
																Math.min(
																	50,
																	current().totalOccurrences -
																		current().occurrences.length
																),
																"more location"
															)}
														</Button>
													)}
												</Show>
											</div>
										)}
									</Show>
								</aside>
							</div>
						</div>
					</Show>
				</Show>
			</Show>
		</main>
	);
}

export function OccurrenceCard(props: {
	readonly client: Pick<GameTextClientApi, "locateAsset">;
	readonly occurrence: TextOccurrence;
	readonly conflicting: boolean;
	readonly onOpenDataAuthoring?: ((objectPath: string) => void) | undefined;
}) {
	return (
		<article {...stylex.attrs(styles.card)}>
			<div {...stylex.attrs(styles.toolbar)}>
				<strong>{textLocationLabel(props.occurrence.location)}</strong>
				<span {...stylex.attrs(styles.coverage)}>
					{props.occurrence.editCapability === "source_editable"
						? "Editable"
						: "Read only"}
				</span>
			</div>
			<code {...stylex.attrs(styles.mono)}>{props.occurrence.location.objectPath}</code>
			<span {...stylex.attrs(styles.muted)}>{locationDetail(props.occurrence.location)}</span>
			<Show when={props.conflicting}>
				<p {...stylex.attrs(styles.notes)}>{props.occurrence.source}</p>
			</Show>
			<Show
				when={props.occurrence.devNotes.trim()}
				fallback={<span {...stylex.attrs(styles.muted)}>No translator notes</span>}
			>
				<p {...stylex.attrs(styles.notes)}>{props.occurrence.devNotes}</p>
			</Show>
			<details>
				<summary {...stylex.attrs(styles.muted)}>Saved file</summary>
				<code {...stylex.attrs(styles.mono)}>{props.occurrence.packageFile}</code>
			</details>
			<div {...stylex.attrs(styles.bar)}>
				<CopyButton label="Copy asset path" value={props.occurrence.location.objectPath} />
				<ShowInUnrealButton
					client={props.client}
					objectPath={props.occurrence.location.objectPath}
				/>
				<Show
					when={
						props.occurrence.location.kind === "data_table_cell" &&
						props.onOpenDataAuthoring
					}
				>
					<Button
						size="compact"
						tone="quiet"
						onClick={() =>
							props.onOpenDataAuthoring?.(props.occurrence.location.objectPath)
						}
					>
						Open in Data Authoring
					</Button>
				</Show>
			</div>
		</article>
	);
}

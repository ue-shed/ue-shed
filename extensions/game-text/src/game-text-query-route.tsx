import * as stylex from "@stylexjs/stylex";
import {
	investigationRequest,
	staleRuntimeCopy,
	type GameTextInvestigationPreset,
	type TextQualityFindingId,
	type TextQualityFilter,
	type TextQualityQueryRunResult,
	type TextQualityQuerySummary,
	type TextQualityRuleUpdateResult
} from "@ue-shed/game-text/corpus";
import {
	textLocationLabel,
	textCountLabel,
	textReviewSignalLabel
} from "@ue-shed/game-text/labels";
import { type GameTextRuleDocument } from "@ue-shed/game-text/rules";
import {
	type TextCorpusFocus,
	type TextCorpusQueryRunResult,
	type TextCorpusQuerySummary,
	type TextCorpusSearchPage,
	type TextCorpusSearchRequest,
	type TextCopyKind,
	type TextOccurrence,
	type TextFilter,
	type TextGroupBy,
	type TextUnitId,
	type LocalizationState,
	LocalizationReviewLens
} from "@ue-shed/game-text/schema";
import {
	Button,
	Chip,
	ToolButton,
	ToolIcon,
	createEffectAction,
	createEffectSubscription
} from "@ue-shed/ui";
import { InvestigationActions } from "@ue-shed/ui/investigation-actions";
import type { TaskProgress } from "@ue-shed/ui/task-progress";
import { Effect, Schedule, Stream } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { failureText } from "./game-text-failure.js";
import { mergePages, nextPageCursor, pageRows } from "./game-text-pages.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextScanProgress } from "./game-text-scan-progress.js";
import { CopyButton } from "./game-text-copy-button.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { ReadProblems, CoverageNotes } from "./game-text-read-problems.js";
import { GameTextQualityWorkspace } from "./game-text-quality-workspace.js";
import { GameTextLocalizationQuality } from "./game-text-localization-quality.js";
import { GameTextReports } from "./game-text-reports.js";
import { createGameTextRuleState } from "./game-text-rule-state.js";
import {
	localizationPreferences,
	migratePreferences,
	readGameTextPreferences,
	writeGameTextPreferences,
	type PreferencesSaveResult,
	type GameTextPreferences
} from "./game-text-preferences.js";
import { clauseParts, type RuleLabels } from "./game-text-filter-model.js";
import { DisplayMenu } from "./game-text-display-menu.js";
import { FacetsPane } from "./game-text-facets.js";
import { FolderBrowser } from "./game-text-folder-browser.js";
import { LinePageHeader, LineProblem, LineProperties } from "./game-text-line-page.js";
import { GameTextIdRepairs } from "./game-text-id-repairs.js";
import { createLineNavigation } from "./game-text-line-navigation.js";
import {
	FilterMenu,
	FilterPills,
	type ExtraField,
	type FilterCounts
} from "./game-text-filter-menu.js";
import { BulkBar, createLineSelection } from "./game-text-bulk-bar.js";
import { GroupedResults } from "./game-text-grouped-results.js";
import { reviewLensLabel } from "./game-text-review.js";
import { createGameTextLocalizationState } from "./game-text-localization-state.js";
import {
	createGameTextEdits,
	StagedEditsButton,
	StagedEditsPanel
} from "./game-text-translation-edits.js";
import { ViewTabs, type ViewTab } from "./game-text-view-tabs.js";
import {
	LocalizationControls,
	LocalizationSync,
	TranslationsDetail,
	GatheredDetail,
	localizationLabels
} from "./game-text-localization-view.js";
import { GameTextColumns, GameTextResultRows } from "./game-text-result-rows.js";
import { BrowseSummary, browseStyles } from "./game-text-browse-chrome.js";
import {
	createGameTextOperations,
	OperationPanel,
	SyncWithUnreal,
	UnrealSteps
} from "./game-text-operations.js";
import { identityLabel, locationDetail, sourceText } from "./game-text-view.js";
import { styles } from "./game-text-styles.js";
import { WhereFilter, textWhere } from "./game-text-where.js";

export { CopyButton } from "./game-text-copy-button.js";
export type { GameTextPreferences } from "./game-text-preferences.js";

const localizationProblems = new Set([
	"key_changed",
	"not_gathered",
	"changed_since_gather",
	"translation",
	"unchecked"
]);

/** Line states that are facts rather than problems; they filter through the selection. */
const LINE_FACT_STATES: readonly LocalizationState[] = [
	"gathered_only",
	"not_found",
	"outside_target",
	"unknown"
];

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

function elapsedTime(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function focusStats(focus: TextCorpusFocus): string {
	return textCountLabel(focus.totalOccurrences, "location");
}

export function GameTextRoute(props: {
	readonly client: GameTextClientApi;
	readonly initialPreferences?: GameTextPreferences | undefined;
	readonly onPreferencesChange?: (preferences: GameTextPreferences) => void;
	readonly projectKey?: string | undefined;
	readonly onOpenDataAuthoring?: (objectPath: string) => void;
}) {
	const initial = untrack(() => {
		const preferences = props.initialPreferences;
		return preferences === undefined ? undefined : migratePreferences(preferences);
	});
	const [query, setQuery] = createSignal(initial?.query ?? "");
	// Saved toggles and lenses became filter pills; these keep their defaults in requests.
	const [capability, setCapability] = createSignal(initial?.capability ?? "all");
	const [withoutNotes, setWithoutNotes] = createSignal(initial?.withoutNotes ?? false);
	const [where, setWhere] = createSignal(initial?.where);
	const [filter, setFilter] = createSignal<TextFilter>(initial?.filter ?? []);
	const [group, setGroup] = createSignal<TextGroupBy | "none">(initial?.group ?? "problem");
	const [facetFolder, setFacetFolder] = createSignal("");
	const [mode, setMode] = createSignal<"corpus" | "quality" | "reports">(
		initial?.mode ?? "corpus"
	);
	const [qualityFilter, setQualityFilter] = createSignal(initial?.qualityFilter ?? "all");
	const [selectedId, setSelectedId] = createSignal<TextUnitId | undefined>(initial?.selectedId);
	const [selectedFindingId, setSelectedFindingId] = createSignal<
		TextQualityFindingId | undefined
	>(initial?.selectedFindingId);
	const [scanRevision, setScanRevision] = createSignal(0);
	const [summary, setSummary] = createSignal<TextCorpusQuerySummary>();
	const [page, setPage] = createSignal<TextCorpusSearchPage>();
	const [committedRequest, setCommittedRequest] = createSignal<TextCorpusSearchRequest>();
	const [focus, setFocus] = createSignal<TextCorpusFocus>();
	const [searching, setSearching] = createSignal(true);
	const [queryMs, setQueryMs] = createSignal<number>();
	const [loading, setLoading] = createSignal(true);
	const [projectAvailable, setProjectAvailable] = createSignal(true);
	const [preparing, setPreparing] = createSignal(true);
	const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
	const [preparationSeconds, setPreparationSeconds] = createSignal<number>();
	const [persistenceFailed, setPersistenceFailed] =
		createSignal<Exclude<PreferencesSaveResult, "saved">>();
	const [memoryReady, setMemoryReady] = createSignal(false);
	const [projectKey, setProjectKey] = createSignal(untrack(() => props.projectKey));
	const [error, setError] = createSignal<string>();
	const [retryError, setRetryError] = createSignal<{
		readonly label: string;
		readonly run: () => void;
	}>();
	const [searchFailed, setSearchFailed] = createSignal(false);
	/** One error at a time, with the action that recovers from it; search errors also end the count. */
	const showError = (
		message: string,
		retry: () => void,
		options: { readonly search?: boolean; readonly label?: string } = {}
	) => {
		setError(message);
		setRetryError({ label: options.label ?? "Retry", run: retry });
		setSearchFailed(options.search ?? false);
	};
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
	const qualityTab = (): ViewTab<"quality"> => {
		if (qualityFailure()?.code === "invalid_rules")
			return {
				id: "quality",
				label: "Quality checks",
				badge: "!",
				badgeLabel: "rules invalid",
				badgeTone: "danger"
			};
		if (editor.dirty())
			return {
				id: "quality",
				label: "Quality checks",
				badge: "•",
				badgeLabel: "unsaved rule changes",
				badgeTone: "accent"
			};
		const count = qualityTabCount();
		return count === undefined
			? { id: "quality", label: "Quality checks" }
			: {
					id: "quality",
					label: "Quality checks",
					badge: count.toLocaleString(),
					badgeLabel: textCountLabel(count, "finding")
				};
	};
	// Reports read the target's translations, so they are offered only with a target.
	const viewTabs = (): readonly ViewTab<"corpus" | "quality" | "reports">[] => [
		{ id: "corpus", label: "Text" },
		qualityTab(),
		...(localization.active() ? [{ id: "reports" as const, label: "Reports" }] : [])
	];
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
	const progressSubscription = createEffectSubscription();
	const elapsedSubscription = createEffectSubscription();
	let searchGeneration = 0;
	let focusGeneration = 0;
	const localization = createGameTextLocalizationState({
		client: props.client,
		initial,
		summary,
		selectedUnit: selectedId,
		onPending: () => {
			setPreparing(true);
		}
	});
	const indexBusy = () =>
		loading() || Boolean(summary() && preparing() && !localization.error() && !error());
	const progressLabel = () =>
		!loading() && localization.ready()
			? "Loading first results"
			: (progress().detail ??
				(progress().stage === "project_index"
					? "Discovering saved packages"
					: progress().phase === "scanning"
						? "Inspecting text-bearing packages"
						: !loading()
							? "Loading translations"
							: "Preparing saved text index"));
	let observingProgress = false;
	let preparationStarted = 0;
	createEffect(indexBusy, (busy) => {
		if (busy === observingProgress) return;
		observingProgress = busy;
		if (!busy) {
			progressSubscription.cancel();
			elapsedSubscription.cancel();
			if (untrack(() => page() && !error() && !localization.error())) {
				setPreparationSeconds(Math.floor((performance.now() - preparationStarted) / 1000));
			}
			return;
		}
		const started = performance.now();
		preparationStarted = started;
		setElapsedSeconds(0);
		progressSubscription.subscribe(props.client.progress, { onValue: setProgress });
		elapsedSubscription.subscribe(
			Stream.fromEffectSchedule(
				Effect.sync(() => Math.floor((performance.now() - started) / 1000)),
				Schedule.spaced("1 second")
			),
			{ onValue: setElapsedSeconds }
		);
	});
	const progressTotal = () => (!loading() && localization.ready() ? 0 : progress().total);
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
		onWritten: () => load(false),
		initial: initial?.editSession
	});
	// Targets are only listed after a successful load; work kept for a target the project no longer
	// has could never be shown or written, so it goes.
	const unloadedTargets = untrack(localization.targets);
	createEffect(localization.targets, (targets) => {
		if (targets !== unloadedTargets) edits.prune(targets.map((target) => target.name));
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
			attachRuleFile(result);
		}
	});
	// The host says whether a rules file is attached; hosts that do not say keep the last answer.
	function attachRuleFile(result: { readonly ruleFile?: "attached" | "none" | undefined }) {
		if (result.ruleFile !== undefined) editor.attachFile(result.ruleFile === "attached");
	}

	const requestFocus = (id: TextUnitId, cursor?: TextCorpusFocus["nextOccurrenceCursor"]) => {
		const generation = ++focusGeneration;
		const target = localization.target();
		const line = localization.selectedId();
		focusAction.run(
			props.client.focus({
				id,
				...(target && line ? { localization: { target, id: line } } : undefined),
				pageSize: 50,
				...(cursor ? { occurrenceCursor: cursor } : undefined)
			}),
			{
				onFailure: (cause) => {
					if (generation === focusGeneration)
						showError(failureText("Couldn’t open this line.", cause), () =>
							requestFocus(id, cursor)
						);
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
						if (result.status === "failed")
							showError(
								`${result.error.message} ${result.error.recovery}`,
								() => load(true),
								{ label: "Rescan" }
							);
						if (result.status === "not_found") setSelectedId(undefined);
					}
				}
			}
		);
	};

	const whereField = () => {
		const value = where();
		return value === undefined ? undefined : { where: value };
	};
	const groupField = () => {
		const value = group();
		return value === "none" ? undefined : { group: value };
	};
	const localizationField = () => {
		const selected = localization.selection();
		return selected === undefined ? undefined : { localization: selected };
	};
	let searchInput: HTMLInputElement | undefined;
	const navigation = createLineNavigation({
		page,
		group,
		unit: selectedId,
		setUnit: setSelectedId,
		line: localization.selectedId,
		setLine: localization.setSelectedId,
		moreResults: () => moreResults(),
		focusSearch: () => searchInput?.focus()
	});
	const {
		lineOpen,
		paneCollapsed,
		setPaneCollapsed,
		collapsed,
		groupRows,
		groupLoaded,
		linePosition,
		selectRow,
		moveLine,
		closeLine
	} = navigation;
	// Lines ticked for bulk actions, in the list's order for shift-click ranges. A new target
	// starts a new selection.
	const selection = createLineSelection({
		order: () => {
			const groups = page()?.groups?.entries;
			if (!groups) return page()?.localization?.lines ?? [];
			return groups.flatMap((entry) =>
				(groupRows().get(entry.key) ?? []).flatMap((row) =>
					row.preview === undefined ? [] : [row.preview]
				)
			);
		}
	});
	createEffect(
		() => localization.target(),
		() => selection.clear()
	);
	const ticks = () =>
		localization.active()
			? {
					checked: selection.isTicked,
					onCheck: selection.toggle,
					checking: selection.ticked().size > 0
				}
			: undefined;
	// Review state and line facts still filter through the selection, one choice at a time.
	const extraFields = (): readonly ExtraField[] => {
		if (!localization.active()) return [];
		const current = searching() ? undefined : page()?.localization;
		const review = current?.reviewCounts;
		return [
			...(review === undefined && !localization.review()
				? []
				: [
						{
							key: "review",
							label: "Review",
							options: LocalizationReviewLens.literals.map((lens) => ({
								label: reviewLensLabel(lens),
								count: review?.[lens],
								selected: localization.review() === lens,
								onSelect: () =>
									localization.setReview(
										localization.review() === lens ? undefined : lens
									)
							}))
						}
					]),
			{
				key: "line",
				label: "Line state",
				options: LINE_FACT_STATES.map((state) => ({
					label: localizationLabels[state],
					count: current?.stateCounts[state],
					selected: localization.state() === state,
					onSelect: () =>
						localization.setState(localization.state() === state ? undefined : state)
				}))
			}
		];
	};
	// The Filter menu counts each value from the current page, while no search is running.
	const filterCounts = (): FilterCounts => {
		const current = searching() ? undefined : page();
		if (current === undefined)
			return {
				choices: {},
				folders: undefined,
				assets: undefined,
				assetTypes: undefined,
				findings: undefined,
				findingsStatus: page()?.findings?.status
			};
		const states = current.localization?.stateCounts;
		const counts = current.counts;
		return {
			choices: {
				...(current.problems === undefined ? undefined : { problem: current.problems }),
				...(states === undefined
					? undefined
					: {
							translation: {
								missing: states.not_translated,
								to_update: states.needs_update,
								not_synced: states.not_synced
							}
						}),
				...(current.facets?.facts === undefined
					? undefined
					: { fact: current.facets.facts }),
				origin: counts.origins,
				editing: { editable: counts.editable, read_only: counts.readOnly },
				notes: {
					missing: counts.withoutNotes,
					present: Math.max(0, current.total - counts.withoutNotes)
				},
				...(current.facets?.audiences === undefined
					? undefined
					: {
							audience: {
								player: 0,
								editor: 0,
								unknown: 0,
								...Object.fromEntries(
									current.facets.audiences.entries.map((entry) => [
										entry.key,
										entry.count
									])
								)
							}
						})
			},
			folders: current.facets?.folders,
			assets: current.facets?.assets,
			assetTypes: current.facets?.assetTypes,
			findings: current.facets?.findings,
			findingsStatus: current.findings?.status
		};
	};
	// Rule labels by ID, for finding pills, row suffixes and the line page.
	const ruleLabels = createMemo(
		(): RuleLabels =>
			new Map(
				(page()?.facets?.findings?.entries ?? []).map((entry) => [entry.key, entry.label])
			)
	);
	const searchRequest = createMemo((): TextCorpusSearchRequest => {
		const selected = localization.selection();
		const clauses = selected
			? filter()
			: filter().flatMap((clause): TextFilter => {
					if (clause.field === "translation") return [];
					if (clause.field !== "problem") return [clause];
					const values = clause.values.filter(
						(value) => !localizationProblems.has(value)
					);
					return values.length ? [{ ...clause, values }] : [];
				});
		return {
			query: query(),
			capability: capability(),
			withoutNotes: withoutNotes(),
			...whereField(),
			...(clauses.length > 0 ? { filter: clauses } : undefined),
			...groupField(),
			facets: {
				folder: facetFolder(),
				assets: true,
				origins: true,
				audiences: true,
				assetTypes: true,
				findings: true,
				facts: true,
				...(selected ? { cultures: true } : undefined)
			},
			...(selected ? { localization: selected } : undefined),
			pageSize: 50
		};
	});
	const narrowing = createMemo(
		() =>
			[
				query() ? `“${query()}”` : undefined,
				...filter().map((clause) => {
					const parts = clauseParts(clause, ruleLabels());
					return `${parts.field} ${parts.op} ${parts.values}`;
				}),
				localization.state()
					? localizationLabels[localization.state() ?? "unknown"]
					: undefined,
				localization.review()
					? reviewLensLabel(localization.review() ?? "reviewed")
					: undefined,
				where()?.files ? "changed files" : undefined,
				localization.cultures().length
					? "cultures " + localization.cultures().join(", ")
					: undefined
			]
				.filter((item) => item !== undefined)
				.join("; ") || "the scanned text"
	);
	const moreResults = () => {
		const current = untrack(page);
		const request = committedRequest() ?? searchRequest();
		if (current?.localization?.nextCursor)
			requestPage({ ...request, localizationCursor: current.localization.nextCursor });
		else if (current?.nextCursor) requestPage({ ...request, cursor: current.nextCursor });
	};
	// The last search that showed results: repeating it (after a rescan or write) reloads as many
	// rows as were loaded, while a new or failed search starts from one page.
	let previousSearch = "";
	const requestPage = (request: TextCorpusSearchRequest, debounce = false) => {
		const generation = ++searchGeneration;
		const {
			cursor: _cursor,
			localizationCursor: _localizationCursor,
			...baseRequest
		} = request;
		const signature = JSON.stringify(baseRequest);
		const desired =
			signature === previousSearch
				? untrack(() => page()?.localization?.lines.length ?? page()?.units.length ?? 50)
				: 50;
		let started = 0;
		if (!request.cursor && !request.localizationCursor) navigation.cancelSteps();
		setError(undefined);
		setSearchFailed(false);
		setSearching(true);
		searchAction.run(
			(debounce ? Effect.sleep("120 millis") : Effect.void).pipe(
				Effect.flatMap(() => {
					started = performance.now();
					return Effect.gen(function* () {
						// A further page reads rows only and joins the page it continues.
						const continued =
							request.cursor || request.localizationCursor
								? untrack(page)
								: undefined;
						if (continued) {
							const rows = yield* props.client.searchRows(request);
							return rows.status === "ready"
								? {
										status: "ready" as const,
										page: mergePages(continued, rows.page)
									}
								: rows;
						}
						const result = yield* props.client.search(request);
						if (
							result.status !== "ready" ||
							request.cursor ||
							request.localizationCursor
						)
							return result;
						let collected = result.page;
						while (pageRows(collected) < desired) {
							const cursor = nextPageCursor(collected);
							if (!cursor) break;
							const rows = yield* props.client.searchRows({ ...request, ...cursor });
							if (rows.status !== "ready") return rows;
							collected = mergePages(collected, rows.page);
						}
						return { status: "ready" as const, page: collected };
					});
				})
			),
			{
				onFailure: (cause) => {
					if (generation === searchGeneration) {
						if (!untrack(loading)) setPreparing(false);
						setSearching(false);
						showError(
							failureText("Search failed.", cause),
							() => requestPage(request),
							{ search: true, label: "Retry search" }
						);
					}
				},
				onSuccess: (result) => {
					if (generation !== searchGeneration) return;
					if (!untrack(loading)) setPreparing(false);
					setSearching(false);
					if (result.status === "ready") {
						previousSearch = signature;
						setCommittedRequest(baseRequest);
						setQueryMs(performance.now() - started);
						setPage(result.page);
						// The rules are still checking: the same search reads their findings once
						// they are done, unless another search replaced it.
						if (
							result.page.findings?.status === "pending" &&
							!request.cursor &&
							!request.localizationCursor
						)
							setTimeout(() => {
								if (generation === searchGeneration) requestPage(request);
							}, 2000);
					} else {
						showError(
							result.status === "failed"
								? `${result.error.message} ${result.error.recovery}`
								: "The saved assets changed since the last scan. Rescan to search again.",
							() => load(true),
							{ search: true, label: "Rescan" }
						);
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
			attachRuleFile(result);
		} else if (result.status === "failed") setQualityFailure(result.error);
	};
	// Review flags written from a line's translations reload the view when they change.
	const translationReview = () => ({
		client: props.client,
		busy: loading() || operations.busy(),
		onChanged: () => load(false)
	});

	const load = (refresh: boolean) => {
		setPreparing(true);
		setLoading(true);
		setError(undefined);
		setSearchFailed(false);
		setScanNotice(undefined);
		// A route already following progress has the host's current value; a reset would hide it
		// until the next change.
		if (!observingProgress)
			setProgress({ completed: 0, total: 0, phase: "idle", stage: "game_text" });
		refreshAction.run(props.client.loadConfiguredProject(refresh), {
			onFailure: (cause) => {
				setPreparing(false);
				setLoading(false);
				showError(failureText("Couldn’t read the project’s saved text.", cause), () =>
					load(refresh)
				);
			},
			onSuccess: (result: TextCorpusQueryRunResult) => {
				setLoading(false);
				setProjectAvailable(result.status !== "not_configured");
				if (result.status === "completed") {
					localization.load();
					setSummary(result.summary);
					setScanRevision((revision) => revision + 1);
					if (!untrack(projectKey) && props.client.projectKey) {
						memoryAction.run(props.client.projectKey(), {
							onSuccess: setProjectKey
						});
					}
					// Results reopened from the saved index stay usable while a rescan brings
					// them up to date.
					if (result.cached === true && !refresh) load(true);
				} else if (result.status === "failed") {
					setPreparing(false);
					showError(result.error.message + " " + result.error.recovery, () =>
						load(refresh)
					);
				} else if (result.status === "cancelled") {
					setPreparing(false);
					setScanNotice("Scan cancelled. Your workspace project selection is unchanged.");
				} else setPreparing(false);
			}
		});
	};

	const restore = (saved: GameTextPreferences) => {
		const preferences = migratePreferences(saved);
		focusGeneration++;
		setFocus(undefined);
		setQualitySummary(undefined);
		setQualityFailure(undefined);
		localization.restore(preferences);
		if (preferences.editSession) edits.restore(preferences.editSession);
		setQuery(preferences.query);
		setCapability(preferences.capability);
		setWithoutNotes(preferences.withoutNotes ?? false);
		setWhere(preferences.where);
		setFilter(preferences.filter ?? []);
		setGroup(preferences.group ?? "problem");
		setMode(preferences.mode ?? "corpus");
		setQualityFilter(preferences.qualityFilter ?? "all");
		setSelectedId(preferences.selectedId);
		setSelectedFindingId(preferences.selectedFindingId);
		setQualityDocument(preferences.qualityDocument);
		editor.replace(preferences.qualityDocument, false);
		if (preferences.qualityEditor) editor.restore(preferences.qualityEditor);
	};

	// Requests consume committed state, including preferences restored during the first load.
	// Only a request edit against the same loaded scan and rules is typing and waits out the
	// debounce; the first page after a load, rescan, localization or rules change is requested at
	// once. New rules change Browse's findings, so the same request runs again.
	let searchedScan: { summary: unknown; revision: number; rules: unknown } | undefined;
	createEffect(
		() => ({
			summary: summary(),
			revision: scanRevision(),
			rules: qualityDocument(),
			request: searchRequest(),
			ready: localization.ready()
		}),
		({ summary: current, revision, rules, request, ready }) => {
			if (!current || !ready) return;
			const typing =
				searchedScan?.summary === current &&
				searchedScan.revision === revision &&
				searchedScan.rules === rules;
			searchedScan = { summary: current, revision, rules };
			requestPage(request, typing);
		}
	);
	createEffect(
		() => ({
			summary: summary(),
			id: selectedId(),
			line: localization.selectedId(),
			target: localization.target(),
			ready: localization.ready()
		}),
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
						attachRuleFile(reviewed);
					} else applyQuality(reviewed);
				},
				onFailure: (cause) =>
					showError(failureText("Couldn’t check the rules.", cause), () =>
						editor.run("preview", document)
					)
			});
		}
	);

	let pendingSave: { key: string; preferences: GameTextPreferences } | undefined;
	let saveTimer: number | undefined;
	const flushPreferences = () => {
		window.clearTimeout(saveTimer);
		const save = pendingSave;
		pendingSave = undefined;
		if (!save) return;
		// Synchronous storage: this runs during page hide and route disposal too.
		const result = writeGameTextPreferences(save.key, save.preferences);
		setPersistenceFailed(result === "saved" ? undefined : result);
	};
	createEffect(
		() => ({
			ready: memoryReady(),
			key: projectKey(),
			preferences: {
				query: query(),
				capability: capability(),
				withoutNotes: withoutNotes(),
				// A changed-file list lasts for the session; pills and grouping are saved.
				where: textWhere(where()?.kinds, where()?.pathPrefix),
				filter: filter(),
				group: group(),
				mode: mode(),
				qualityFilter: qualityFilter(),
				selectedId: selectedId(),
				selectedFindingId: selectedFindingId(),
				qualityDocument: qualityDocument(),
				qualityEditor: editor.state(),
				editSession: edits.session(),
				localizationTarget: localization.target(),
				localizationCulture: localization.culture(),
				localizationCultures:
					localization.cultures().length > 0 ? localization.cultures() : undefined,
				localizationState: localization.state(),
				localizationReview: localization.review(),
				localizationKeyChanged: localization.keyChanged(),
				searchTranslations: localization.searchTranslations(),
				selectedLocalizationId: localization.selectedId()
			}
		}),
		({ ready, key, preferences }) => {
			if (!ready) return;
			props.onPreferencesChange?.(preferences);
			pendingSave = key ? { key, preferences } : undefined;
			// Typing changes drafts on every key, so writes wait for a pause; leaving flushes them.
			window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(flushPreferences, 300);
		}
	);

	onSettled(() => {
		const shortcut = (event: KeyboardEvent) => {
			if (
				mode() === "corpus" &&
				lineOpen() &&
				!event.defaultPrevented &&
				!event.isComposing &&
				!(
					event.target instanceof Element &&
					event.target.closest(
						'[role="dialog"], [role="alertdialog"], input, textarea, select, [contenteditable]'
					)
				)
			) {
				if (event.key === "Escape") {
					event.preventDefault();
					closeLine();
				}
				if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
					event.preventDefault();
					moveLine(event.key === "ArrowDown" ? 1 : -1);
				}
			}
			if (
				mode() === "corpus" &&
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "k"
			) {
				event.preventDefault();
				searchInput?.focus({ preventScroll: true });
				searchInput?.select();
			}
		};
		// Drafts are persisted with the view, so closing the window only needs the last write.
		window.addEventListener("keydown", shortcut);
		window.addEventListener("pagehide", flushPreferences);
		return () => {
			window.removeEventListener("keydown", shortcut);
			window.removeEventListener("pagehide", flushPreferences);
			flushPreferences();
		};
	});
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

	const [replacement, setReplacement] = createSignal<() => void>();
	const guardRules = (next: () => void) => {
		if (editor.dirty()) setReplacement(() => next);
		else next();
	};
	const loadRules = (create?: boolean) =>
		guardRules(() => {
			setQualityFailure(undefined);
			const operation =
				create === undefined
					? props.client.chooseQualityRules()
					: props.client.createStarterRules?.(create);
			if (!operation) return;
			qualityAction.run(operation, {
				onSuccess: applyQuality,
				onFailure: (cause) =>
					showError(failureText("Couldn’t open the rules file.", cause), () =>
						loadRules(create)
					)
			});
		});
	const reloadRules = () =>
		guardRules(() => {
			setQualityFailure(undefined);
			qualityAction.run(
				props.client.reloadQualityRules?.() ?? props.client.chooseQualityRules(),
				{
					onSuccess: applyQuality,
					onFailure: (cause) =>
						showError(
							failureText("Couldn’t reload the rules file.", cause),
							reloadRules
						)
				}
			);
		});
	const restorePreset = (preset: GameTextInvestigationPreset) => {
		const { localization: selected, ...saved } = investigationRequest(preset.query);
		restore({
			...saved,
			qualityFilter: saved.workspaceFilter ?? saved.qualityFilter,
			...localizationPreferences(selected),
			withoutNotes: saved.withoutNotes ?? false,
			selectedId: undefined,
			qualityDocument: preset.rules
		});
		load(false);
	};
	createEffect(
		() => ({
			mode: mode(),
			active: localization.active(),
			culture: localization.culture(),
			document: qualityDocument(),
			summary: qualitySummary()
		}),
		({ mode: currentMode, active, culture, document }) => {
			workspaceCountAction.cancel();
			setWorkspaceFindingCount(undefined);
			// Without a rules file nothing is checked, so there is nothing to count.
			if (
				currentMode !== "quality" ||
				!active ||
				!document ||
				!props.client.localizationQualitySearch
			)
				return;
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
	// One spreadsheet with every language for the lines the list shows.
	const allLanguagesExport = () => {
		const request = props.client.localizationLinesFile;
		if (!request) return Effect.succeed({ status: "cancelled" as const });
		return request(searchRequest()).pipe(
			Effect.map((result) =>
				result.status === "not_ready"
					? {
							status: "failed" as const,
							message: "Translations are still loading.",
							recovery: "Try again in a moment."
						}
					: result
			)
		);
	};
	const exports = (): JSX.Element => (
		<Show when={props.client.investigations}>
			{(client) => (
				<div {...stylex.attrs(styles.exports)}>
					<InvestigationActions
						compact
						showLabels
						blocked={operations.busy()}
						client={client()}
						disabled={
							!summary() ||
							(mode() === "corpus"
								? searching()
								: localization.active()
									? qualityTabCount() === undefined
									: !qualitySummary())
						}
						revision={[summary(), qualitySummary()]}
						query={{
							mode: mode() === "quality" ? "quality" : "corpus",
							query: query(),
							capability: capability(),
							withoutNotes: withoutNotes(),
							...whereField(),
							...(searchRequest().filter
								? { filter: searchRequest().filter }
								: undefined),
							...groupField(),
							// Problem and translation pills need the target, as the list does.
							...localizationField(),
							qualityFilter: sourceFilter(),
							...(mode() === "quality" && localization.active()
								? { workspaceFilter: qualityFilter() }
								: undefined)
						}}
						onOpen={restorePreset}
						onRequestOpen={(open) => guardRules(open)}
						disabledReason={
							mode() === "quality"
								? "Wait for findings to load, or load a rules file to check source text."
								: "Wait for the search to finish before exporting."
						}
						extraExport={
							localization.active() && props.client.localizationLinesFile
								? {
										label: "All languages (CSV)",
										run: () => allLanguagesExport()
									}
								: undefined
						}
					/>
				</div>
			)}
		</Show>
	);

	const rulesSetup = () => (
		<section aria-label="Quality rules setup" {...stylex.attrs(styles.card, styles.rulesEmpty)}>
			<h2 {...stylex.attrs(styles.heading)}>No quality rules for this project</h2>
			<p {...stylex.attrs(styles.rulesEmptyText)}>
				Quality checks only what a rules file turns on, and this project has none yet.
				Create one to start with the built-in checks; you can turn any of them off later.
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
					Choose a rules file…
				</Button>
			</div>
			<Show when={props.client.createStarterRules}>
				<p {...stylex.attrs(styles.muted)}>
					Creates the project's rules file with the starter rules.
				</p>
			</Show>
		</section>
	);
	return (
		<main {...stylex.attrs(styles.page)}>
			<Show when={persistenceFailed()}>
				{(failure) => (
					<p role="alert" {...stylex.attrs(styles.muted, styles.warning)}>
						{failure() === "drafts_not_saved"
							? "Drafts are too large to keep if Workbench closes. Stage, write or save them before closing."
							: "This view could not be saved locally. Your drafts last until Workbench closes."}
					</p>
				)}
			</Show>
			<Show when={replacement()}>
				<section
					role="alertdialog"
					aria-label="Unsaved quality rules"
					{...stylex.attrs(styles.card)}
				>
					<p>
						Quality rules have unsaved changes. Discard them before replacing the rules?
					</p>
					<Button onClick={() => setReplacement(undefined)}>Keep editing</Button>
					<Button
						onClick={() => {
							const next = replacement();
							setReplacement(undefined);
							next?.();
						}}
					>
						Discard and continue
					</Button>
				</section>
			</Show>
			<header {...stylex.attrs(styles.titleRow)}>
				<h1 {...stylex.attrs(styles.heading)}>Game Text</h1>
				<ViewTabs
					label="Game Text view"
					idPrefix="game-text"
					tabs={viewTabs()}
					selected={mode()}
					onSelect={setMode}
				/>
				<span aria-label="Index status" {...stylex.attrs(styles.coverage)}>
					<Show
						when={indexBusy()}
						fallback={
							<Show
								when={summary()}
								fallback={
									projectAvailable()
										? "Ready to scan project"
										: "No project selected"
								}
							>
								{(current) => (
									<>
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
													localization.active()?.lines ??
													current().counts.all
												).toLocaleString()}
											</b>{" "}
											{(localization.active()?.lines ??
												current().counts.all) === 1
												? "line"
												: "lines"}{" "}
											{localization.active() ? "· " : "in "}
										</Show>
										<b>
											{current().coverage.inspectedPackages.toLocaleString()}
										</b>{" "}
										{current().coverage.inspectedPackages === 1
											? "asset"
											: "assets"}
										<Show when={current().scannedAt}>
											{" "}
											· scanned {scanTime(current().scannedAt)}
										</Show>
										<ReadProblems summary={current()} />
									</>
								)}
							</Show>
						}
					>
						<span role="status" {...stylex.attrs(styles.indexProgress)}>
							<GameTextScanProgress
								label={progressLabel()}
								completed={progress().completed}
								total={progressTotal()}
							/>
							<span {...stylex.attrs(styles.scanReadout)}>
								<span>
									{loading()
										? summary()
											? "Rescanning"
											: "Opening saved text index"
										: "Preparing translations and results"}
								</span>
								{" · "}
								{progressLabel()}
								<Show when={progressTotal() > 0}>
									{" · "}
									{progress().completed.toLocaleString()} /{" "}
									{progressTotal().toLocaleString()}
								</Show>
								{" · "}
								{elapsedTime(elapsedSeconds())} elapsed
							</span>
						</span>
					</Show>
				</span>
				<Show when={summary()}>
					<ToolButton
						label="Rescan"
						showLabel
						tooltip={
							operations.reason() ??
							"Refresh saved text and translations from the project. Keeps your current list and drafts."
						}
						disabled={indexBusy() || operations.busy()}
						onClick={() => load(true)}
					>
						<ToolIcon name="refresh" />
					</ToolButton>
				</Show>
			</header>
			<Show when={summary()}>
				<div role="group" aria-label="Translations" {...stylex.attrs(styles.contextBar)}>
					<Show
						when={localization.targets().length > 0 || !localization.ready()}
						fallback={
							<span {...stylex.attrs(styles.contextLabel, styles.muted)}>
								This project has no localization targets.
							</span>
						}
					>
						<LocalizationControls
							model={localization}
							disabled={operations.busy() || edits.working()}
							cultureWork={page()?.facets?.cultures}
						/>
					</Show>
					<div {...stylex.attrs(styles.contextActions)}>
						<LocalizationSync
							model={localization}
							action={
								<SyncWithUnreal
									model={operations}
									pending={localization.active()?.notSynced ?? 0}
									unwritten={edits.edits().length}
								/>
							}
						/>
						<StagedEditsButton model={edits} />
						<UnrealSteps model={operations} />
					</div>
				</div>
			</Show>
			<OperationPanel model={operations} />
			<StagedEditsPanel model={edits} />
			<Show when={localization.error()}>
				<p role="alert" {...stylex.attrs(styles.problemMessage)}>
					{localization.error()}{" "}
					<Button size="compact" onClick={localization.load}>
						Retry translations
					</Button>
				</p>
			</Show>
			<Show
				when={
					!localization.active() &&
					!localization.error() &&
					filter().some(
						(clause) =>
							clause.field === "translation" ||
							(clause.field === "problem" &&
								clause.values.some((value) => localizationProblems.has(value)))
					)
				}
			>
				<p role="note">
					Localization-dependent filter values are paused until a target is available.
					Source filters still apply.
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
						<Button onClick={() => retryError()?.run()}>
							{retryError()?.label ?? "Retry"}
						</Button>
					</div>
				)}
			</Show>
			<Show when={mode() === "quality" && qualitySummary() && qualityFailure()}>
				<p role="alert" {...stylex.attrs(styles.card)}>
					{qualityFailure()?.message} {qualityFailure()?.recovery}
					<Button onClick={() => loadRules()}>Load rules</Button>
				</p>
			</Show>
			<div
				role="tabpanel"
				id={"game-text-panel-" + mode()}
				aria-labelledby={"game-text-tab-" + mode()}
				{...stylex.attrs(styles.workspace)}
			>
				<Show
					when={summary()}
					fallback={
						<div {...stylex.attrs(styles.empty)}>
							<Show
								when={!loading()}
								fallback={<span role="status">Loading saved game text…</span>}
							>
								<p>
									Game Text reads the project's saved assets, so Unreal does not
									need to be running.
								</p>
								<Show
									when={projectAvailable()}
									fallback={
										<p>
											Choose a project using the workspace project picker,
											then return here.
										</p>
									}
								>
									<Button tone="primary" onClick={() => load(true)}>
										Scan project
									</Button>
								</Show>
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
										localization.target() &&
										props.client.localizationQualitySearch
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
																localization.setSelectedId(
																	undefined
																);
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
								<div {...stylex.attrs(styles.bar, styles.browseBar)}>
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
											ref={(element) => {
												searchInput = element;
											}}
											autofocus
											type="search"
											aria-label="Search game text"
											placeholder={
												localization.cultures().length > 0 &&
												localization.searchTranslations()
													? "Search text and translations"
													: "Search text"
											}
											maxlength={512}
											disabled={loading() && !summary()}
											value={query()}
											{...stylex.attrs(styles.input)}
											onInput={(event) => setQuery(event.currentTarget.value)}
											onKeyDown={(event) => {
												if (event.key === "Enter" && localization.ready())
													requestPage(searchRequest());
											}}
										/>
										<span role="status" {...stylex.attrs(styles.count)}>
											{searchFailed()
												? "Search failed"
												: searching() || !page()
													? "Searching…"
													: page()?.total === 1
														? "1 match"
														: page()?.total.toLocaleString() +
															" matches"}
										</span>
										{/* An option of the search, so it lives in the field, as in an editor's find. */}
										<Show
											when={
												localization.active() &&
												localization.cultures().length > 0
											}
										>
											<ToolButton
												label="Search translations"
												tooltip={
													localization.searchTranslations()
														? "On. Search source text and translations in the picked cultures."
														: "Off. Search source text only. Turn on to include the picked cultures' translations."
												}
												aria-pressed={
													localization.searchTranslations()
														? "true"
														: "false"
												}
												onClick={() =>
													localization.setSearchTranslations(
														!localization.searchTranslations()
													)
												}
											>
												<ToolIcon name="translations" />
											</ToolButton>
										</Show>
										<kbd
											{...stylex.attrs(
												browseStyles.keyboard,
												styles.shortcut
											)}
										>
											{/Mac|iPhone|iPad/.test(navigator.platform)
												? "⌘ K"
												: "Ctrl K"}
										</kbd>
									</div>
									<div {...stylex.attrs(styles.browseActions)}>
										<WhereFilter
											where={where()}
											counts={page()?.counts.origins}
											fileScope={page()?.fileScope}
											searching={searching()}
											disabled={loading() && !summary()}
											filesOnly
											onChange={setWhere}
										/>
										<FilterMenu
											filter={filter()}
											counts={filterCounts()}
											hasTarget={localization.active() !== undefined}
											disabled={loading() && !summary()}
											onChange={setFilter}
											extraFields={extraFields()}
											folderBrowser={(typed) => (
												<FolderBrowser
													menu
													typed={typed()}
													list={page()?.facets?.folders}
													folder={facetFolder()}
													filter={filter()}
													onFolderChange={setFacetFolder}
													onFilterChange={setFilter}
												/>
											)}
										/>
										<DisplayMenu
											group={
												group() === "none" ? undefined : groupField()?.group
											}
											disabled={loading() && !summary()}
											findings={
												page()?.findings !== undefined &&
												page()?.findings?.status !== "none"
											}
											onGroupChange={(next) => setGroup(next ?? "none")}
										/>
										{exports()}
										{/* At the edge above the pane it shows or hides, like an editor's panel toggle. */}
										<span
											aria-hidden="true"
											{...stylex.attrs(styles.divider)}
										/>
										<ToolButton
											label="Side pane"
											tooltip={
												paneCollapsed()
													? "Show line details and where the lines are beside the list."
													: "Give the list the full width. Your drafts are kept."
											}
											aria-pressed={paneCollapsed() ? "false" : "true"}
											onClick={() => {
												const hide = !paneCollapsed();
												setPaneCollapsed(hide);
												// The toggle keeps focus; only an open line closes.
												if (hide && lineOpen()) closeLine(false);
											}}
										>
											<ToolIcon name="panel" />
										</ToolButton>
									</div>
								</div>
								<Show
									when={
										filter().length > 0 ||
										localization.state() ||
										localization.review()
									}
								>
									<div {...stylex.attrs(styles.bar)}>
										<FilterPills
											filter={filter()}
											onChange={setFilter}
											rules={ruleLabels()}
										/>
										<Show when={localization.state()}>
											{(state) => (
												<Chip
													label={localizationLabels[state()]}
													selected
													onClick={() => localization.setState(undefined)}
												/>
											)}
										</Show>
										<Show when={localization.review()}>
											{(review) => (
												<Chip
													label={reviewLensLabel(review())}
													selected
													onClick={() =>
														localization.setReview(undefined)
													}
												/>
											)}
										</Show>
									</div>
								</Show>
								<div
									{...stylex.attrs(
										styles.grid,
										collapsed() && styles.gridCollapsed
									)}
								>
									{/* Keep the paged list beside the line detail so selection, groups and pages survive. */}
									<section
										aria-label="Results"
										ref={navigation.setList}
										{...stylex.attrs(styles.pane)}
									>
										<GameTextColumns culture={localization.culture()} />
										<Show
											when={page()?.groups}
											fallback={
												<GameTextResultRows
													page={page()}
													culture={localization.culture()}
													cultures={localization.cultures()}
													selectedId={selectedId()}
													selectedLocalizationId={localization.selectedId()}
													onSelect={(unit, line) => {
														selectRow({ unit, line });
													}}
													rules={ruleLabels()}
													checked={ticks()?.checked}
													onCheck={ticks()?.onCheck}
													checking={ticks()?.checking}
												/>
											}
										>
											{(groups) => (
												<GroupedResults
													revision={page()}
													by={groups().by}
													groups={groups().entries}
													more={groups().more}
													request={committedRequest() ?? searchRequest()}
													client={props.client}
													culture={localization.culture()}
													cultures={localization.cultures()}
													selectedId={selectedId()}
													selectedLocalizationId={localization.selectedId()}
													onSelect={(unit, line) => {
														selectRow({ unit, line });
													}}
													rules={ruleLabels()}
													onLoaded={groupLoaded}
													ticks={ticks()}
												/>
											)}
										</Show>
										<Show
											when={
												localization.ready() &&
												!searching() &&
												page()?.total === 0
											}
										>
											<p {...stylex.attrs(styles.empty)}>
												No text matches {narrowing()}.
												<Button
													size="compact"
													onClick={() => {
														setQuery("");
														setFilter([]);
														setWhere(undefined);
														setCapability("all");
														setWithoutNotes(false);
														localization.setState(undefined);
														localization.setReview(undefined);
														localization.setKeyChanged(false);
														localization.selectCulture("");
													}}
												>
													Clear all
												</Button>
											</p>
										</Show>
										<Show
											when={
												!page()?.groups &&
												(page()?.localization?.nextCursor ??
													page()?.nextCursor)
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
										<BulkBar
											selection={selection}
											client={props.client}
											localization={localization.selection()}
											cultures={localization.cultures()}
											nativeCulture={
												localization.active()?.target.nativeCulture ??
												undefined
											}
											edits={edits}
											busy={loading() || operations.busy()}
											onChanged={() => load(false)}
										/>
									</section>
									<aside
										aria-label="Text focus"
										ref={navigation.setPane}
										{...stylex.attrs(
											styles.pane,
											collapsed() && styles.hiddenPane
										)}
									>
										<Show when={lineOpen()}>
											<LinePageHeader
												position={linePosition()}
												onBack={closeLine}
												onMove={moveLine}
											/>
										</Show>
										<div {...stylex.attrs(lineOpen() && styles.pageBody)}>
											<div>
												<Show when={lineOpen()}>
													<div {...stylex.attrs(styles.calloutBox)}>
														<LineProblem
															focus={focus()}
															detail={localization.detail()}
															rules={ruleLabels()}
														/>
													</div>
												</Show>
												<Show
													when={focus()}
													fallback={
														<Show
															when={
																localization.detail()?.origin
																	.kind === "evidence"
																	? localization.detail()
																	: undefined
															}
															fallback={
																<Show
																	when={
																		!localization.detailLoading()
																	}
																	fallback={
																		<p
																			{...stylex.attrs(
																				styles.empty
																			)}
																		>
																			Loading translations…
																		</p>
																	}
																>
																	<FacetsPane
																		page={page()}
																		group={groupField()?.group}
																		filter={filter()}
																		folder={facetFolder()}
																		onFolderChange={
																			setFacetFolder
																		}
																		onFilterChange={setFilter}
																	/>
																</Show>
															}
														>
															{(gathered) => (
																<div
																	{...stylex.attrs(styles.detail)}
																>
																	<GatheredDetail
																		focus={gathered()}
																	/>
																	<TranslationsDetail
																		model={localization}
																		edits={edits}
																		review={translationReview()}
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
																	value={sourceText(
																		current().unit
																	)}
																/>
															</div>
															<div {...stylex.attrs(styles.bar)}>
																<code
																	{...stylex.attrs(styles.mono)}
																>
																	{identityLabel(current().unit)}
																</code>
																<Show
																	when={
																		current().unit.identity
																			.status !== "unresolved"
																	}
																>
																	<CopyButton
																		label="Copy key"
																		value={identityLabel(
																			current().unit
																		)}
																	/>
																</Show>
															</div>
															<span {...stylex.attrs(styles.muted)}>
																{focusStats(current())}
															</span>
															<Show
																when={current().unit.reviewSignals.some(
																	(signal) =>
																		signal !== "evidence_only"
																)}
															>
																<span
																	{...stylex.attrs(styles.muted)}
																>
																	{current()
																		.unit.reviewSignals.filter(
																			(signal) =>
																				signal !==
																				"evidence_only"
																		)
																		.map(textReviewSignalLabel)
																		.join(" · ")}
																</span>
															</Show>
															<GameTextIdRepairs
																focus={current()}
																detail={localization.detail()}
																client={props.client}
																projectKey={projectKey()}
																target={localization.target()}
																nativeCulture={
																	localization.active()?.target
																		.nativeCulture ?? undefined
																}
																edits={edits}
																busy={
																	loading() || operations.busy()
																}
																onApplied={() => load(true)}
															/>
															<TranslationsDetail
																model={localization}
																edits={edits}
																review={translationReview()}
															/>
															<h3 {...stylex.attrs(styles.section)}>
																Where it appears
															</h3>
															<For each={current().occurrences}>
																{(occurrence) => (
																	<OccurrenceCard
																		client={props.client}
																		occurrence={occurrence}
																		conflicting={
																			current().unit.source
																				.status ===
																			"conflicting"
																		}
																		onOpenDataAuthoring={
																			props.onOpenDataAuthoring
																		}
																	/>
																)}
															</For>
															<CoverageNotes
																diagnostics={current().diagnostics}
															/>
															<Show
																when={
																	current().nextOccurrenceCursor
																}
															>
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
																				current()
																					.totalOccurrences -
																					current()
																						.occurrences
																						.length
																			),
																			"more location"
																		)}
																	</Button>
																)}
															</Show>
														</div>
													)}
												</Show>
											</div>
											<Show when={lineOpen()}>
												<LineProperties
													focus={focus()}
													detail={localization.detail()}
												/>
											</Show>
										</div>
									</aside>
								</div>
							</div>
						</Show>
					</Show>
				</Show>
			</div>
			<Show when={mode() === "corpus" ? summary() : undefined}>
				{(_current) => (
					<footer {...stylex.attrs(browseStyles.footer)}>
						<BrowseSummary page={page()} />
						<span {...stylex.attrs(styles.grow)} />
						<Show when={!indexBusy() && preparationSeconds() !== undefined}>
							<span title="Time from opening the project to its first results">
								Ready in {elapsedTime(preparationSeconds() ?? 0)}
							</span>
						</Show>
						<Show when={queryMs() !== undefined}>
							<span title="Last successful query round trip, excluding the typing debounce">
								Last query {Math.round(queryMs() ?? 0)} ms
							</span>
						</Show>
						<Show when={localization.active()}>
							{(active) => (
								<span>
									{localization.cultures().length > 0
										? `${localization.cultures().length.toLocaleString()} of `
										: ""}
									{textCountLabel(active().target.cultures.length, "culture")}
								</span>
							)}
						</Show>
					</footer>
				)}
			</Show>
		</main>
	);
}

const COPY_KIND_LABELS = {
	generated_class: "compiled class copy",
	instance: "compiled animation copy",
	class_default: "class defaults copy",
	skeleton: "skeleton class copy"
} as const satisfies Record<TextCopyKind, string>;

export function OccurrenceCard(props: {
	readonly client: Pick<GameTextClientApi, "locateAsset">;
	readonly occurrence: TextOccurrence;
	readonly conflicting: boolean;
	readonly onOpenDataAuthoring?: ((objectPath: string) => void) | undefined;
}) {
	// The game runs the generated class and its defaults: only their text is what players see.
	// A skeleton class serves the editor, so its other text is listed below, not claimed here.
	const staleCopy = () => staleRuntimeCopy(props.occurrence);
	return (
		<article {...stylex.attrs(styles.card)}>
			<div {...stylex.attrs(styles.bar)}>
				<strong>{textLocationLabel(props.occurrence.location)}</strong>
				<span {...stylex.attrs(styles.muted, styles.exports)}>
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
			<Show when={staleCopy()}>
				{(copy) => (
					<p {...stylex.attrs(styles.notes)}>
						Blueprint not compiled since this text was edited. The game shows "
						{copy().source}".
					</p>
				)}
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
				<For each={props.occurrence.copies ?? []}>
					{(copy) => (
						<code {...stylex.attrs(styles.mono)}>
							{copy.objectPath} ({COPY_KIND_LABELS[copy.kind]}
							{copy.source === props.occurrence.source
								? ""
								: `, holds "${copy.source}"`}
							)
						</code>
					)}
				</For>
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

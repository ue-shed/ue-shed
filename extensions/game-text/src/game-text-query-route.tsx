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
	type TextQualityQueryRunResult,
	type TextQualityQuerySummary,
	type TextQualityRuleDocument,
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
import { createGameTextRuleState } from "./game-text-rule-state.js";
import {
	readGameTextPreferences,
	saveGameTextPreferences,
	type GameTextPreferences
} from "./game-text-preferences.js";
import { identityLabel, locationDetail, sourceText, textContext } from "./game-text-view.js";
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
	const [mode, setMode] = createSignal<"corpus" | "quality">(initial?.mode ?? "corpus");
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
	const [qualitySummary, setQualitySummary] = createSignal<TextQualityQuerySummary>();
	const [qualityDocument, setQualityDocument] = createSignal<TextQualityRuleDocument | undefined>(
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

	const searchRequest = (): TextCorpusSearchRequest => ({
		query: query(),
		capability: capability(),
		lens: lens(),
		withoutNotes: withoutNotes(),
		pageSize: 50
	});
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
							request.cursor && previous
								? {
										...result.page,
										units: [...previous.units, ...result.page.units]
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
		() => ({ summary: summary(), request: searchRequest() }),
		({ summary: current, request }) => {
			if (current) requestPage(request, true);
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
				qualityEditor: editor.state()
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
	const exports = (): JSX.Element => (
		<Show when={props.client.investigations}>
			{(client) => (
				<div {...stylex.attrs(styles.exports)}>
					<InvestigationActions
						compact
						client={client()}
						disabled={
							!summary() || (mode() === "corpus" ? searching() : !qualitySummary())
						}
						revision={[summary(), qualitySummary()]}
						query={{
							mode: mode(),
							query: query(),
							capability: capability(),
							lens: lens(),
							withoutNotes: withoutNotes(),
							qualityFilter: qualityFilter()
						}}
						onOpen={restorePreset}
					/>
				</div>
			)}
		</Show>
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
							: qualitySummary()
								? " (" + qualitySummary()?.findingCount + ")"
								: ""}
					</button>
				</div>
				<Show when={summary()}>
					{(current) => (
						<span {...stylex.attrs(styles.coverage)}>
							<b>{current().counts.all.toLocaleString()}</b>{" "}
							{current().counts.all === 1 ? "line" : "lines"} in{" "}
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
					<Button size="compact" disabled={loading()} onClick={() => load(true)}>
						Rescan
					</Button>
				</Show>
			</div>
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
					when={mode() === "corpus"}
					fallback={
						<Show
							when={qualitySummary()}
							fallback={
								<section
									aria-label="Quality rules setup"
									{...stylex.attrs(styles.card)}
								>
									<p>
										<strong>Set up writing checks</strong> with a rules file for
										character limits and terminology. The starter file contains
										examples you can customize.
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
											<Button tone="primary" onClick={() => loadRules(false)}>
												Create rules file
											</Button>
										</Show>
										<Show when={qualityFailure()?.code === "already_exists"}>
											<Button onClick={() => loadRules(true)}>
												Load existing rules
											</Button>
										</Show>
										<Button onClick={() => loadRules()}>Load rules</Button>
									</div>
								</section>
							}
						>
							{(quality) => (
								<Show when={qualityDocument()}>
									{(document) => (
										<GameTextQualityWorkspace
											client={props.client}
											summary={quality()}
											document={document()}
											editor={editor}
											filter={qualityFilter()}
											onFilterChange={setQualityFilter}
											onReplaceRules={reloadRules}
											onLoadRules={() => loadRules()}
											selectedId={selectedFindingId()}
											onSelectionChange={setSelectedFindingId}
											exports={exports()}
											onShowText={(id) => {
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
									placeholder="Search text"
									maxlength={512}
									disabled={loading()}
									value={query()}
									{...stylex.attrs(styles.input)}
									onInput={(event) => setQuery(event.currentTarget.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") requestPage(searchRequest());
									}}
								/>
								<span role="status" {...stylex.attrs(styles.count)}>
									{searching() || !page()
										? "Searching…"
										: page()?.total === 1
											? "1 match"
											: page()?.total.toLocaleString() + " matches"}
								</span>
							</div>
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
									const next = capability() === "read_only" ? "all" : "read_only";
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
										count={searching() ? undefined : page()?.counts[item.value]}
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
							{exports()}
						</div>
						<div {...stylex.attrs(styles.grid)}>
							<section aria-label="Results" {...stylex.attrs(styles.pane)}>
								<For each={page()?.units ?? []}>
									{(unit) => (
										<button
											type="button"
											aria-current={
												selectedId() === unit.id ? "true" : undefined
											}
											onClick={() => {
												setSelectedId(unit.id);
											}}
											{...stylex.attrs(
												styles.row,
												selectedId() === unit.id && styles.selected
											)}
										>
											<span {...stylex.attrs(styles.rowText)}>
												{sourceText(unit)}
											</span>
											<span
												title={unit.contexts[0]?.location.objectPath}
												{...stylex.attrs(styles.context)}
											>
												{unit.contexts[0]
													? textContext(unit.contexts[0].location).title
													: ""}
												{unit.occurrenceCount > 1
													? " · +" + (unit.occurrenceCount - 1) + " more"
													: ""}
												<span {...stylex.attrs(styles.warning)}>
													{unit.reviewSignals
														.filter(
															(signal) => signal !== "evidence_only"
														)
														.map(
															(signal) =>
																" · " +
																textReviewSignalLabel(signal)
														)
														.join("")}
												</span>
											</span>
										</button>
									)}
								</For>
								<Show when={!searching() && page()?.units.length === 0}>
									<p {...stylex.attrs(styles.empty)}>
										No text matches these filters.
									</p>
								</Show>
								<Show when={page()?.nextCursor}>
									{(cursor) => (
										<Button
											disabled={searching()}
											onClick={() =>
												requestPage({
													...searchRequest(),
													cursor: cursor()
												})
											}
										>
											Show{" "}
											{Math.min(
												50,
												(page()?.total ?? 0) - (page()?.units.length ?? 0)
											)}{" "}
											more
										</Button>
									)}
								</Show>
							</section>
							<aside aria-label="Text focus" {...stylex.attrs(styles.pane)}>
								<Show
									when={focus()}
									fallback={
										<p {...stylex.attrs(styles.empty)}>
											Select a line to see its key, translator notes and every
											place it appears.
										</p>
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
															(signal) => signal !== "evidence_only"
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
											<CoverageNotes diagnostics={current().diagnostics} />
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

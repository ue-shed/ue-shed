import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { localizationCheckCatalogue, parseLocalizationRuleId } from "@ue-shed/game-text/checks";
import {
	BuiltInQualityFilter,
	workspaceQualityLabel,
	type LocalizationFocus,
	type LocalizationReviewChange,
	type TextQualityFindingId,
	type TextQualityQuerySummary,
	type WorkspaceQualityFilter,
	type WorkspaceQualityFocusResult,
	type WorkspaceQualityPage
} from "@ue-shed/game-text/corpus";
import { textCountLabel, textLocationLabel } from "@ue-shed/game-text/labels";
import { type GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { type LocalizationCheckDiagnostic, type TextUnitId } from "@ue-shed/game-text/schema";
import { Button, Chip, createEffectAction } from "@ue-shed/ui";
import { Effect } from "effect";
import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import { changeRanges } from "./game-text-change-ranges.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { CopyButton } from "./game-text-copy-button.js";
import type { GameTextLocalizationState } from "./game-text-localization-state.js";
import { TranslationsDetail, unknownLabels } from "./game-text-localization-view.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { qualityFindingFacts } from "./game-text-quality-workspace.js";
import { GameTextRuleEditor } from "./game-text-rule-editor.js";
import type { GameTextRuleState } from "./game-text-rule-state.js";
import { styles } from "./game-text-styles.js";
import { locationDetail } from "./game-text-view.js";

/** A built-in check's catalogue label; a project rule keeps its own ID. */
function ruleLabel(ruleId: string): string {
	const check = parseLocalizationRuleId(ruleId);
	return check ? localizationCheckCatalogue[check].label : ruleId;
}

const checkLimitLabels = {
	...unknownLabels,
	source_unavailable: "Gathered source text is unavailable",
	translation_unavailable: "Translation evidence is unavailable",
	unsupported_culture: "Some language forms cannot be checked",
	syntax_limit: "Some text exceeds the format check's limit",
	reduced_source_checking: "This PO format stores less source information"
} satisfies Record<LocalizationCheckDiagnostic["code"], string>;

type Focus = Extract<WorkspaceQualityFocusResult, { status: "found" }>["focus"];
export function FindingText(props: {
	readonly text: string;
	readonly ranges: readonly { readonly start: number; readonly end: number }[];
}) {
	const pieces = () => {
		let cursor = 0;
		const result: Array<{ text: string; highlighted: boolean }> = [];
		for (const range of props.ranges) {
			const start = Math.max(cursor, range.start),
				end = Math.min(props.text.length, range.end);
			if (end <= start) continue;
			result.push(
				{ text: props.text.slice(cursor, start), highlighted: false },
				{ text: props.text.slice(start, end), highlighted: true }
			);
			cursor = end;
		}
		result.push({ text: props.text.slice(cursor), highlighted: false });
		return result;
	};
	return (
		<For each={pieces()}>
			{(piece) => (
				<Show when={piece.highlighted} fallback={piece.text}>
					<mark {...stylex.attrs(styles.mark)}>{piece.text}</mark>
				</Show>
			)}
		</For>
	);
}

export function GameTextLocalizationQuality(props: {
	readonly disabled?: boolean;
	readonly client: GameTextClientApi;
	readonly localization: GameTextLocalizationState;
	readonly summary: TextQualityQuerySummary | undefined;
	readonly document: GameTextRuleDocument | undefined;
	readonly editor: GameTextRuleState;
	readonly setup: JSX.Element;
	readonly exports?: JSX.Element;
	readonly filter: WorkspaceQualityFilter;
	readonly onFilterChange: (filter: WorkspaceQualityFilter) => void;
	readonly selectedId: TextQualityFindingId | undefined;
	readonly onSelectionChange: (id: TextQualityFindingId | undefined) => void;
	readonly onLoadRules: () => void;
	readonly onReloadRules: () => void;
	readonly onShowText: (id: TextUnitId) => void;
}) {
	const search = createEffectAction(),
		focusAction = createEffectAction(),
		copy = createEffectAction(),
		proposals = createEffectAction();
	const [page, setPage] = createSignal<WorkspaceQualityPage>();
	const [focus, setFocus] = createSignal<Focus>();
	const [loading, setLoading] = createSignal(true),
		[detailLoading, setDetailLoading] = createSignal(false);
	const [editing, setEditing] = createSignal(false);
	const [message, setMessage] = createSignal<string>();
	const [failed, setFailed] = createSignal(false);
	let revision = 0,
		focusRevision = 0;
	const acceptAction = createEffectAction();
	const [accepting, setAccepting] = createSignal(false);
	/** Records the finding as accepted in the review file; it returns if its text changes. */
	const accept = (
		finding: { readonly ruleId: string; readonly culture: LocalizationReviewChange["culture"] },
		identity: NonNullable<LocalizationFocus["identity"]>
	) => {
		const request = props.client.localizationReview;
		const target = props.localization.target();
		if (!request || !target) return;
		setAccepting(true);
		acceptAction.run(
			request({
				target,
				changes: [
					{
						kind: "accept",
						check: finding.ruleId,
						culture: finding.culture,
						namespace: identity.namespace,
						key: identity.key
					}
				]
			}),
			{
				onSuccess: (result) => {
					setAccepting(false);
					if (result.status === "written") {
						setMessage(
							"Finding accepted. It returns if the source or translation changes."
						);
						props.onSelectionChange(undefined);
						load();
					} else if (result.status === "failed")
						setMessage(`${result.message} ${result.recovery}`);
				},
				onFailure: () => {
					setAccepting(false);
					setMessage("The finding could not be accepted. Rescan and try again.");
				}
			}
		);
	};
	const selection = () => {
		const target = props.localization.target(),
			culture = props.localization.culture();
		return target ? { target, ...(culture ? { culture } : undefined) } : undefined;
	};
	const load = (offset?: number) => {
		const selected = untrack(selection),
			operation = props.client.localizationQualitySearch;
		if (!selected || !operation || !untrack(() => props.document)) return;
		const version = ++revision;
		setLoading(true);
		search.run(
			operation({
				...selected,
				filter: props.filter,
				...(offset !== undefined ? { offset } : undefined)
			}),
			{
				onFailure: () => {
					if (version === revision) {
						setLoading(false);
						setFailed(true);
						setMessage("Couldn’t load findings. Rescan to try again.");
					}
				},
				onSuccess: (result) => {
					if (version !== revision) return;
					setLoading(false);
					if (result.status === "ready") {
						setPage((previous) =>
							offset && previous
								? {
										...result.page,
										findings: [...previous.findings, ...result.page.findings]
									}
								: result.page
						);
					} else {
						setFailed(true);
						setMessage(
							result.status === "failed"
								? result.message + " " + result.recovery
								: "Quality checks are unavailable. Rescan to try again."
						);
					}
				}
			}
		);
	};
	const loadFocus = (
		id: TextQualityFindingId,
		occurrenceOffset?: number,
		poContextOffset?: number
	) => {
		const selected = untrack(selection),
			operation = props.client.localizationQualityFocus;
		if (!selected || !operation) return;
		const version = ++focusRevision;
		setDetailLoading(true);
		focusAction.run(
			operation({
				...selected,
				id,
				...(occurrenceOffset !== undefined ? { occurrenceOffset } : undefined),
				...(poContextOffset !== undefined ? { poContextOffset } : undefined)
			}),
			{
				onFailure: () => {
					if (version === focusRevision) {
						setDetailLoading(false);
						setFailed(true);
						setMessage("Couldn’t load finding details.");
					}
				},
				onSuccess: (result) => {
					if (version !== focusRevision) return;
					setDetailLoading(false);
					if (result.status === "found") {
						const next = result.focus;
						setFocus((previous) => {
							if (
								next.kind === "source" &&
								previous?.kind === "source" &&
								occurrenceOffset
							)
								return {
									...next,
									focus: {
										...next.focus,
										affectedOccurrences: [
											...previous.focus.affectedOccurrences,
											...next.focus.affectedOccurrences
										]
									}
								};
							if (
								next.kind === "localization" &&
								previous?.kind === "localization" &&
								(occurrenceOffset || poContextOffset)
							)
								return {
									...next,
									affectedOccurrences: occurrenceOffset
										? [
												...previous.affectedOccurrences,
												...next.affectedOccurrences
											]
										: previous.affectedOccurrences,
									translations: {
										...next.translations,
										locations: occurrenceOffset
											? [
													...previous.translations.locations,
													...next.translations.locations
												]
											: previous.translations.locations,
										translations: next.translations.translations.map((mark) => {
											const old = previous.translations.translations.find(
												(item) => item.culture === mark.culture
											);
											return poContextOffset && old
												? {
														...mark,
														translatorComments: [
															...old.translatorComments,
															...mark.translatorComments
														],
														flags: [...old.flags, ...mark.flags]
													}
												: mark;
										})
									}
								};
							return next;
						});
					} else {
						setFocus(undefined);
						if (result.status === "not_found") props.onSelectionChange(undefined);
					}
				}
			}
		);
	};
	createEffect(
		() => ({
			target: props.localization.active(),
			culture: props.localization.culture(),
			document: props.document,
			summary: props.summary,
			filter: props.filter
		}),
		() => {
			proposals.cancel();
			copy.cancel();
			setPage(undefined);
			setMessage(undefined);
			setFailed(false);
			load();
		}
	);
	createEffect(
		() => ({
			selection: selection(),
			id: props.selectedId,
			document: props.document,
			summary: props.summary
		}),
		({ id }) => {
			focusRevision++;
			focusAction.cancel();
			setFocus(undefined);
			setDetailLoading(false);
			if (id) loadFocus(id);
		}
	);
	const writeClipboard = (contents: string, success: string) =>
		copy.run(
			Effect.tryPromise({
				try: () => navigator.clipboard.writeText(contents),
				catch: String
			}),
			{
				onSuccess: () => {
					setFailed(false);
					setMessage(success);
				},
				onFailure: () => {
					setFailed(true);
					setMessage("Could not copy. Try again.");
				}
			}
		);
	const resolveAll = () => {
		const selected = untrack(selection),
			operation = props.client.localizationChanges;
		if (!selected || !operation) return;
		const version = revision;
		proposals.run(operation({ ...selected, filter: props.filter }), {
			onSuccess: (result) => {
				if (version !== revision) return;
				if (result.status === "ready") {
					writeClipboard(
						JSON.stringify(result.document, null, 2),
						textCountLabel(result.document.changes.length, "suggested fix") +
							" copied." +
							(result.remaining
								? " " +
									textCountLabel(result.remaining, "more fix") +
									" exceed this copy's limit. Narrow the filters."
								: "")
					);
				} else {
					setFailed(true);
					setMessage(
						result.status === "failed"
							? result.message
							: "Suggested fixes are unavailable."
					);
				}
			},
			onFailure: () => {
				setFailed(true);
				setMessage("Could not load suggested fixes.");
			}
		});
	};
	const localizedFocus = () => {
		const current = focus();
		return current?.kind === "localization" ? current : undefined;
	};
	const sourceFocus = () => {
		const current = focus();
		return current?.kind === "source" ? current.focus : undefined;
	};
	const occurrences = () =>
		localizedFocus()?.affectedOccurrences ?? sourceFocus()?.affectedOccurrences ?? [];
	const sourceRanges = () => {
		const current = sourceFocus();
		return current?.kind === "terminology"
			? [
					{
						start: current.actual.start - current.sourceOffset,
						end: current.actual.end - current.sourceOffset
					}
				]
			: [];
	};
	/** Built-in filters, then the rule file's custom checks, as the page lists them. */
	const filters = (): readonly WorkspaceQualityFilter[] => [
		...BuiltInQualityFilter.literals,
		...(page()?.customFilters ?? []).map(({ filter }) => filter)
	];
	const customLabels = () =>
		new Map((page()?.customFilters ?? []).map(({ filter, label }) => [filter, label]));
	const editorSummary = () =>
		props.summary
			? { ...props.summary, rules: page()?.rules ?? props.summary.rules }
			: undefined;
	// Without a rules file nothing runs, so Quality shows only how to add one.
	return (
		<Show when={props.document} fallback={props.setup}>
			<div {...stylex.attrs(styles.workspace)}>
				<div {...stylex.attrs(styles.bar)}>
					<For
						each={filters().filter(
							(filter) =>
								filter === "all" ||
								filter === props.filter ||
								(page()?.counts[filter] ?? 0) > 0
						)}
					>
						{(filter) => (
							<Chip
								label={workspaceQualityLabel(filter, customLabels())}
								selected={props.filter === filter}
								count={loading() ? undefined : page()?.counts[filter]}
								onClick={() => props.onFilterChange(filter)}
							/>
						)}
					</For>
					<div
						title="Exports and presets include the matching source and translation findings."
						{...stylex.attrs(styles.exports)}
					>
						{props.exports}
					</div>
					<Show when={(page()?.suggestedFixCount ?? 0) > 0}>
						<Button
							size="compact"
							tone="quiet"
							disabled={loading()}
							onClick={resolveAll}
						>
							Resolve all: copy suggested fixes (
							{page()?.suggestedFixCount.toLocaleString()})
						</Button>
					</Show>
					<Show when={props.document}>
						<Button
							size="compact"
							tone="quiet"
							disabled={props.disabled}
							onClick={props.onReloadRules}
						>
							Reload rules
						</Button>
						<Button
							size="compact"
							tone="quiet"
							disabled={props.disabled}
							onClick={() => setEditing(!editing())}
						>
							{editing() ? "Close rules" : "Edit rules"}
						</Button>
					</Show>
					<Show when={editing()}>
						<Button
							size="compact"
							tone="quiet"
							disabled={props.disabled}
							onClick={props.onLoadRules}
						>
							Choose another rules file…
						</Button>
					</Show>
				</div>
				<Show
					when={
						!loading() &&
						((page()?.limits.length ?? 0) > 0 ||
							(page()?.unsupportedRuleCultures ?? 0) > 0)
					}
				>
					<p {...stylex.attrs(styles.empty)}>
						Checks limited:{" "}
						{(page()?.limits ?? [])
							.map(
								(limit) =>
									checkLimitLabels[limit.code] +
									" (" +
									limit.count.toLocaleString() +
									")"
							)
							.join(" · ")}
						<Show when={(page()?.unsupportedRuleCultures ?? 0) > 0}>
							{" "}
							· Some rules name cultures outside this target.
						</Show>
					</p>
				</Show>
				<Show when={message()}>
					<span
						role={failed() ? "alert" : "status"}
						{...stylex.attrs(styles.muted, failed() && styles.warning)}
					>
						{message()}
					</span>
				</Show>
				<Show
					when={!editing()}
					fallback={
						<Show when={props.editor.state()}>
							{(state) => (
								<Show when={editorSummary()}>
									{(summary) => (
										<GameTextRuleEditor
											disabled={props.disabled}
											editor={props.editor}
											state={state()}
											summary={summary()}
										/>
									)}
								</Show>
							)}
						</Show>
					}
				>
					<div {...stylex.attrs(styles.grid)}>
						<section aria-label="Findings" {...stylex.attrs(styles.pane)}>
							<For each={page()?.findings ?? []}>
								{(finding) => (
									<button
										type="button"
										aria-current={
											props.selectedId === finding.id ? "true" : undefined
										}
										onClick={() => props.onSelectionChange(finding.id)}
										{...stylex.attrs(
											styles.row,
											props.selectedId === finding.id && styles.selected
										)}
									>
										<span {...stylex.attrs(styles.rowText)}>
											{finding.source}
										</span>
										<span {...stylex.attrs(styles.context)}>
											<Show when={finding.severity === "blocking"}>
												<span {...stylex.attrs(styles.danger)}>
													Blocking
												</span>
												{" · "}
											</Show>
											{finding.problem}
										</span>
										<span {...stylex.attrs(styles.context, styles.mono)}>
											{finding.context.startsWith(finding.problem + " · ")
												? finding.context.slice(finding.problem.length + 3)
												: finding.context}
										</span>
									</button>
								)}
							</For>
							<Show when={loading()}>
								<p role="status" {...stylex.attrs(styles.empty)}>
									Loading findings…
								</p>
							</Show>
							<Show when={!loading() && page()?.total === 0}>
								<p {...stylex.attrs(styles.empty)}>
									No findings match this filter. Results cover the scanned,
									readable text; an incomplete scan can miss findings.
								</p>
							</Show>
							<Show when={page()?.nextOffset !== undefined}>
								<Button
									disabled={loading()}
									onClick={() => load(page()?.nextOffset)}
								>
									Show{" "}
									{Math.min(
										50,
										(page()?.total ?? 0) - (page()?.findings.length ?? 0)
									)}{" "}
									more
								</Button>
							</Show>
						</section>
						<aside aria-label="Finding detail" {...stylex.attrs(styles.pane)}>
							<div {...stylex.attrs(styles.detail)}>
								<Show
									when={!detailLoading() || focus()}
									fallback={
										<p role="status" {...stylex.attrs(styles.empty)}>
											Loading finding details…
										</p>
									}
								>
									<Show
										when={focus()}
										fallback={
											<Show
												when={!loading() && page()}
												fallback={
													loading() ? (
														<p
															role="status"
															{...stylex.attrs(styles.muted)}
														>
															Loading quality checks…
														</p>
													) : undefined
												}
											>
												<table
													aria-label="Rules overview"
													{...stylex.attrs(styles.table)}
												>
													<thead>
														<tr>
															<th>Rule</th>
															<th>Findings</th>
														</tr>
													</thead>
													<tbody>
														<For each={page()?.rules ?? []}>
															{(rule) => (
																<tr>
																	<td title={rule.ruleId}>
																		{ruleLabel(rule.ruleId)}
																	</td>
																	<td>{rule.findingCount}</td>
																</tr>
															)}
														</For>
													</tbody>
												</table>
												<table
													aria-label="Roles overview"
													{...stylex.attrs(styles.table)}
												>
													<thead>
														<tr>
															<th>Role</th>
															<th>Lines in scope</th>
														</tr>
													</thead>
													<tbody>
														<For each={props.summary?.roles ?? []}>
															{(role) => (
																<tr>
																	<td>{role.role}</td>
																	<td>
																		<Show
																			when={
																				role.matchedTextUnits >
																				0
																			}
																			fallback={
																				<span
																					{...stylex.attrs(
																						styles.warning
																					)}
																				>
																					None: check this
																					role's matchers
																				</span>
																			}
																		>
																			{role.matchedTextUnits}
																		</Show>
																	</td>
																</tr>
															)}
														</For>
													</tbody>
												</table>
												<span {...stylex.attrs(styles.muted)}>
													Select a finding to see its source, translation
													and how to fix it.
												</span>
											</Show>
										}
									>
										<Show when={localizedFocus()}>
											{(finding) => (
												<>
													<span {...stylex.attrs(styles.muted)}>
														{workspaceQualityLabel(
															finding().check,
															customLabels()
														)}{" "}
														· {finding().culture}
													</span>
													<span {...stylex.attrs(styles.muted)}>
														Source
													</span>
													<h2 {...stylex.attrs(styles.title)}>
														<FindingText
															text={finding().source}
															ranges={finding().sourceRanges}
														/>
													</h2>
													<span {...stylex.attrs(styles.muted)}>
														{finding().translationOrigin === "po"
															? "Translation in PO, not synced"
															: finding().translationOrigin ===
																  "archive"
																? "Translation the game uses"
																: "No translation"}
													</span>
													<p {...stylex.attrs(styles.notes)}>
														<FindingText
															text={
																finding().translation ??
																"No translation"
															}
															ranges={finding().translationRanges}
														/>
													</p>
													<Show when={finding().truncated}>
														<span {...stylex.attrs(styles.muted)}>
															Text preview shortened.
														</span>
													</Show>
													<span {...stylex.attrs(styles.findingFacts)}>
														{finding().problem}
													</span>
													<h3 {...stylex.attrs(styles.section)}>
														How to fix
													</h3>
													<p {...stylex.attrs(styles.notes)}>
														{finding().recovery}
													</p>
													<Show
														when={
															props.client.localizationReview &&
															finding().translations.identity
														}
													>
														{(identity) => (
															<div
																{...stylex.attrs(
																	styles.inlineAction
																)}
															>
																<Button
																	size="compact"
																	tone="quiet"
																	disabled={
																		props.disabled ||
																		accepting()
																	}
																	title="Stop reporting this finding until the source or translation changes."
																	onClick={() =>
																		accept(
																			finding(),
																			identity()
																		)
																	}
																>
																	Accept as intended
																</Button>
															</div>
														)}
													</Show>
													<Show when={finding().suggestedChange}>
														{(change) => (
															<section
																aria-label="Suggested fix"
																{...stylex.attrs(
																	styles.detailSection
																)}
															>
																<h3
																	{...stylex.attrs(
																		styles.section
																	)}
																>
																	Suggested fix
																</h3>
																<span
																	{...stylex.attrs(styles.muted)}
																>
																	Before
																</span>
																<p {...stylex.attrs(styles.notes)}>
																	<FindingText
																		text={
																			change()
																				.previousTranslation ??
																			""
																		}
																		ranges={
																			changeRanges(
																				change()
																					.previousTranslation ??
																					"",
																				change().translation
																			).before
																		}
																	/>
																</p>
																<span
																	{...stylex.attrs(styles.muted)}
																>
																	After
																</span>
																<p {...stylex.attrs(styles.notes)}>
																	<FindingText
																		text={change().translation}
																		ranges={
																			changeRanges(
																				change()
																					.previousTranslation ??
																					"",
																				change().translation
																			).after
																		}
																	/>
																</p>
																<Button
																	size="compact"
																	tone="quiet"
																	onClick={() =>
																		writeClipboard(
																			JSON.stringify(
																				{
																					schemaVersion: 1,
																					provenance: {
																						producer:
																							"ue-shed.localization.checks",
																						files: []
																					},
																					changes: [
																						change()
																					]
																				},
																				null,
																				2
																			),
																			"Change set copied."
																		)
																	}
																>
																	Copy change set
																</Button>
																<span
																	{...stylex.attrs(styles.muted)}
																>
																	Edit the translation in Text to
																	stage it, or copy the change set
																	for ue-shed loc apply.
																</span>
															</section>
														)}
													</Show>
													<Show when={finding().textUnitId}>
														{(id) => (
															<div
																{...stylex.attrs(
																	styles.inlineAction
																)}
															>
																<Button
																	size="compact"
																	onClick={() =>
																		props.onShowText(id())
																	}
																>
																	Show key and translator notes
																</Button>
															</div>
														)}
													</Show>
												</>
											)}
										</Show>
										<Show when={sourceFocus()}>
											{(finding) => (
												<>
													<span {...stylex.attrs(styles.muted)}>
														{finding().kind === "character_budget"
															? "Character limit"
															: "Terminology"}
													</span>
													<h2 {...stylex.attrs(styles.title)}>
														<FindingText
															text={finding().sourceExcerpt}
															ranges={sourceRanges()}
														/>
													</h2>
													<Show when={finding().sourceTruncated}>
														<span {...stylex.attrs(styles.muted)}>
															Text preview shortened.
														</span>
													</Show>
													<span {...stylex.attrs(styles.findingFacts)}>
														{qualityFindingFacts(finding())}
													</span>
													<h3 {...stylex.attrs(styles.section)}>
														How to fix
													</h3>
													<p {...stylex.attrs(styles.notes)}>
														{finding().recovery}
													</p>
													<div {...stylex.attrs(styles.inlineAction)}>
														<Button
															size="compact"
															onClick={() =>
																props.onShowText(
																	finding().textUnitId
																)
															}
														>
															Show key and translator notes
														</Button>
													</div>
												</>
											)}
										</Show>
										<h3 {...stylex.attrs(styles.section)}>Where it appears</h3>
										<For each={occurrences()}>
											{(occurrence) => (
												<article {...stylex.attrs(styles.card)}>
													<strong>
														{textLocationLabel(occurrence.location)}
													</strong>
													<code {...stylex.attrs(styles.mono)}>
														{occurrence.location.objectPath}
													</code>
													<span {...stylex.attrs(styles.muted)}>
														{locationDetail(occurrence.location)}
													</span>
													<details>
														<summary {...stylex.attrs(styles.muted)}>
															Saved file
														</summary>
														<code {...stylex.attrs(styles.mono)}>
															{occurrence.packageFile}
														</code>
													</details>
													<div {...stylex.attrs(styles.bar)}>
														<CopyButton
															label="Copy asset path"
															value={occurrence.location.objectPath}
														/>
														<ShowInUnrealButton
															client={props.client}
															objectPath={
																occurrence.location.objectPath
															}
														/>
													</div>
												</article>
											)}
										</For>
										<Show
											when={
												localizedFocus()?.nextOccurrenceOffset !== undefined
											}
										>
											<Button
												size="compact"
												onClick={() => {
													const current = localizedFocus();
													if (current)
														loadFocus(
															current.id,
															current.nextOccurrenceOffset
														);
												}}
											>
												Show{" "}
												{textCountLabel(
													Math.min(
														50,
														(localizedFocus()?.totalOccurrences ??
															sourceFocus()?.totalOccurrences ??
															0) - occurrences().length
													),
													"more location"
												)}
											</Button>
										</Show>
										<Show when={sourceFocus()?.nextOccurrenceCursor}>
											<Button
												size="compact"
												onClick={() => {
													const current = sourceFocus();
													if (current)
														loadFocus(
															current.id,
															current.affectedOccurrences.length
														);
												}}
											>
												Show{" "}
												{textCountLabel(
													Math.min(
														50,
														(localizedFocus()?.totalOccurrences ??
															sourceFocus()?.totalOccurrences ??
															0) - occurrences().length
													),
													"more location"
												)}
											</Button>
										</Show>
										<Show when={localizedFocus()}>
											{(finding) => (
												<TranslationsDetail
													model={props.localization}
													focus={finding().translations}
													onMore={(_, offset) =>
														loadFocus(finding().id, offset)
													}
													onMoreContext={(culture) =>
														loadFocus(
															finding().id,
															undefined,
															finding().translations.translations.find(
																(mark) => mark.culture === culture
															)?.nextContextOffset
														)
													}
												/>
											)}
										</Show>
									</Show>
								</Show>
							</div>
						</aside>
					</div>
				</Show>
			</div>
		</Show>
	);
}

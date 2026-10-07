import * as stylex from "@stylexjs/stylex";
import {
	WorkspaceQualityFilter,
	workspaceQualityLabels,
	textCountLabel,
	textLocationLabel,
	type WorkspaceQualityPage,
	type WorkspaceQualityFocusResult,
	type TextQualityFindingId,
	type TextQualityQuerySummary,
	type TextUnitId,
	type GameTextRuleDocument,
	type LocalizationCheckDiagnostic
} from "@ue-shed/game-text/browser";
import { Button, Chip, createEffectAction } from "@ue-shed/ui";
import { Effect } from "effect";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { GameTextClientApi } from "./game-text-client.js";
import type { GameTextLocalizationState } from "./game-text-localization-state.js";
import type { GameTextRuleState } from "./game-text-rule-state.js";
import { GameTextRuleEditor } from "./game-text-rule-editor.js";
import { qualityFindingFacts } from "./game-text-quality-workspace.js";
import { CopyButton } from "./game-text-copy-button.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { unknownLabels, TranslationsDetail } from "./game-text-localization-view.js";
import { styles } from "./game-text-styles.js";
import { locationDetail } from "./game-text-view.js";

function argumentRange(text: string, start: number, end: number) {
	for (const token of text.matchAll(/\{[^{}\r\n]+\}/gu)) {
		const tokenEnd = token.index + token[0].length;
		const overlaps = token.index < end && tokenEnd > start;
		const insertion = start === end && token.index < start && start < tokenEnd;
		if (overlaps || insertion) {
			start = Math.min(start, token.index);
			end = Math.max(end, tokenEnd);
		}
	}
	return start < end ? [{ start, end }] : [];
}

export function changeRanges(before: string, after: string) {
	if (before === after) return { before: [], after: [] };
	let start = 0,
		tail = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	while (
		tail < before.length - start &&
		tail < after.length - start &&
		before[before.length - tail - 1] === after[after.length - tail - 1]
	)
		tail++;
	return {
		before: argumentRange(before, start, before.length - tail),
		after: argumentRange(after, start, after.length - tail)
	};
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
	readonly filter: typeof WorkspaceQualityFilter.Type;
	readonly onFilterChange: (filter: typeof WorkspaceQualityFilter.Type) => void;
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
	const selection = () => {
		const target = props.localization.target(),
			culture = props.localization.culture();
		return target ? { target, ...(culture ? { culture } : undefined) } : undefined;
	};
	const load = (offset?: number) => {
		const selected = selection(),
			operation = props.client.localizationQualitySearch;
		if (!selected || !operation) return;
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
								: "Writing checks are unavailable. Rescan to try again."
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
		const selected = selection(),
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
		const selected = selection(),
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
	const editorSummary = () =>
		props.summary
			? { ...props.summary, rules: page()?.rules ?? props.summary.rules }
			: undefined;
	return (
		<div {...stylex.attrs(styles.workspace)}>
			<Show when={!props.document}>{props.setup}</Show>
			<div {...stylex.attrs(styles.bar)}>
				<For
					each={WorkspaceQualityFilter.literals.filter(
						(filter) =>
							filter === "all" ||
							filter === props.filter ||
							(page()?.counts[filter] ?? 0) > 0
					)}
				>
					{(filter) => (
						<Chip
							label={workspaceQualityLabels[filter]}
							selected={props.filter === filter}
							count={loading() ? undefined : page()?.counts[filter]}
							onClick={() => props.onFilterChange(filter)}
						/>
					)}
				</For>
				<div
					title="Exports and presets include source writing checks."
					{...stylex.attrs(styles.exports)}
				>
					{props.exports}
				</div>
				<Show when={(page()?.suggestedFixCount ?? 0) > 0}>
					<Button size="compact" tone="quiet" disabled={loading()} onClick={resolveAll}>
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
						Load rules
					</Button>
				</Show>
			</div>
			<Show
				when={
					!loading() &&
					((page()?.limits.length ?? 0) > 0 || (page()?.unsupportedRuleCultures ?? 0) > 0)
				}
			>
				<p {...stylex.attrs(styles.muted)}>
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
									<span {...stylex.attrs(styles.rowText)}>{finding.source}</span>
									<span {...stylex.attrs(styles.context, styles.warning)}>
										{finding.problem}
									</span>
									<span {...stylex.attrs(styles.context, styles.mono)}>
										{finding.context}
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
							<p {...stylex.attrs(styles.empty)}>No findings match this filter.</p>
						</Show>
						<Show when={page()?.nextOffset !== undefined}>
							<Button disabled={loading()} onClick={() => load(page()?.nextOffset)}>
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
														Loading writing checks…
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
																<td>{rule.ruleId}</td>
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
												Select a finding to see its source, translation and
												how to fix it.
											</span>
										</Show>
									}
								>
									<Show when={localizedFocus()}>
										{(finding) => (
											<>
												<span {...stylex.attrs(styles.muted)}>
													{workspaceQualityLabels[finding().check]} ·{" "}
													{finding().culture}
												</span>
												<span {...stylex.attrs(styles.muted)}>Source</span>
												<h2 {...stylex.attrs(styles.title)}>
													<FindingText
														text={finding().source}
														ranges={finding().sourceRanges}
													/>
												</h2>
												<span {...stylex.attrs(styles.muted)}>
													{finding().translationOrigin === "po"
														? "Translation in PO, not synced"
														: finding().translationOrigin === "archive"
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
												<span {...stylex.attrs(styles.warning)}>
													{finding().problem}
												</span>
												<h3 {...stylex.attrs(styles.section)}>
													How to fix
												</h3>
												<p {...stylex.attrs(styles.notes)}>
													{finding().recovery}
												</p>
												<Show when={finding().suggestedChange}>
													{(change) => (
														<section
															aria-label="Suggested fix"
															{...stylex.attrs(styles.detailSection)}
														>
															<h3 {...stylex.attrs(styles.section)}>
																Suggested fix
															</h3>
															<span {...stylex.attrs(styles.muted)}>
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
															<span {...stylex.attrs(styles.muted)}>
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
																				changes: [change()]
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
															<span {...stylex.attrs(styles.muted)}>
																Writing translations arrives with
																translation editing.
															</span>
														</section>
													)}
												</Show>
												<Show when={finding().textUnitId}>
													{(id) => (
														<div {...stylex.attrs(styles.inlineAction)}>
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
												<span {...stylex.attrs(styles.warning)}>
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
															props.onShowText(finding().textUnitId)
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
														objectPath={occurrence.location.objectPath}
													/>
												</div>
											</article>
										)}
									</For>
									<Show
										when={localizedFocus()?.nextOccurrenceOffset !== undefined}
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
	);
}

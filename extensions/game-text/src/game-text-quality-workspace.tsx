import * as stylex from "@stylexjs/stylex";
import type {
	TextQualityFilter,
	TextQualityFindingId,
	TextQualityFindingSummary,
	TextQualityFocus,
	TextQualityQuerySummary,
	GameTextRuleDocument,
	TextQualitySearchPage,
	TextUnitId
} from "@ue-shed/game-text/browser";
import { textCountLabel, textLocationLabel } from "@ue-shed/game-text/browser";
import { Button, Chip, createEffectAction } from "@ue-shed/ui";
import { For, Show, createEffect, createSignal, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { GameTextClientApi } from "./game-text-client.js";
import { CopyButton } from "./game-text-copy-button.js";
import { ShowInUnrealButton } from "./game-text-locate-button.js";
import { GameTextRuleEditor } from "./game-text-rule-editor.js";
import type { GameTextRuleState } from "./game-text-rule-state.js";
import { styles } from "./game-text-styles.js";
import { locationDetail, textContext } from "./game-text-view.js";

const filters = [
	{ label: "All findings", value: "all" },
	{ label: "Character limits", value: "character_budget" },
	{ label: "Terminology", value: "terminology" }
] as const;

export function qualityFindingFacts(focus: TextQualityFocus): string {
	if (focus.kind === "character_budget") {
		const limit = textCountLabel(focus.expectation.maximumCharacters, "character");
		const actual = textCountLabel(focus.actual.characterCount, "character");
		return `Maximum ${limit} · ${actual}`;
	}
	return focus.expectation.kind === "forbidden_term"
		? `Remove “${focus.actual.term}”`
		: `Prefer “${focus.expectation.preferredTerm}” · “${focus.actual.term}” at ${focus.actual.start}–${focus.actual.end}`;
}

function problem(finding: TextQualityFindingSummary): string {
	return finding.expectation.startsWith("Remove")
		? finding.expectation
		: finding.expectation + " · " + finding.actual;
}

export function GameTextQualityWorkspace(props: {
	readonly client: GameTextClientApi;
	readonly disabled?: boolean;
	readonly filter?: TextQualityFilter;
	readonly onFilterChange?: (filter: TextQualityFilter) => void;
	readonly selectedId?: TextQualityFindingId | undefined;
	readonly onSelectionChange?: (id: TextQualityFindingId | undefined) => void;
	readonly onShowText?: (id: TextUnitId) => void;
	readonly exports?: JSX.Element;
	readonly document: GameTextRuleDocument;
	readonly editor: GameTextRuleState;
	readonly onReplaceRules: () => void;
	readonly onLoadRules?: () => void;
	readonly summary: TextQualityQuerySummary;
}) {
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const [filter, setFilter] = createSignal<TextQualityFilter>(
		untrack(() => props.filter ?? "all")
	);
	const [page, setPage] = createSignal<TextQualitySearchPage>();
	const [selectedId, setSelectedId] = createSignal(untrack(() => props.selectedId));
	const [focus, setFocus] = createSignal<TextQualityFocus>();
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<{
		readonly cause: string;
		readonly retry: () => void;
	}>();
	const [editing, setEditing] = createSignal(false);
	let searchGeneration = 0;
	let focusGeneration = 0;

	const requestFocus = (
		id: TextQualityFindingId,
		cursor?: TextQualityFocus["nextOccurrenceCursor"]
	) => {
		const generation = ++focusGeneration;
		focusAction.run(
			props.client.qualityFocus({
				id,
				pageSize: 50,
				...(cursor ? { occurrenceCursor: cursor } : undefined)
			}),
			{
				onFailure: (cause) => {
					if (generation === focusGeneration)
						setFailure({
							cause: "Couldn’t load finding details. " + String(cause),
							retry: () => requestFocus(id)
						});
				},
				onSuccess: (result) => {
					if (generation !== focusGeneration) return;
					setFailure(undefined);
					if (result.status === "found")
						setFocus((previous) =>
							cursor && previous?.id === id
								? {
										...result.focus,
										affectedOccurrences: [
											...previous.affectedOccurrences,
											...result.focus.affectedOccurrences
										]
									}
								: result.focus
						);
					else {
						setFocus(undefined);
						if (result.status === "not_found") {
							setSelectedId(undefined);
							props.onSelectionChange?.(undefined);
						}
					}
				}
			}
		);
	};
	const requestPage = (nextFilter = filter(), cursor?: TextQualitySearchPage["nextCursor"]) => {
		const generation = ++searchGeneration;
		setLoading(true);
		searchAction.run(
			props.client.qualitySearch({
				filter: nextFilter,
				pageSize: 50,
				...(cursor ? { cursor } : undefined)
			}),
			{
				onFailure: (cause) => {
					if (generation === searchGeneration) {
						setLoading(false);
						setPage(undefined);
						setFailure({
							cause: "Couldn’t load findings. " + String(cause),
							retry: () => requestPage()
						});
					}
				},
				onSuccess: (result) => {
					if (generation !== searchGeneration) return;
					if (result.status !== "ready") {
						setLoading(false);
						setPage(undefined);
						setFailure({
							cause: "Writing checks are unavailable. Reload the rules after scanning.",
							retry: props.onReplaceRules
						});
						return;
					}
					setFailure(undefined);
					setLoading(false);
					setPage((previous) =>
						cursor && previous
							? {
									...result.page,
									findings: [...previous.findings, ...result.page.findings]
								}
							: result.page
					);
				}
			}
		);
	};
	createEffect(
		() => ({ summary: props.summary, nextFilter: props.filter ?? filter() }),
		({ nextFilter }) => {
			setFilter(nextFilter);
			requestPage(nextFilter);
		}
	);
	createEffect(
		() => props.selectedId,
		(id) => {
			setSelectedId(id);
		}
	);
	createEffect(
		() => ({ summary: props.summary, id: selectedId() }),
		({ id }) => {
			if (id) requestFocus(id);
			else {
				focusGeneration++;
				focusAction.cancel();
				setFocus(undefined);
			}
		}
	);
	const count = (value: TextQualityFilter) =>
		value === "all"
			? props.summary.findingCount
			: value === "character_budget"
				? props.summary.characterBudgetCount
				: props.summary.terminologyCount;
	const highlighted = () => {
		const current = focus();
		if (current?.kind !== "terminology") return undefined;
		return {
			before: current.sourceExcerpt.slice(0, current.actual.start - current.sourceOffset),
			term: current.sourceExcerpt.slice(
				current.actual.start - current.sourceOffset,
				current.actual.end - current.sourceOffset
			),
			after: current.sourceExcerpt.slice(current.actual.end - current.sourceOffset)
		};
	};

	return (
		<div {...stylex.attrs(styles.workspace)}>
			<div {...stylex.attrs(styles.bar)}>
				<For each={filters}>
					{(item) => (
						<Chip
							label={item.label}
							count={count(item.value)}
							selected={filter() === item.value}
							onClick={() => {
								setFilter(item.value);
								if (props.onFilterChange) props.onFilterChange(item.value);
							}}
						/>
					)}
				</For>
				{props.exports}
				<Button
					size="compact"
					tone="quiet"
					disabled={props.disabled}
					onClick={props.onReplaceRules}
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
				<Show when={editing() && props.onLoadRules}>
					<Button
						size="compact"
						tone="quiet"
						disabled={props.disabled}
						onClick={() => props.onLoadRules?.()}
					>
						Load rules
					</Button>
				</Show>
			</div>
			<Show when={failure()}>
				{(issue) => (
					<div role="alert" {...stylex.attrs(styles.card)}>
						{issue().cause}
						<Button onClick={issue().retry}>Retry</Button>
					</div>
				)}
			</Show>
			<Show
				when={!editing()}
				fallback={
					<Show when={props.editor.state()}>
						{(state) => (
							<GameTextRuleEditor
								disabled={props.disabled}
								editor={props.editor}
								state={state()}
								summary={props.summary}
							/>
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
									aria-current={selectedId() === finding.id ? "true" : undefined}
									onClick={() => {
										setSelectedId(finding.id);
										props.onSelectionChange?.(finding.id);
									}}
									{...stylex.attrs(
										styles.row,
										selectedId() === finding.id && styles.selected
									)}
								>
									<span {...stylex.attrs(styles.rowText)}>
										{finding.sourceExcerpt}
									</span>
									<span {...stylex.attrs(styles.warning)}>
										{problem(finding)}
									</span>
									<span
										title={finding.location?.objectPath}
										{...stylex.attrs(styles.context, styles.mono)}
									>
										{finding.location
											? textContext(finding.location).title + " · "
											: ""}
										{finding.role} · {finding.ruleId} ·{" "}
										{textCountLabel(finding.occurrenceCount, "location")}
									</span>
								</button>
							)}
						</For>
						<Show when={!loading() && page()?.findings.length === 0}>
							<p {...stylex.attrs(styles.empty)}>No findings match this filter.</p>
						</Show>
						<Show when={loading()}>
							<p role="status" {...stylex.attrs(styles.empty)}>
								Loading findings…
							</p>
						</Show>
						<Show when={page()?.nextCursor}>
							{(cursor) => (
								<Button
									disabled={loading()}
									onClick={() => requestPage(filter(), cursor())}
								>
									Show{" "}
									{Math.min(
										50,
										(page()?.total ?? 0) - (page()?.findings.length ?? 0)
									)}{" "}
									more
								</Button>
							)}
						</Show>
					</section>
					<aside aria-label="Finding detail" {...stylex.attrs(styles.pane)}>
						<Show
							when={focus()}
							fallback={
								<div {...stylex.attrs(styles.detail)}>
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
											<For each={props.summary.rules}>
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
											<For each={props.summary.roles}>
												{(role) => (
													<tr>
														<td>{role.role}</td>
														<td>
															<Show
																when={role.matchedTextUnits > 0}
																fallback={
																	<span
																		{...stylex.attrs(
																			styles.warning
																		)}
																	>
																		None: check this role's
																		matchers
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
								</div>
							}
						>
							{(finding) => (
								<div {...stylex.attrs(styles.detail)}>
									<span {...stylex.attrs(styles.muted)}>
										{finding().kind === "character_budget"
											? "Character limit"
											: "Terminology"}
									</span>
									<h2 {...stylex.attrs(styles.title)}>
										<Show
											when={highlighted()}
											fallback={finding().sourceExcerpt}
										>
											{(parts) => (
												<>
													{parts().before}
													<mark {...stylex.attrs(styles.mark)}>
														{parts().term}
													</mark>
													{parts().after}
												</>
											)}
										</Show>
									</h2>
									<Show when={finding().sourceTruncated}>
										<span {...stylex.attrs(styles.muted)}>
											Source preview shortened.
										</span>
									</Show>
									<span {...stylex.attrs(styles.warning)}>
										{qualityFindingFacts(finding())}
									</span>
									<h3 {...stylex.attrs(styles.section)}>How to fix</h3>
									<p {...stylex.attrs(styles.notes)}>{finding().recovery}</p>
									<div {...stylex.attrs(styles.inlineAction)}>
										<Button
											size="compact"
											onClick={() => props.onShowText?.(finding().textUnitId)}
										>
											Show key and translator notes
										</Button>
									</div>
									<h3 {...stylex.attrs(styles.section)}>Where it appears</h3>
									<For each={finding().affectedOccurrences}>
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
									<Show when={finding().nextOccurrenceCursor}>
										{(cursor) => (
											<Button
												onClick={() => requestFocus(finding().id, cursor())}
											>
												Show{" "}
												{textCountLabel(
													Math.min(
														50,
														finding().totalOccurrences -
															finding().affectedOccurrences.length
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
			</Show>
		</div>
	);
}

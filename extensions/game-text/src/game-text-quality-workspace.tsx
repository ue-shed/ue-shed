import * as stylex from "@stylexjs/stylex";
import type {
	TextQualityFilter,
	TextQualityFindingSummary,
	TextQualityFocus,
	TextQualityQuerySummary,
	TextQualityRuleDocument,
	TextQualitySearchPage
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createSignal } from "solid-js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextRuleEditor } from "./game-text-rule-editor.js";
import type { GameTextRuleState } from "./game-text-rule-state.js";
import { textContext } from "./game-text-view.js";

const filters: readonly { readonly label: string; readonly value: TextQualityFilter }[] = [
	{ label: "All findings", value: "all" },
	{ label: "Character budgets", value: "character_budget" },
	{ label: "Terminology", value: "terminology" }
];

type QualityWorkspaceFailure =
	| { readonly operation: "search"; readonly cause: string }
	| {
			readonly operation: "focus";
			readonly cause: string;
			readonly findingId: TextQualityFindingSummary["id"];
	  };

function expectation(focus: TextQualityFocus): string {
	if (focus.kind === "character_budget") {
		return `Maximum ${focus.expectation.maximumCharacters} characters`;
	}
	return focus.expectation.kind === "forbidden_term"
		? `The term “${focus.expectation.term}” is forbidden`
		: `Use “${focus.expectation.preferredTerm}” instead of “${focus.expectation.discouragedTerm}”`;
}

function actual(focus: TextQualityFocus): string {
	return focus.kind === "character_budget"
		? `${focus.actual.characterCount} characters observed`
		: `Matched “${focus.actual.term}” at characters ${focus.actual.start}–${focus.actual.end}`;
}

export function GameTextQualityWorkspace(props: {
	readonly client: GameTextClientApi;
	readonly filter?: TextQualityFilter;
	readonly onFilterChange?: (filter: TextQualityFilter) => void;
	readonly document: TextQualityRuleDocument;
	readonly editor: GameTextRuleState;
	readonly onReplaceRules: () => void;
	readonly summary: TextQualityQuerySummary;
}) {
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const [filter, setFilter] = createSignal<TextQualityFilter>(props.filter ?? "all");
	const [page, setPage] = createSignal<TextQualitySearchPage>({ findings: [], total: 0 });
	const [selectedId, setSelectedId] = createSignal<TextQualityFindingSummary["id"]>();
	const [focus, setFocus] = createSignal<TextQualityFocus>();
	const [failure, setFailure] = createSignal<QualityWorkspaceFailure>();
	const [surface, setSurface] = createSignal<"findings" | "rules">("findings");
	let searchGeneration = 0;
	let focusGeneration = 0;

	const requestFocus = (id: TextQualityFindingSummary["id"]) => {
		const generation = ++focusGeneration;
		focusAction.run(props.client.qualityFocus({ id, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === focusGeneration) {
					setFailure({ operation: "focus", cause: String(cause), findingId: id });
				}
			},
			onSuccess: (result) => {
				if (generation !== focusGeneration) return;
				setFailure((current) =>
					current?.operation === "focus" && current.findingId === id ? undefined : current
				);
				setFocus(result.status === "found" ? result.focus : undefined);
			}
		});
	};

	const requestPage = (nextFilter: TextQualityFilter = filter()) => {
		const generation = ++searchGeneration;
		searchAction.run(props.client.qualitySearch({ filter: nextFilter, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === searchGeneration) {
					setFailure({ operation: "search", cause: String(cause) });
				}
			},
			onSuccess: (result) => {
				if (generation !== searchGeneration || result.status !== "ready") return;
				setFailure((current) => (current?.operation === "search" ? undefined : current));
				setPage(result.page);
				const next =
					result.page.findings.find((finding) => finding.id === selectedId()) ??
					result.page.findings[0];
				setSelectedId(next?.id);
				if (next) requestFocus(next.id);
				else setFocus(undefined);
			}
		});
	};

	createEffect(
		() => ({ summary: props.summary, nextFilter: props.filter }),
		({ nextFilter }) => {
			if (nextFilter !== undefined) setFilter(nextFilter);
			requestPage(nextFilter);
		}
	);

	const coverage = () => props.summary.coverage;
	return (
		<div {...stylex.attrs(styles.workspace)}>
			<section aria-label="Quality summary" {...stylex.attrs(styles.summaryStrip)}>
				<div {...stylex.attrs(styles.summaryLead)}>
					<strong {...stylex.attrs(styles.summaryValue)}>
						{props.summary.findingCount.toLocaleString()}{" "}
						{props.summary.findingCount === 1 ? "finding" : "findings"}
					</strong>
					<span>Rule file v{props.summary.ruleDocumentVersion}</span>
					<button
						type="button"
						onClick={props.onReplaceRules}
						{...stylex.attrs(styles.replaceRules)}
					>
						Load rules
					</button>
				</div>
				<div {...stylex.attrs(styles.metric)}>
					<small>Character budgets</small>
					<strong {...stylex.attrs(styles.metricValue)}>
						{props.summary.characterBudgetCount}
					</strong>
					<span>{props.summary.rules.length} rules total</span>
				</div>
				<div {...stylex.attrs(styles.metric)}>
					<small>Terminology</small>
					<strong {...stylex.attrs(styles.metricValue)}>
						{props.summary.terminologyCount}
					</strong>
					<span>forbidden and preferred terms</span>
				</div>
				<div {...stylex.attrs(styles.metric)}>
					<small>Roles</small>
					<strong {...stylex.attrs(styles.metricValue)}>
						{props.summary.roles.length}
					</strong>
					<span>scoped to this project</span>
				</div>
				<div {...stylex.attrs(styles.metric)}>
					<small>Saved text</small>
					<strong
						{...stylex.attrs(
							styles.metricValue,
							props.summary.status === "complete" && styles.complete
						)}
					>
						{props.summary.status === "complete" ? "Complete" : "Partial"}
					</strong>
					<span>{coverage().inspectedPackages} packages read</span>
				</div>
			</section>
			<div
				role="tablist"
				aria-label="Quality review workspace"
				{...stylex.attrs(styles.tabs)}
			>
				<button
					type="button"
					role="tab"
					aria-selected={surface() === "findings" ? "true" : "false"}
					onClick={() => setSurface("findings")}
					{...stylex.attrs(styles.tab, surface() === "findings" && styles.tabActive)}
				>
					Findings <b {...stylex.attrs(styles.tabCount)}>{props.summary.findingCount}</b>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={surface() === "rules" ? "true" : "false"}
					onClick={() => setSurface("rules")}
					{...stylex.attrs(styles.tab, surface() === "rules" && styles.tabActive)}
				>
					Rules <b {...stylex.attrs(styles.tabCount)}>{props.document.rules.length}</b>
				</button>
			</div>
			<Show when={failure()}>
				{(issue) => (
					<section role="alert" {...stylex.attrs(styles.errorCard)}>
						<strong {...stylex.attrs(styles.errorTitle)}>
							{issue().operation === "search"
								? "Couldn’t load findings."
								: "Couldn’t load finding details."}
						</strong>
						<p {...stylex.attrs(styles.errorCopy)}>
							Try again. If it keeps failing, restart Workbench.
						</p>
						<button
							type="button"
							onClick={() => {
								const current = issue();
								if (current.operation === "search") requestPage();
								else requestFocus(current.findingId);
							}}
							{...stylex.attrs(styles.retryButton)}
						>
							Retry
						</button>
						<details {...stylex.attrs(styles.errorDetails)}>
							<summary {...stylex.attrs(styles.techSummary)}>
								Technical details
							</summary>
							<pre {...stylex.attrs(styles.techPre)}>{issue().cause}</pre>
						</details>
					</section>
				)}
			</Show>
			<Show
				when={surface() === "findings"}
				fallback={
					<Show when={props.editor.state()}>
						{(state) => (
							<GameTextRuleEditor
								editor={props.editor}
								state={state()}
								summary={props.summary}
							/>
						)}
					</Show>
				}
			>
				<div {...stylex.attrs(styles.grid)}>
					<aside aria-label="Quality filters" {...stylex.attrs(styles.rail)}>
						<header {...stylex.attrs(styles.railHeader)}>
							<span>Filters</span>
							<b>{props.summary.findingCount}</b>
						</header>
						<div role="group" aria-label="Finding type">
							<For each={filters}>
								{(item) => (
									<button
										type="button"
										aria-pressed={filter() === item.value ? "true" : "false"}
										onClick={() => {
											setFilter(item.value);
											props.onFilterChange?.(item.value);
											requestPage(item.value);
										}}
										{...stylex.attrs(
											styles.filter,
											filter() === item.value && styles.filterActive
										)}
									>
										<span>{item.label}</span>
										<b {...stylex.attrs(styles.filterCount)}>
											{item.value === "all"
												? props.summary.findingCount
												: item.value === "character_budget"
													? props.summary.characterBudgetCount
													: props.summary.terminologyCount}
										</b>
									</button>
								)}
							</For>
						</div>
						<section {...stylex.attrs(styles.railSection)}>
							<header {...stylex.attrs(styles.railSectionTitle)}>Role matches</header>
							<For each={props.summary.roles}>
								{(role) => (
									<span {...stylex.attrs(styles.roleRow)}>
										<code {...stylex.attrs(styles.roleRowCode)}>
											{role.role}
										</code>
										<b {...stylex.attrs(styles.filterCount)}>
											{role.matchedTextUnits}
										</b>
									</span>
								)}
							</For>
						</section>
						<section {...stylex.attrs(styles.coverage)}>
							<strong {...stylex.attrs(styles.coverageTitle)}>
								{props.summary.status === "complete"
									? "All saved text checked."
									: "Only part of the saved text was checked."}
							</strong>
							<span>{coverage().textOccurrences} known occurrences</span>
							<Show
								when={
									coverage().unsupportedTextProperties > 0 ||
									coverage().failedPackages > 0 ||
									coverage().partialPackages > 0
								}
							>
								<p {...stylex.attrs(styles.coverageDetail)}>
									{coverage().unsupportedTextProperties} unsupported properties ·{" "}
									{coverage().partialPackages} partial ·{" "}
									{coverage().failedPackages} failed
								</p>
							</Show>
						</section>
					</aside>
					<section aria-label="Findings" {...stylex.attrs(styles.findings)}>
						<header {...stylex.attrs(styles.listHeader)}>
							<span>Findings</span>
							<b {...stylex.attrs(styles.count)}>{page().total}</b>
						</header>
						<Show
							when={page().findings.length > 0}
							fallback={
								<p {...stylex.attrs(styles.empty)}>
									No findings here. Widen the filter or fix the flagged text.
								</p>
							}
						>
							<For each={page().findings}>
								{(finding) => (
									<button
										type="button"
										onClick={() => {
											setSelectedId(finding.id);
											requestFocus(finding.id);
										}}
										aria-current={
											selectedId() === finding.id ? "true" : undefined
										}
										{...stylex.attrs(
											styles.finding,
											selectedId() === finding.id && styles.findingActive
										)}
									>
										<span {...stylex.attrs(styles.findingMeta)}>
											<b {...stylex.attrs(styles.kind)}>
												{finding.kind === "character_budget"
													? "Budget"
													: "Term"}
											</b>
											<code>{finding.role}</code>
											<span>{finding.ruleId}</span>
										</span>
										<strong {...stylex.attrs(styles.source)}>
											{finding.sourceExcerpt}
										</strong>
										<span {...stylex.attrs(styles.actual)}>
											{finding.actual}
										</span>
										<span {...stylex.attrs(styles.expected)}>
											{finding.expectation}
										</span>
									</button>
								)}
							</For>
						</Show>
					</section>
					<aside aria-label="Finding detail" {...stylex.attrs(styles.detail)}>
						<Show
							when={focus()}
							fallback={
								<p {...stylex.attrs(styles.empty)}>
									Select a finding to see what was flagged and where it appears.
								</p>
							}
						>
							{(finding) => (
								<>
									<header {...stylex.attrs(styles.detailHeader)}>
										<span {...stylex.attrs(styles.detailKind)}>
											{finding().kind === "character_budget"
												? "Character budget"
												: "Terminology"}
										</span>
										<blockquote {...stylex.attrs(styles.detailQuote)}>
											“{finding().sourceExcerpt}”
										</blockquote>
										<code {...stylex.attrs(styles.detailId)}>
											{finding().textUnitId}
										</code>
									</header>
									<section {...stylex.attrs(styles.explanation)}>
										<div {...stylex.attrs(styles.explanationCell)}>
											<small {...stylex.attrs(styles.explanationLabel)}>
												Observed
											</small>
											<strong {...stylex.attrs(styles.explanationValue)}>
												{actual(finding())}
											</strong>
										</div>
										<div {...stylex.attrs(styles.explanationCell)}>
											<small {...stylex.attrs(styles.explanationLabel)}>
												Expected
											</small>
											<strong {...stylex.attrs(styles.explanationValue)}>
												{expectation(finding())}
											</strong>
										</div>
										<div {...stylex.attrs(styles.explanationCell)}>
											<small {...stylex.attrs(styles.explanationLabel)}>
												How to fix
											</small>
											<strong {...stylex.attrs(styles.explanationValue)}>
												{finding().recovery}
											</strong>
										</div>
									</section>
									<section {...stylex.attrs(styles.evidence)}>
										<header {...stylex.attrs(styles.evidenceHeader)}>
											<span>Occurrences</span>
											<b {...stylex.attrs(styles.count)}>
												{finding().totalOccurrences}
											</b>
										</header>
										<For each={finding().affectedOccurrences}>
											{(occurrence) => {
												const context = textContext(occurrence.location);
												return (
													<article {...stylex.attrs(styles.evidenceRow)}>
														<strong
															{...stylex.attrs(styles.evidenceTitle)}
														>
															{context.title}
														</strong>
														<span
															{...stylex.attrs(styles.evidenceDetail)}
														>
															{context.detail}
														</span>
														<code
															{...stylex.attrs(styles.evidencePath)}
														>
															{occurrence.location.objectPath}
														</code>
														<small
															{...stylex.attrs(
																styles.evidencePackage
															)}
														>
															{occurrence.packageFile}
														</small>
													</article>
												);
											}}
										</For>
									</section>
								</>
							)}
						</Show>
					</aside>
				</div>
			</Show>
		</div>
	);
}

const styles = stylex.create({
	workspace: { display: "flex", flexDirection: "column", gap: tokens.space3 },
	summaryStrip: {
		display: "grid",
		gridTemplateColumns: "1.35fr repeat(4, minmax(120px, .75fr))",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	summaryLead: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	replaceRules: {
		alignSelf: "flex-start",
		marginTop: tokens.space1,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: `${tokens.space1} ${tokens.space2}`,
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontSize: 11,
		whiteSpace: "nowrap"
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	summaryValue: { color: tokens.colorTextStrong, fontSize: 15, lineHeight: 1.2 },
	metricValue: { color: tokens.colorTextStrong, fontSize: 13, lineHeight: 1.2 },
	complete: { color: tokens.colorSuccess },
	tabs: {
		display: "flex",
		gap: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	tab: {
		display: "flex",
		alignItems: "center",
		gap: tokens.space2,
		padding: `${tokens.space2} 0`,
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: "transparent",
		borderBottomStyle: "solid",
		borderBottomWidth: 2,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		fontSize: 13,
		fontWeight: 500,
		cursor: "pointer"
	},
	tabActive: {
		borderBottomColor: tokens.colorAccent,
		color: tokens.colorTextStrong
	},
	tabCount: {
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	count: {
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontWeight: 500,
		fontVariantNumeric: "tabular-nums"
	},
	errorCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		padding: tokens.space4,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	errorTitle: { color: tokens.colorTextStrong, fontSize: 14 },
	errorCopy: { margin: 0, color: tokens.colorTextMuted, fontSize: 13 },
	errorDetails: {
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	techSummary: { cursor: "pointer", color: tokens.colorTextSubtle },
	techPre: {
		margin: `${tokens.space2} 0 0`,
		maxWidth: 640,
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
	retryButton: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		backgroundColor: { default: tokens.colorSurface, ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: `${tokens.space1} ${tokens.space3}`,
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		fontWeight: 500
	},
	grid: {
		display: "grid",
		gridTemplateColumns: "206px minmax(360px, 440px) minmax(400px, 1fr)",
		gap: tokens.space3,
		alignItems: "start"
	},
	rail: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 260px)",
		minHeight: 420,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	railHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: `${tokens.space3} ${tokens.space3}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextStrong,
		fontWeight: 590,
		fontSize: 12
	},
	filter: {
		display: "flex",
		justifyContent: "space-between",
		width: "100%",
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceInset },
		color: tokens.colorTextMuted,
		padding: `${tokens.space2} ${tokens.space3}`,
		fontSize: 12,
		textAlign: "left",
		cursor: "pointer"
	},
	filterCount: {
		fontFamily: tokens.fontMono,
		fontVariantNumeric: "tabular-nums",
		color: tokens.colorTextFaint
	},
	filterActive: {
		color: tokens.colorTextStrong,
		backgroundColor: tokens.colorSurfaceHover,
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	railSection: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		padding: tokens.space3,
		fontSize: 11
	},
	railSectionTitle: { color: tokens.colorTextSubtle, fontSize: 11, fontWeight: 500 },
	roleRowCode: { fontFamily: tokens.fontMono, fontSize: 11 },
	roleRow: {
		display: "flex",
		justifyContent: "space-between",
		color: tokens.colorTextMuted
	},
	coverage: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		marginTop: "auto",
		padding: tokens.space3,
		borderTopColor: tokens.colorBorder,
		borderTopStyle: "solid",
		borderTopWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		lineHeight: 1.45
	},
	coverageTitle: { color: tokens.colorText, fontWeight: 500 },
	coverageDetail: { margin: 0, color: tokens.colorWarning },
	findings: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 260px)",
		minHeight: 420,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	listHeader: {
		position: "sticky",
		top: 0,
		zIndex: 1,
		display: "flex",
		justifyContent: "space-between",
		padding: `${tokens.space3} ${tokens.space4}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		fontWeight: 590,
		fontSize: 12
	},
	finding: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		width: "100%",
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceInset },
		color: tokens.colorText,
		padding: `${tokens.space3} ${tokens.space4}`,
		textAlign: "left",
		cursor: "pointer"
	},
	findingActive: {
		backgroundColor: tokens.colorSurfaceHover,
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	findingMeta: {
		display: "flex",
		alignItems: "center",
		gap: tokens.space2,
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	kind: {
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		color: tokens.colorTextMuted,
		backgroundColor: "rgba(255, 255, 255, 0.05)"
	},
	source: {
		overflow: "hidden",
		color: tokens.colorTextStrong,
		fontSize: 13,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	actual: { color: tokens.colorWarning, fontSize: 11 },
	expected: { color: tokens.colorTextMuted, fontSize: 11 },
	detail: {
		height: "calc(100vh - 260px)",
		minHeight: 420,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "auto"
	},
	detailHeader: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		padding: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	detailKind: { color: tokens.colorTextSubtle, fontSize: 11 },
	detailQuote: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 17,
		fontWeight: 590,
		lineHeight: 1.3,
		letterSpacing: "-0.01em"
	},
	detailId: {
		overflow: "hidden",
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	explanation: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	explanationCell: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		minWidth: 0,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1
	},
	explanationLabel: { color: tokens.colorTextFaint, fontSize: 11 },
	explanationValue: {
		color: tokens.colorText,
		fontSize: 11,
		fontWeight: 500,
		lineHeight: 1.4
	},
	evidence: {
		margin: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		overflow: "hidden"
	},
	evidenceHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: `${tokens.space2} ${tokens.space3}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	evidenceRow: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
	},
	evidenceTitle: { color: tokens.colorTextStrong, fontSize: 11 },
	evidenceDetail: { color: tokens.colorTextMuted, fontSize: 11 },
	evidencePath: {
		overflow: "hidden",
		color: tokens.colorText,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	evidencePackage: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	empty: { padding: tokens.space4, color: tokens.colorTextMuted, fontSize: 12 }
});

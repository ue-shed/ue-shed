import * as stylex from "@stylexjs/stylex";
import type {
	TextQualityFilter,
	TextQualityFindingSummary,
	TextQualityFocus,
	TextQualityQuerySummary,
	TextQualitySearchPage
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { GameTextClientShape } from "./game-text-client.js";
import { textContext } from "./game-text-view.js";

const filters: readonly { readonly label: string; readonly value: TextQualityFilter }[] = [
	{ label: "All findings", value: "all" },
	{ label: "Character budgets", value: "character_budget" },
	{ label: "Terminology", value: "terminology" }
];

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
	readonly client: GameTextClientShape;
	readonly summary: TextQualityQuerySummary;
}) {
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const [filter, setFilter] = createSignal<TextQualityFilter>("all");
	const [page, setPage] = createSignal<TextQualitySearchPage>({ findings: [], total: 0 });
	const [selectedId, setSelectedId] = createSignal<TextQualityFindingSummary["id"]>();
	const [focus, setFocus] = createSignal<TextQualityFocus>();
	const [failure, setFailure] = createSignal<string>();
	let searchGeneration = 0;
	let focusGeneration = 0;

	const requestFocus = (id: TextQualityFindingSummary["id"]) => {
		const generation = ++focusGeneration;
		focusAction.run(props.client.qualityFocus({ id, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === focusGeneration) setFailure(String(cause));
			},
			onSuccess: (result) => {
				if (generation !== focusGeneration) return;
				setFocus(result.status === "found" ? result.focus : undefined);
			}
		});
	};

	const requestPage = (nextFilter: TextQualityFilter = filter()) => {
		const generation = ++searchGeneration;
		searchAction.run(props.client.qualitySearch({ filter: nextFilter, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === searchGeneration) setFailure(String(cause));
			},
			onSuccess: (result) => {
				if (generation !== searchGeneration || result.status !== "ready") return;
				setFailure(undefined);
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
		on(
			() => props.summary.findingCount,
			() => requestPage()
		)
	);

	const coverage = () => props.summary.coverage;
	return (
		<div {...stylex.props(styles.workspace)}>
			<section aria-label="Quality summary" {...stylex.props(styles.summaryStrip)}>
				<div {...stylex.props(styles.summaryLead)}>
					<small>PROJECT-AUTHORED REVIEW</small>
					<strong {...stylex.props(styles.summaryValue)}>
						{props.summary.findingCount.toLocaleString()} findings
					</strong>
					<span>Rule document v{props.summary.ruleDocumentVersion}</span>
				</div>
				<div {...stylex.props(styles.metric)}>
					<small>Budgets</small>
					<strong {...stylex.props(styles.metricValue)}>
						{props.summary.characterBudgetCount}
					</strong>
					<span>character limits</span>
				</div>
				<div {...stylex.props(styles.metric)}>
					<small>Terminology</small>
					<strong {...stylex.props(styles.metricValue)}>
						{props.summary.terminologyCount}
					</strong>
					<span>forbidden · preferred</span>
				</div>
				<div {...stylex.props(styles.metric)}>
					<small>Scoped roles</small>
					<strong {...stylex.props(styles.metricValue)}>
						{props.summary.roles.length}
					</strong>
					<span>{props.summary.rules.length} rules</span>
				</div>
				<div {...stylex.props(styles.metric)}>
					<small>Corpus coverage</small>
					<strong {...stylex.props(styles.metricValue)}>
						{props.summary.status === "complete" ? "Complete" : "Partial"}
					</strong>
					<span>{coverage().inspectedPackages} inspected packages</span>
				</div>
			</section>
			<Show when={failure()}>
				{(message) => (
					<p role="alert" {...stylex.props(styles.error)}>
						{message()}
					</p>
				)}
			</Show>
			<div {...stylex.props(styles.grid)}>
				<aside aria-label="Quality filters" {...stylex.props(styles.rail)}>
					<header {...stylex.props(styles.railHeader)}>
						<span>Finding queue</span>
						<b>{props.summary.findingCount}</b>
					</header>
					<div role="group" aria-label="Finding type">
						<For each={filters}>
							{(item) => (
								<button
									type="button"
									aria-pressed={filter() === item.value}
									onClick={() => {
										setFilter(item.value);
										requestPage(item.value);
									}}
									{...stylex.props(
										styles.filter,
										filter() === item.value && styles.filterActive
									)}
								>
									<span>{item.label}</span>
									<b>
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
					<section {...stylex.props(styles.railSection)}>
						<header>Role matches</header>
						<For each={props.summary.roles}>
							{(role) => (
								<span {...stylex.props(styles.roleRow)}>
									<code>{role.role}</code>
									<b>{role.matchedTextUnits}</b>
								</span>
							)}
						</For>
					</section>
					<section {...stylex.props(styles.coverage)}>
						<strong>{props.summary.status.toUpperCase()} CORPUS</strong>
						<span>{coverage().textOccurrences} known occurrences</span>
						<Show
							when={
								coverage().unsupportedTextProperties > 0 ||
								coverage().failedPackages > 0 ||
								coverage().partialPackages > 0
							}
						>
							<p>
								{coverage().unsupportedTextProperties} unsupported properties ·{" "}
								{coverage().partialPackages} partial · {coverage().failedPackages}{" "}
								failed
							</p>
						</Show>
					</section>
				</aside>
				<section aria-label="Quality findings" {...stylex.props(styles.findings)}>
					<header {...stylex.props(styles.listHeader)}>
						<span>Explainable findings</span>
						<b>{page().total}</b>
					</header>
					<Show
						when={page().findings.length > 0}
						fallback={
							<p {...stylex.props(styles.empty)}>No findings for this filter.</p>
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
									aria-current={selectedId() === finding.id ? "true" : undefined}
									{...stylex.props(
										styles.finding,
										selectedId() === finding.id && styles.findingActive
									)}
								>
									<span {...stylex.props(styles.findingMeta)}>
										<b {...stylex.props(styles.kind)}>
											{finding.kind === "character_budget"
												? "BUDGET"
												: "TERM"}
										</b>
										<code>{finding.role}</code>
										<span>{finding.ruleId}</span>
									</span>
									<strong {...stylex.props(styles.source)}>
										{finding.sourceExcerpt}
									</strong>
									<span {...stylex.props(styles.actual)}>{finding.actual}</span>
									<span {...stylex.props(styles.expected)}>
										{finding.expectation}
									</span>
								</button>
							)}
						</For>
					</Show>
				</section>
				<aside aria-label="Quality finding detail" {...stylex.props(styles.detail)}>
					<Show
						when={focus()}
						fallback={
							<p {...stylex.props(styles.empty)}>
								Select a finding to inspect its evidence.
							</p>
						}
					>
						{(finding) => (
							<>
								<header {...stylex.props(styles.detailHeader)}>
									<span {...stylex.props(styles.detailEyebrow)}>
										{finding().kind === "character_budget"
											? "CHARACTER BUDGET"
											: "TERMINOLOGY"}
									</span>
									<blockquote {...stylex.props(styles.detailQuote)}>
										“{finding().sourceExcerpt}”
									</blockquote>
									<code {...stylex.props(styles.detailId)}>
										{finding().textUnitId}
									</code>
								</header>
								<section {...stylex.props(styles.explanation)}>
									<div {...stylex.props(styles.explanationCell)}>
										<small {...stylex.props(styles.explanationLabel)}>
											ACTUAL
										</small>
										<strong {...stylex.props(styles.explanationValue)}>
											{actual(finding())}
										</strong>
									</div>
									<div {...stylex.props(styles.explanationCell)}>
										<small {...stylex.props(styles.explanationLabel)}>
											EXPECTED
										</small>
										<strong {...stylex.props(styles.explanationValue)}>
											{expectation(finding())}
										</strong>
									</div>
									<div {...stylex.props(styles.explanationCell)}>
										<small {...stylex.props(styles.explanationLabel)}>
											RECOVERY
										</small>
										<strong {...stylex.props(styles.explanationValue)}>
											{finding().recovery}
										</strong>
									</div>
								</section>
								<section {...stylex.props(styles.evidence)}>
									<header {...stylex.props(styles.evidenceHeader)}>
										<span>Affected occurrences</span>
										<b>{finding().totalOccurrences}</b>
									</header>
									<For each={finding().affectedOccurrences}>
										{(occurrence) => {
											const context = textContext(occurrence.location);
											return (
												<article {...stylex.props(styles.evidenceRow)}>
													<strong {...stylex.props(styles.evidenceTitle)}>
														{context.title}
													</strong>
													<span {...stylex.props(styles.evidenceDetail)}>
														{context.detail}
													</span>
													<code {...stylex.props(styles.evidencePath)}>
														{occurrence.location.objectPath}
													</code>
													<small
														{...stylex.props(styles.evidencePackage)}
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
		</div>
	);
}

const styles = stylex.create({
	workspace: { display: "flex", flexDirection: "column", gap: 8 },
	summaryStrip: {
		display: "grid",
		gridTemplateColumns: "1.35fr repeat(4, minmax(120px, .75fr))",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311"
	},
	summaryLead: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		padding: "8px 11px",
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	metric: {
		display: "flex",
		flexDirection: "column",
		gap: 2,
		padding: "8px 10px",
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextFaint,
		fontSize: 8
	},
	summaryValue: { color: tokens.colorTextStrong, fontSize: 14, lineHeight: 1.2 },
	metricValue: { color: tokens.colorTextStrong, fontSize: 13, lineHeight: 1.2 },
	grid: {
		display: "grid",
		gridTemplateColumns: "206px minmax(390px, 470px) minmax(440px, 1fr)",
		gap: 8
	},
	rail: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 220px)",
		minHeight: 470,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		overflow: "auto"
	},
	railHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "8px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		fontSize: 10
	},
	filter: {
		display: "flex",
		justifyContent: "space-between",
		width: "100%",
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: tokens.colorTextMuted,
		padding: "8px 9px",
		fontSize: 9,
		textAlign: "left",
		cursor: "pointer"
	},
	filterActive: {
		color: "#f2d2c6",
		backgroundColor: "#2b1d18",
		boxShadow: "inset 3px 0 #e87655"
	},
	railSection: { display: "flex", flexDirection: "column", gap: 6, padding: "9px", fontSize: 9 },
	roleRow: { display: "flex", justifyContent: "space-between", color: tokens.colorTextMuted },
	coverage: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		marginTop: "auto",
		padding: 9,
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	findings: {
		display: "flex",
		flexDirection: "column",
		height: "calc(100vh - 220px)",
		minHeight: 470,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#121110",
		overflow: "auto"
	},
	listHeader: {
		position: "sticky",
		top: 0,
		zIndex: 1,
		display: "flex",
		justifyContent: "space-between",
		padding: "8px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#191715f5",
		fontSize: 9
	},
	finding: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		width: "100%",
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "#201c19" },
		color: tokens.colorText,
		padding: "9px 10px",
		textAlign: "left",
		cursor: "pointer"
	},
	findingActive: { backgroundColor: "#2b1d18", boxShadow: "inset 3px 0 #e87655" },
	findingMeta: {
		display: "flex",
		alignItems: "center",
		gap: 7,
		color: tokens.colorTextFaint,
		fontSize: 8
	},
	kind: { padding: "2px 4px", color: "#efaa91", backgroundColor: "#382019" },
	source: { overflow: "hidden", fontSize: 13, textOverflow: "ellipsis", whiteSpace: "nowrap" },
	actual: { color: "#d7a18d", fontSize: 9 },
	expected: { color: tokens.colorTextMuted, fontSize: 9 },
	detail: {
		height: "calc(100vh - 220px)",
		minHeight: 470,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#151311",
		overflow: "auto"
	},
	detailHeader: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "12px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	detailEyebrow: { color: "#e87655", fontSize: 9, letterSpacing: ".08em" },
	detailQuote: {
		margin: "2px 0",
		color: tokens.colorTextStrong,
		fontSize: 20,
		fontWeight: 600,
		lineHeight: 1.3
	},
	detailId: { color: "#d2cac2", fontSize: 10 },
	explanation: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	explanationCell: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		minWidth: 0,
		padding: "10px 11px",
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	explanationLabel: { color: tokens.colorTextFaint, fontSize: 8, letterSpacing: ".06em" },
	explanationValue: { color: tokens.colorText, fontSize: 11, fontWeight: 600, lineHeight: 1.4 },
	evidence: { margin: 10, border: `1px solid ${tokens.colorBorder}` },
	evidenceHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "7px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	evidenceRow: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		padding: "8px 9px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	evidenceTitle: { color: tokens.colorTextStrong, fontSize: 11 },
	evidenceDetail: { color: tokens.colorTextMuted, fontSize: 9 },
	evidencePath: {
		overflow: "hidden",
		color: "#d8d0c8",
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	evidencePackage: {
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 8,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	empty: { padding: 24, color: tokens.colorTextMuted, fontSize: 10 },
	error: {
		margin: 0,
		padding: 8,
		border: `1px solid ${tokens.colorDanger}`,
		color: "#efaa91",
		fontSize: 9
	}
});

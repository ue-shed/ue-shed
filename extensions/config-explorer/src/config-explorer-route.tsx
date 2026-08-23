import * as stylex from "@stylexjs/stylex";
import type {
	ConfigComparison,
	ConfigContribution,
	ConfigExplanation,
	ConfigValueState
} from "@ue-shed/config-explorer/browser";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show } from "solid-js";
import type { ConfigExplorerSuppliedResult } from "./config-explorer-client.js";

function valueText(value: ConfigValueState): string {
	switch (value.kind) {
		case "missing":
			return "Missing";
		case "empty_array":
			return "[ explicit empty ]";
		case "scalar":
			return value.value;
		case "array":
			return value.values.join("  ·  ");
	}
}

function effectText(contribution: ConfigContribution): string {
	switch (contribution.effect.kind) {
		case "added":
			return `added at index ${contribution.effect.index}`;
		case "replaced":
			return `replaced “${contribution.effect.previousValue}”`;
		case "removed":
			return `removed index ${contribution.effect.index}`;
		case "cleared":
			return `cleared ${contribution.effect.removedValues.length} value(s)`;
		case "initialized_empty":
			return "initialized explicit empty";
		case "duplicate":
			return "duplicate; no change";
		case "no_match":
			return "no match; no change";
	}
}

function operationText(operation: ConfigContribution["operation"]): string {
	return operation.replaceAll("_", " ");
}

function EvidencePanel(props: { readonly result: ConfigExplanation; readonly compact?: boolean }) {
	const exceptionalLayers = () =>
		props.result.layers.filter(({ status }) => status !== "read" && status !== "missing");
	const unresolvedLayers = () => props.result.layers.filter(({ status }) => status !== "read");
	const missingCount = () =>
		props.result.layers.filter(({ status }) => status === "missing").length;
	const readCount = () => props.result.layers.filter(({ status }) => status === "read").length;
	const effectiveCount = () =>
		props.result.contributions.filter(({ remainsEffective }) => remainsEffective).length;

	return (
		<article {...stylex.props(styles.panel)}>
			<header
				{...stylex.props(styles.panelHeader, props.compact && styles.panelHeaderCompact)}
			>
				<div {...stylex.props(styles.platformIdentity)}>
					<h2 {...stylex.props(styles.platform)}>{props.result.platform}</h2>
					<span {...stylex.props(styles.coordinate)}>
						{props.result.family}.ini · [{props.result.section}] · {props.result.key}
					</span>
				</div>
				<span
					{...stylex.props(
						styles.coverage,
						props.result.status === "partial" && styles.coveragePartial
					)}
				>
					{props.result.status} coverage
				</span>
			</header>

			<section
				aria-label={`${props.result.platform} effective saved value`}
				{...stylex.props(styles.valuePlate, props.compact && styles.valuePlateCompact)}
			>
				<span {...stylex.props(styles.valueLabel)}>Final saved value</span>
				<code {...stylex.props(styles.value)}>
					{valueText(props.result.effectiveValue)}
				</code>
			</section>

			<div {...stylex.props(styles.stats)}>
				<span {...stylex.props(styles.stat)}>
					<strong {...stylex.props(styles.statNumber)}>{effectiveCount()}</strong>{" "}
					affecting final
				</span>
				<span {...stylex.props(styles.stat)}>
					<strong {...stylex.props(styles.statNumber)}>
						{props.result.contributions.length}
					</strong>{" "}
					operations traced
				</span>
				<span {...stylex.props(styles.stat)}>
					<strong {...stylex.props(styles.statNumber)}>{readCount()}</strong> layers read
				</span>
				<Show when={exceptionalLayers().length > 0}>
					<span {...stylex.props(styles.stat)}>
						<strong {...stylex.props(styles.statNumber, styles.statNumberIssue)}>
							{exceptionalLayers().length}
						</strong>{" "}
						coverage issues
					</span>
				</Show>
			</div>

			<Show when={exceptionalLayers().length > 0}>
				<section
					aria-label={`${props.result.platform} coverage exceptions`}
					{...stylex.props(styles.exceptions)}
				>
					<header {...stylex.props(styles.exceptionsHeader)}>
						<h3 {...stylex.props(styles.sectionTitle)}>Exceptions</h3>
						<span {...stylex.props(styles.countChip)}>
							{exceptionalLayers().length}
						</span>
					</header>
					<For each={exceptionalLayers()}>
						{(layer) => (
							<div {...stylex.props(styles.exceptionRow)}>
								<span {...stylex.props(styles.exceptionStatus)}>
									{layer.status}
								</span>
								<code {...stylex.props(styles.monoPath)}>{layer.source.path}</code>
							</div>
						)}
					</For>
				</section>
			</Show>

			<section {...stylex.props(styles.trace)}>
				<header {...stylex.props(styles.traceHeader)}>
					<h3 {...stylex.props(styles.sectionTitle)}>Source operations, in load order</h3>
					<span {...stylex.props(styles.traceLegend)}>
						Highlighted rows survive into the final value
					</span>
				</header>
				<ol
					aria-label={`${props.result.platform} ordered contributions`}
					{...stylex.props(styles.timeline)}
				>
					<For each={props.result.contributions}>
						{(contribution, index) => (
							<li {...stylex.props(styles.contribution)}>
								<div aria-hidden="true" {...stylex.props(styles.timelineRail)}>
									<span {...stylex.props(styles.sequence)}>
										{String(contribution.sequence + 1).padStart(2, "0")}
									</span>
									<Show when={index() < props.result.contributions.length - 1}>
										<span {...stylex.props(styles.timelineConnector)} />
									</Show>
								</div>
								<div
									{...stylex.props(
										styles.contributionBody,
										contribution.remainsEffective &&
											styles.contributionBodyEffective
									)}
								>
									<div {...stylex.props(styles.contributionHead)}>
										<code {...stylex.props(styles.sourcePath)}>
											{contribution.source.path}
										</code>
										<span {...stylex.props(styles.sourceLine)}>
											L{contribution.location.line}
										</span>
										<span {...stylex.props(styles.operation)}>
											{operationText(contribution.operation)}
										</span>
										<span
											aria-label={
												contribution.remainsEffective
													? "effect survives"
													: "effect superseded"
											}
											{...stylex.props(
												styles.survival,
												contribution.remainsEffective &&
													styles.survivalActive
											)}
										>
											{contribution.remainsEffective
												? "Affects final"
												: "Superseded"}
										</span>
									</div>
									<div {...stylex.props(styles.contributionDetail)}>
										<code {...stylex.props(styles.inputValue)}>
											{contribution.inputValue ?? "∅"}
										</code>
										<span {...stylex.props(styles.effectNote)}>
											{effectText(contribution)}
										</span>
									</div>
								</div>
							</li>
						)}
					</For>
				</ol>
			</section>

			<div {...stylex.props(styles.disclosures)}>
				<details {...stylex.props(styles.ledger)}>
					<summary {...stylex.props(styles.ledgerSummary)}>
						Coverage · {missingCount()} optional layers absent ·{" "}
						{unresolvedLayers().length} unresolved total
					</summary>
					<div {...stylex.props(styles.ledgerBody)}>
						<For each={unresolvedLayers()}>
							{(layer) => (
								<div {...stylex.props(styles.ledgerRow)}>
									<span {...stylex.props(styles.exceptionStatus)}>
										{layer.status}
									</span>
									<code {...stylex.props(styles.monoPath)}>
										{layer.source.path}
									</code>
								</div>
							)}
						</For>
					</div>
				</details>

				<details {...stylex.props(styles.ledger)}>
					<summary {...stylex.props(styles.ledgerSummary)}>
						Excluded runtime authorities · {props.result.authorities.length}
					</summary>
					<div {...stylex.props(styles.ledgerBody)}>
						<For each={props.result.authorities}>
							{(authority) => (
								<div {...stylex.props(styles.authorityRow)}>
									<strong {...stylex.props(styles.authorityName)}>
										{authority.authority.replaceAll("_", " ")}
									</strong>
									<span {...stylex.props(styles.authorityDetail)}>
										{authority.detail}
									</span>
								</div>
							)}
						</For>
					</div>
				</details>
			</div>
		</article>
	);
}

function isComparison(result: ConfigExplorerSuppliedResult): result is ConfigComparison {
	return "left" in result;
}

export function ConfigExplorerRoute(props: { readonly result: ConfigExplorerSuppliedResult }) {
	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.scopeBar)}>
				<div {...stylex.props(styles.scopeIdentity)}>
					<strong {...stylex.props(styles.scopeTitle)}>Saved config evidence</strong>
					<span {...stylex.props(styles.scopeSubtitle)}>
						Exact source lines; read-only
					</span>
				</div>
				<span {...stylex.props(styles.scopeNote)}>Saved source · no runtime authority</span>
			</header>

			<Show
				when={isComparison(props.result) ? props.result : undefined}
				fallback={
					isComparison(props.result) ? undefined : <EvidencePanel result={props.result} />
				}
			>
				{(comparison) => (
					<>
						<div role="status" {...stylex.props(styles.compareStrip)}>
							<span
								{...stylex.props(
									styles.diffChip,
									comparison().valueChanged
										? styles.diffChipDiverges
										: styles.diffChipMatches
								)}
							>
								{comparison().valueChanged ? "Value diverges" : "Values match"}
							</span>
							<div {...stylex.props(styles.comparePair)}>
								<span {...stylex.props(styles.compareSide)}>
									<span {...stylex.props(styles.comparePlatform)}>
										{comparison().left.platform}
									</span>
									<code {...stylex.props(styles.compareValue)}>
										{valueText(comparison().left.effectiveValue)}
									</code>
								</span>
								<span {...stylex.props(styles.compareVersus)}>vs</span>
								<span {...stylex.props(styles.compareSide)}>
									<span {...stylex.props(styles.comparePlatform)}>
										{comparison().right.platform}
									</span>
									<code {...stylex.props(styles.compareValue)}>
										{valueText(comparison().right.effectiveValue)}
									</code>
								</span>
							</div>
							<span {...stylex.props(styles.coverageComparison)}>
								{comparison().coverageChanged
									? "Coverage also differs"
									: "Coverage aligned"}
							</span>
						</div>
						<section
							aria-label="Platform config comparison"
							{...stylex.props(styles.columns)}
						>
							<EvidencePanel result={comparison().left} compact />
							<EvidencePanel result={comparison().right} compact />
						</section>
					</>
				)}
			</Show>
		</main>
	);
}

const styles = stylex.create({
	page: {
		boxSizing: "border-box",
		backgroundColor: tokens.colorCanvas,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		lineHeight: 1.5,
		padding: 16
	},
	scopeBar: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 20,
		marginBottom: 14,
		padding: "0 2px 10px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	scopeIdentity: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 },
	scopeTitle: { fontSize: 13, fontWeight: 590, color: tokens.colorTextStrong },
	scopeSubtitle: { fontSize: 12, color: tokens.colorTextSubtle },
	scopeNote: { flexShrink: 0, color: tokens.colorTextFaint, fontSize: 11, fontWeight: 500 },
	panel: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	panelHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 18,
		padding: "12px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	panelHeaderCompact: { padding: "10px 12px" },
	platformIdentity: { minWidth: 0 },
	platform: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 15,
		fontWeight: 590,
		letterSpacing: "-0.01em",
		color: tokens.colorTextStrong
	},
	coordinate: {
		display: "block",
		marginTop: 3,
		overflow: "hidden",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	coverage: {
		flexShrink: 0,
		padding: "2px 8px",
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(76, 183, 130, 0.12)",
		color: tokens.colorSuccess,
		fontSize: 11,
		fontWeight: 500
	},
	coveragePartial: {
		backgroundColor: "rgba(242, 153, 74, 0.12)",
		color: tokens.colorWarning
	},
	valuePlate: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		minHeight: 76,
		padding: "12px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	valuePlateCompact: { minHeight: 60 },
	valueLabel: { color: tokens.colorTextSubtle, fontSize: 11, fontWeight: 500 },
	value: {
		marginTop: 6,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: "clamp(15px, 2vw, 21px)",
		fontWeight: 500,
		lineHeight: 1.35,
		overflowWrap: "anywhere"
	},
	stats: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		gap: 14,
		padding: "9px 14px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	stat: { display: "inline-flex", alignItems: "baseline", gap: 5 },
	statNumber: {
		fontFamily: tokens.fontMono,
		fontSize: 12,
		fontWeight: 590,
		color: tokens.colorText
	},
	statNumberIssue: { color: tokens.colorWarning },
	exceptions: {
		padding: "9px 14px 10px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	exceptionsHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 5 },
	sectionTitle: {
		margin: 0,
		fontSize: 13,
		fontWeight: 590,
		letterSpacing: "-0.005em",
		color: tokens.colorTextStrong
	},
	countChip: {
		padding: "1px 7px",
		borderRadius: tokens.radiusPill,
		backgroundColor: "rgba(242, 153, 74, 0.12)",
		color: tokens.colorWarning,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		fontWeight: 500
	},
	exceptionRow: {
		display: "grid",
		gridTemplateColumns: "92px minmax(0, 1fr)",
		gap: 10,
		padding: "2px 0",
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	exceptionStatus: {
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	monoPath: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	trace: { padding: "12px 14px 4px" },
	traceHeader: {
		display: "flex",
		alignItems: "baseline",
		justifyContent: "space-between",
		gap: 18,
		paddingBottom: 10
	},
	traceLegend: { flexShrink: 0, color: tokens.colorTextFaint, fontSize: 11 },
	timeline: { margin: 0, padding: "0 0 8px", listStyle: "none" },
	contribution: {
		display: "grid",
		gridTemplateColumns: "22px minmax(0, 1fr)",
		columnGap: 10
	},
	timelineRail: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		alignSelf: "stretch",
		gap: 4,
		paddingTop: 9
	},
	sequence: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 10,
		lineHeight: "15px",
		letterSpacing: "0.04em"
	},
	timelineConnector: {
		width: 1,
		flexGrow: 1,
		minHeight: 10,
		backgroundColor: tokens.colorBorder
	},
	contributionBody: {
		minWidth: 0,
		marginBottom: 6,
		padding: "7px 10px",
		borderRadius: tokens.radiusControl
	},
	contributionBodyEffective: { backgroundColor: tokens.colorAccentWash },
	contributionHead: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
	sourcePath: {
		flex: "0 1 auto",
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		fontFamily: tokens.fontMono,
		fontSize: 12,
		color: tokens.colorText
	},
	sourceLine: {
		flexShrink: 0,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		color: tokens.colorTextFaint
	},
	operation: {
		flexShrink: 0,
		width: "fit-content",
		padding: "2px 6px",
		borderRadius: tokens.radiusBadge,
		backgroundColor: "rgba(255, 255, 255, 0.05)",
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500,
		whiteSpace: "nowrap"
	},
	survival: {
		marginLeft: "auto",
		flexShrink: 0,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	survivalActive: { color: tokens.colorAccentStrong },
	contributionDetail: {
		display: "flex",
		alignItems: "baseline",
		gap: 8,
		minWidth: 0,
		marginTop: 5
	},
	inputValue: {
		fontFamily: tokens.fontMono,
		fontSize: 12,
		color: tokens.colorTextStrong,
		overflowWrap: "anywhere"
	},
	effectNote: { color: tokens.colorTextMuted, fontSize: 11 },
	disclosures: {
		display: "grid",
		gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))"
	},
	ledger: {
		padding: "9px 14px 10px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	ledgerSummary: {
		cursor: "pointer",
		color: tokens.colorTextMuted,
		fontSize: 12,
		fontWeight: 500
	},
	ledgerBody: { display: "flex", flexDirection: "column", gap: 6, padding: "9px 0 2px" },
	ledgerRow: { display: "grid", gap: 10, gridTemplateColumns: "74px minmax(0, 1fr)" },
	authorityRow: { display: "grid", gap: 10, gridTemplateColumns: "120px minmax(0, 1fr)" },
	authorityName: { fontWeight: 500, color: tokens.colorTextMuted },
	authorityDetail: { color: tokens.colorTextSubtle },
	compareStrip: {
		display: "flex",
		alignItems: "center",
		flexWrap: "wrap",
		gap: 12,
		marginBottom: 12,
		padding: "8px 12px",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		fontSize: 12
	},
	diffChip: {
		flexShrink: 0,
		padding: "2px 8px",
		borderRadius: tokens.radiusPill,
		fontSize: 11,
		fontWeight: 500
	},
	diffChipDiverges: {
		backgroundColor: "rgba(242, 153, 74, 0.12)",
		color: tokens.colorWarning
	},
	diffChipMatches: {
		backgroundColor: "rgba(76, 183, 130, 0.12)",
		color: tokens.colorSuccess
	},
	comparePair: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 },
	compareSide: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 },
	comparePlatform: { flexShrink: 0, fontSize: 12, fontWeight: 500, color: tokens.colorTextMuted },
	compareValue: {
		fontFamily: tokens.fontMono,
		fontSize: 12,
		color: tokens.colorText,
		overflowWrap: "anywhere"
	},
	compareVersus: { flexShrink: 0, color: tokens.colorTextFaint, fontSize: 11 },
	coverageComparison: {
		marginLeft: "auto",
		flexShrink: 0,
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	columns: {
		display: "grid",
		gap: 12,
		gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))"
	}
});

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
			return "MISSING";
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
		<article {...stylex.props(styles.panel, props.compact && styles.panelCompact)}>
			<header {...stylex.props(styles.panelHeader)}>
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
				{...stylex.props(styles.valuePlate)}
			>
				<span {...stylex.props(styles.valueLabel)}>Final saved value</span>
				<code {...stylex.props(styles.value)}>
					{valueText(props.result.effectiveValue)}
				</code>
			</section>

			<div {...stylex.props(styles.stats)}>
				<span>
					<strong>{effectiveCount()}</strong> affecting final
				</span>
				<span>
					<strong>{props.result.contributions.length}</strong> operations traced
				</span>
				<span>
					<strong>{readCount()}</strong> layers read
				</span>
				<Show when={exceptionalLayers().length > 0}>
					<span {...stylex.props(styles.issueStat)}>
						<strong>{exceptionalLayers().length}</strong> coverage issues
					</span>
				</Show>
			</div>

			<Show when={exceptionalLayers().length > 0}>
				<section
					aria-label={`${props.result.platform} coverage exceptions`}
					{...stylex.props(styles.exceptions)}
				>
					<header {...stylex.props(styles.sectionHeading)}>
						<strong>Evidence needs attention</strong>
						<span>The answer may be incomplete</span>
					</header>
					<For each={exceptionalLayers()}>
						{(layer) => (
							<div {...stylex.props(styles.exception)}>
								<span>{layer.status}</span>
								<code>{layer.source.path}</code>
							</div>
						)}
					</For>
				</section>
			</Show>

			<section {...stylex.props(styles.trace)}>
				<header {...stylex.props(styles.traceHeader)}>
					<div>
						<span {...stylex.props(styles.kicker)}>WHY THIS VALUE</span>
						<h3>Source operations, in load order</h3>
					</div>
					<span {...stylex.props(styles.traceLegend)}>
						Orange rows still affect the final value
					</span>
				</header>
				<ol
					aria-label={`${props.result.platform} ordered contributions`}
					{...stylex.props(styles.timeline)}
				>
					<For each={props.result.contributions}>
						{(contribution) => (
							<li
								{...stylex.props(
									styles.contribution,
									contribution.remainsEffective && styles.contributionEffective
								)}
							>
								<span {...stylex.props(styles.sequence)}>
									{String(contribution.sequence + 1).padStart(2, "0")}
								</span>
								<div {...stylex.props(styles.contributionSource)}>
									<code>{contribution.source.path}</code>
									<span>line {contribution.location.line}</span>
								</div>
								<span {...stylex.props(styles.operation)}>
									{operationText(contribution.operation)}
								</span>
								<div {...stylex.props(styles.contributionEffect)}>
									<strong>{contribution.inputValue ?? "∅"}</strong>
									<span>{effectText(contribution)}</span>
								</div>
								<span
									aria-label={
										contribution.remainsEffective
											? "effect survives"
											: "effect superseded"
									}
									{...stylex.props(
										styles.survival,
										contribution.remainsEffective && styles.survivalActive
									)}
								>
									{contribution.remainsEffective ? "AFFECTS FINAL" : "SUPERSEDED"}
								</span>
							</li>
						)}
					</For>
				</ol>
			</section>

			<div {...stylex.props(styles.disclosures)}>
				<details {...stylex.props(styles.ledger)}>
					<summary>
						Coverage · {missingCount()} optional layers absent ·{" "}
						{unresolvedLayers().length} unresolved total
					</summary>
					<div {...stylex.props(styles.ledgerBody)}>
						<For each={unresolvedLayers()}>
							{(layer) => (
								<div {...stylex.props(styles.ledgerRow)}>
									<span>{layer.status}</span>
									<code>{layer.source.path}</code>
								</div>
							)}
						</For>
					</div>
				</details>

				<details {...stylex.props(styles.ledger)}>
					<summary>
						Excluded runtime authorities · {props.result.authorities.length}
					</summary>
					<div {...stylex.props(styles.ledgerBody)}>
						<For each={props.result.authorities}>
							{(authority) => (
								<div {...stylex.props(styles.authorityRow)}>
									<strong>{authority.authority.replaceAll("_", " ")}</strong>
									<span>{authority.detail}</span>
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
					<strong>Saved config evidence</strong>
					<span>Exact source lines; read-only</span>
				</div>
				<span {...stylex.props(styles.scopeNote)}>SAVED SOURCE · NO RUNTIME AUTHORITY</span>
			</header>

			<Show
				when={isComparison(props.result) ? props.result : undefined}
				fallback={
					isComparison(props.result) ? undefined : <EvidencePanel result={props.result} />
				}
			>
				{(comparison) => (
					<>
						<div role="status" {...stylex.props(styles.compareBanner)}>
							<div {...stylex.props(styles.compareIdentity)}>
								<span>PLATFORM COMPARISON</span>
								<strong>
									{comparison().valueChanged ? "VALUE DIVERGES" : "VALUES MATCH"}
								</strong>
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
		padding: 16
	},
	scopeBar: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 20,
		marginBottom: 10,
		padding: "0 2px 10px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		fontSize: 9,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	scopeIdentity: { display: "flex", gap: 8 },
	scopeNote: { color: tokens.colorTextFaint },
	panel: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurface
	},
	panelCompact: { minWidth: 0 },
	panelHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 18,
		padding: "14px 16px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	platformIdentity: { minWidth: 0 },
	platform: {
		margin: 0,
		fontFamily: tokens.fontDisplay,
		fontSize: 21,
		fontWeight: 400
	},
	coordinate: {
		display: "block",
		marginTop: 4,
		overflow: "hidden",
		color: tokens.colorTextFaint,
		fontSize: 9,
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	coverage: {
		flexShrink: 0,
		padding: "5px 7px",
		border: `1px solid ${tokens.colorSuccess}`,
		color: tokens.colorSuccess,
		fontSize: 8,
		letterSpacing: ".08em",
		textTransform: "uppercase"
	},
	coveragePartial: { borderColor: tokens.colorWarningStrong, color: tokens.colorWarningStrong },
	valuePlate: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		minHeight: 80,
		padding: "14px 16px",
		backgroundColor: tokens.colorSurfaceInset
	},
	valueLabel: {
		color: tokens.colorTextFaint,
		fontSize: 8,
		letterSpacing: ".12em",
		textTransform: "uppercase"
	},
	value: {
		marginTop: 8,
		color: tokens.colorWarning,
		fontFamily: tokens.fontBody,
		fontSize: "clamp(16px, 2vw, 23px)",
		lineHeight: 1.3,
		overflowWrap: "anywhere"
	},
	stats: {
		display: "flex",
		flexWrap: "wrap",
		gap: 16,
		padding: "9px 16px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 9
	},
	issueStat: { color: tokens.colorWarningStrong },
	exceptions: {
		padding: "10px 16px",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: "#241814"
	},
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		gap: 16,
		marginBottom: 7,
		color: tokens.colorWarningStrong,
		fontSize: 9
	},
	exception: {
		display: "grid",
		gridTemplateColumns: "90px minmax(0, 1fr)",
		gap: 10,
		padding: "3px 0",
		color: tokens.colorTextMuted,
		fontSize: 9
	},
	trace: { padding: "14px 16px 6px" },
	traceHeader: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 18,
		paddingBottom: 9
	},
	kicker: { color: tokens.colorWarningStrong, fontSize: 8, letterSpacing: ".13em" },
	traceLegend: { color: tokens.colorTextFaint, fontSize: 8 },
	timeline: { margin: 0, padding: 0, listStyle: "none" },
	contribution: {
		display: "grid",
		gridTemplateColumns: "28px minmax(120px, 1fr) 84px minmax(120px, .8fr) 82px",
		alignItems: "center",
		gap: 9,
		minHeight: 46,
		padding: "5px 8px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		borderLeft: "2px solid transparent",
		color: tokens.colorTextMuted
	},
	contributionEffective: {
		borderLeftColor: tokens.colorWarningStrong,
		backgroundColor: "#d7894a0d",
		color: tokens.colorText
	},
	sequence: { color: tokens.colorTextFaint, fontSize: 8 },
	contributionSource: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		minWidth: 0,
		fontSize: 8
	},
	operation: {
		justifySelf: "start",
		padding: "3px 5px",
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		fontSize: 7,
		letterSpacing: ".05em",
		textTransform: "uppercase"
	},
	contributionEffect: {
		display: "flex",
		flexDirection: "column",
		gap: 3,
		minWidth: 0,
		fontSize: 8
	},
	survival: {
		justifySelf: "end",
		color: tokens.colorTextFaint,
		fontSize: 7,
		letterSpacing: ".05em"
	},
	survivalActive: { color: tokens.colorWarningStrong },
	disclosures: { display: "grid", gridTemplateColumns: "1fr 1fr" },
	ledger: {
		padding: "10px 16px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 8
	},
	ledgerBody: { display: "flex", flexDirection: "column", gap: 7, padding: "10px 0 2px" },
	ledgerRow: { display: "grid", gap: 10, gridTemplateColumns: "74px minmax(0, 1fr)" },
	authorityRow: { display: "grid", gap: 10, gridTemplateColumns: "120px minmax(0, 1fr)" },
	compareBanner: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 20,
		marginBottom: 10,
		padding: "10px 13px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderLeft: `3px solid ${tokens.colorWarningStrong}`,
		backgroundColor: tokens.colorSurfaceRaised,
		fontSize: 8,
		letterSpacing: ".08em"
	},
	compareIdentity: { display: "flex", alignItems: "center", gap: 9 },
	coverageComparison: { color: tokens.colorTextSubtle },
	columns: {
		display: "grid",
		gap: 10,
		gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))"
	}
});

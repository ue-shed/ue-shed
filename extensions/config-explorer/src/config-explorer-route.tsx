import * as stylex from "@stylexjs/stylex";
import type {
	ConfigComparison,
	ConfigContribution,
	ConfigExplanation,
	ConfigValueState
} from "@ue-shed/config-explorer/browser";
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
			return `added at ${contribution.effect.index}`;
		case "replaced":
			return `replaced “${contribution.effect.previousValue}”`;
		case "removed":
			return `removed index ${contribution.effect.index}`;
		case "cleared":
			return `cleared ${contribution.effect.removedValues.length} value(s)`;
		case "initialized_empty":
			return "initialized explicit empty";
		case "duplicate":
			return "duplicate · no change";
		case "no_match":
			return "no match · no change";
	}
}

function EvidencePanel(props: { readonly result: ConfigExplanation; readonly compact?: boolean }) {
	const exceptionalLayers = () =>
		props.result.layers.filter(({ status }) => status !== "read" && status !== "missing");
	const unresolvedLayers = () => props.result.layers.filter(({ status }) => status !== "read");
	const missingCount = () =>
		props.result.layers.filter(({ status }) => status === "missing").length;

	return (
		<article {...stylex.props(styles.panel, props.compact && styles.panelCompact)}>
			<header {...stylex.props(styles.panelHeader)}>
				<div>
					<span {...stylex.props(styles.eyebrow)}>{props.result.family}.ini lineage</span>
					<h2 {...stylex.props(styles.platform)}>{props.result.platform}</h2>
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
				<span {...stylex.props(styles.valueLabel)}>effective saved-source value</span>
				<code {...stylex.props(styles.value)}>
					{valueText(props.result.effectiveValue)}
				</code>
				<span {...stylex.props(styles.coordinate)}>
					[{props.result.section}] / {props.result.key}
				</span>
			</section>

			<div {...stylex.props(styles.stats)}>
				<span>
					<b>{props.result.contributions.length}</b> contributions
				</span>
				<span>
					<b>{missingCount()}</b> missing layers surfaced
				</span>
				<span>
					<b>{exceptionalLayers().length}</b> coverage exceptions
				</span>
			</div>

			<Show when={exceptionalLayers().length > 0}>
				<section
					aria-label={`${props.result.platform} coverage exceptions`}
					{...stylex.props(styles.exceptions)}
				>
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

			<details {...stylex.props(styles.ledger)}>
				<summary>
					Layer coverage ledger · {unresolvedLayers().length} absent or unresolved
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
					Authority boundary · {props.result.authorities.length} outside sources
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

			<ol
				aria-label={`${props.result.platform} ordered contributions`}
				{...stylex.props(styles.timeline)}
			>
				<For each={props.result.contributions}>
					{(contribution) => (
						<li {...stylex.props(styles.contribution)}>
							<span {...stylex.props(styles.sequence)}>
								{String(contribution.sequence + 1).padStart(2, "0")}
							</span>
							<div {...stylex.props(styles.contributionBody)}>
								<div {...stylex.props(styles.contributionTop)}>
									<code>
										{contribution.source.path}:{contribution.location.line}
									</code>
									<span {...stylex.props(styles.operation)}>
										{contribution.operation}
									</span>
								</div>
								<strong>{contribution.inputValue ?? "∅"}</strong>
								<span {...stylex.props(styles.effect)}>
									{effectText(contribution)}
								</span>
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
							/>
						</li>
					)}
				</For>
			</ol>
		</article>
	);
}

function isComparison(result: ConfigExplorerSuppliedResult): result is ConfigComparison {
	return "left" in result;
}

export function ConfigExplorerRoute(props: { readonly result: ConfigExplorerSuppliedResult }) {
	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.masthead)}>
				<div>
					<span {...stylex.props(styles.serial)}>UE SHED / CONFIG EVIDENCE 001</span>
					<h1 {...stylex.props(styles.title)}>Settings Archaeology</h1>
					<p {...stylex.props(styles.subtitle)}>
						A source ledger for the value Unreal saved—not the state a live process may
						observe.
					</p>
				</div>
				<div {...stylex.props(styles.authority)}>
					<span {...stylex.props(styles.authorityLamp)} />
					SAVED SOURCE
					<br />
					NO RUNTIME AUTHORITY
				</div>
			</header>

			<Show
				when={isComparison(props.result) ? props.result : undefined}
				fallback={<EvidencePanel result={props.result as ConfigExplanation} />}
			>
				{(comparison) => (
					<>
						<div role="status" {...stylex.props(styles.compareBanner)}>
							<span>platform comparison</span>
							<strong>
								{comparison().valueChanged ? "VALUE DIVERGES" : "VALUES MATCH"}
							</strong>
							<span>
								{comparison().coverageChanged
									? "coverage differs"
									: "coverage aligned"}
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
		backgroundColor: "#e9e5d8",
		backgroundImage:
			"linear-gradient(rgba(35, 38, 35, .045) 1px, transparent 1px), linear-gradient(90deg, rgba(35, 38, 35, .045) 1px, transparent 1px)",
		backgroundSize: "24px 24px",
		boxSizing: "border-box",
		color: "#20231f",
		fontFamily: '"Bahnschrift", "DIN Alternate", sans-serif',
		minHeight: "100vh",
		padding: "clamp(24px, 5vw, 72px)"
	},
	masthead: {
		alignItems: "end",
		borderBottom: "3px solid #20231f",
		display: "flex",
		gap: "32px",
		justifyContent: "space-between",
		marginBottom: "28px",
		paddingBottom: "22px"
	},
	serial: { color: "#596057", fontSize: "11px", letterSpacing: "0.18em" },
	title: {
		fontFamily: '"Rockwell", "Roboto Slab", serif',
		fontSize: "clamp(38px, 7vw, 80px)",
		letterSpacing: "-0.045em",
		lineHeight: 0.9,
		margin: "12px 0"
	},
	subtitle: { fontFamily: "Georgia, serif", fontSize: "15px", margin: 0, maxWidth: "640px" },
	authority: {
		border: "1px solid #20231f",
		fontSize: "10px",
		letterSpacing: "0.14em",
		lineHeight: 1.5,
		padding: "10px 14px",
		textAlign: "right"
	},
	authorityLamp: {
		backgroundColor: "#d4552d",
		borderRadius: "50%",
		display: "inline-block",
		height: "8px",
		marginRight: "7px",
		width: "8px"
	},
	panel: {
		backgroundColor: "rgba(247, 244, 233, .86)",
		border: "1px solid #8c8b81",
		boxShadow: "8px 8px 0 #cbc4b1",
		padding: "clamp(18px, 3vw, 34px)"
	},
	panelCompact: { boxShadow: "5px 5px 0 #cbc4b1", minWidth: 0 },
	panelHeader: {
		alignItems: "start",
		display: "flex",
		justifyContent: "space-between",
		marginBottom: "20px"
	},
	eyebrow: {
		color: "#687067",
		fontSize: "10px",
		letterSpacing: "0.15em",
		textTransform: "uppercase"
	},
	platform: { fontFamily: '"Rockwell", serif', fontSize: "28px", margin: "4px 0 0" },
	coverage: {
		border: "1px solid #39735e",
		color: "#285743",
		fontSize: "10px",
		letterSpacing: "0.12em",
		padding: "7px 9px",
		textTransform: "uppercase"
	},
	coveragePartial: { borderColor: "#b54b2c", color: "#9c3e24" },
	valuePlate: {
		backgroundColor: "#20231f",
		color: "#f6f0df",
		display: "flex",
		flexDirection: "column",
		minHeight: "116px",
		padding: "20px"
	},
	valueLabel: {
		color: "#a9afa4",
		fontSize: "10px",
		letterSpacing: "0.16em",
		textTransform: "uppercase"
	},
	value: {
		color: "#f3c969",
		fontFamily: '"Cascadia Mono", monospace',
		fontSize: "clamp(18px, 3vw, 31px)",
		margin: "14px 0"
	},
	coordinate: { color: "#a9afa4", fontFamily: '"Cascadia Mono", monospace', fontSize: "11px" },
	stats: {
		borderBottom: "1px solid #8c8b81",
		display: "flex",
		flexWrap: "wrap",
		fontSize: "11px",
		gap: "20px",
		padding: "14px 0"
	},
	exceptions: { borderBottom: "1px solid #8c8b81", padding: "10px 0" },
	exception: { display: "flex", fontSize: "10px", gap: "10px", padding: "4px 0" },
	ledger: { borderBottom: "1px solid #8c8b81", fontSize: "11px", padding: "12px 0" },
	ledgerBody: { display: "flex", flexDirection: "column", gap: "7px", padding: "12px 0 2px" },
	ledgerRow: { display: "grid", gap: "10px", gridTemplateColumns: "80px minmax(0, 1fr)" },
	authorityRow: { display: "grid", gap: "10px", gridTemplateColumns: "120px minmax(0, 1fr)" },
	timeline: { listStyle: "none", margin: "18px 0 0", padding: 0 },
	contribution: {
		alignItems: "stretch",
		borderTop: "1px solid #cfccbf",
		display: "grid",
		gap: "13px",
		gridTemplateColumns: "34px minmax(0, 1fr) 10px",
		padding: "13px 0"
	},
	sequence: {
		color: "#8a897f",
		fontFamily: '"Cascadia Mono", monospace',
		fontSize: "11px",
		paddingTop: "2px"
	},
	contributionBody: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 },
	contributionTop: {
		color: "#696c65",
		display: "flex",
		fontSize: "10px",
		gap: "12px",
		justifyContent: "space-between"
	},
	operation: {
		backgroundColor: "#dad5c5",
		letterSpacing: "0.08em",
		padding: "2px 5px",
		textTransform: "uppercase"
	},
	effect: { color: "#696c65", fontFamily: "Georgia, serif", fontSize: "12px" },
	survival: {
		alignSelf: "center",
		backgroundColor: "#c5c1b5",
		borderRadius: "50%",
		height: "8px",
		width: "8px"
	},
	survivalActive: { backgroundColor: "#d4552d", boxShadow: "0 0 0 3px rgba(212, 85, 45, .16)" },
	compareBanner: {
		alignItems: "center",
		backgroundColor: "#d6cfbb",
		border: "1px solid #8c8b81",
		display: "flex",
		fontSize: "11px",
		justifyContent: "space-between",
		letterSpacing: "0.1em",
		marginBottom: "18px",
		padding: "10px 14px",
		textTransform: "uppercase"
	},
	columns: {
		display: "grid",
		gap: "22px",
		gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 440px), 1fr))"
	}
});

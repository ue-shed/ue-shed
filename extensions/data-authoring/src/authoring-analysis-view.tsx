import { barX, barY, defineChart, dot } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Chart } from "@tanstack/charts/solid";
import { tooltip } from "@tanstack/charts/tooltip";
import * as stylex from "@stylexjs/stylex";
import { type AnalysisChartPlan, buildAnalysisPlan } from "@ue-shed/authoring";
import type { AuthoringRow, AuthoringTableSnapshot } from "@ue-shed/protocol";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { For, Show, createMemo } from "solid-js";

const chartFill = "#e4f222";
const chartStroke = "#08090a";
const scatterColors = ["#e4f222", "#4cb782", "#8fb8ff", "#f2994a", "#d89cff"];

export interface AuthoringAnalysisViewProps {
	readonly rows: readonly AuthoringRow[];
	readonly snapshot: AuthoringTableSnapshot;
}

type CategoryPlan = Extract<AnalysisChartPlan, { kind: "category-count" | "category-value" }>;
type HistogramPlan = Extract<AnalysisChartPlan, { kind: "histogram" }>;
type ScatterPlan = Extract<AnalysisChartPlan, { kind: "scatter" }>;

function shortObjectName(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

function CategoryChart(props: { readonly plan: CategoryPlan }) {
	const definition = createMemo(() => {
		const plan = props.plan;
		const data = plan.data;
		return defineChart(
			{
				marks: [
					barX(data, {
						fill: chartFill,
						inset: 2,
						key: "label",
						radius: 3,
						x: "value",
						y: "label"
					})
				],
				scales: {
					x: {
						axis: { label: plan.yLabel },
						grid: true,
						nice: true,
						scale: scaleLinear
					},
					y: {
						axis: { label: plan.xLabel },
						scale: () =>
							scaleBand<string>()
								.domain(data.map((row) => row.label))
								.padding(0.14)
					}
				}
			},
			{ tooltip }
		);
	});

	return <Chart definition={definition()} ariaLabel={props.plan.title} height={260} />;
}

function HistogramChart(props: { readonly plan: HistogramPlan }) {
	const definition = createMemo(() => {
		const plan = props.plan;
		const data = plan.data;
		return defineChart(
			{
				marks: [
					barY(data, {
						fill: chartFill,
						inset: 1,
						key: "label",
						radius: 2,
						x: "label",
						y: "count"
					})
				],
				scales: {
					x: {
						axis: { label: plan.xLabel },
						scale: () =>
							scaleBand<string>()
								.domain(data.map((row) => row.label))
								.padding(0.08)
					},
					y: {
						axis: { label: plan.yLabel },
						grid: true,
						nice: true,
						scale: scaleLinear
					}
				}
			},
			{ tooltip }
		);
	});

	return <Chart definition={definition()} ariaLabel={props.plan.title} height={260} />;
}

function ScatterChart(props: { readonly plan: ScatterPlan }) {
	const definition = createMemo(() => {
		const plan = props.plan;
		const data = plan.data;
		return defineChart(
			{
				color: { range: scatterColors },
				marks: [
					dot(data, {
						color: "series",
						key: "rowName",
						r: 4,
						stroke: chartStroke,
						strokeWidth: 1,
						x: "x",
						y: "y"
					})
				],
				scales: {
					x: {
						axis: { label: plan.xLabel },
						grid: true,
						nice: true,
						scale: scaleLinear
					},
					y: {
						axis: { label: plan.yLabel },
						grid: true,
						nice: true,
						scale: scaleLinear
					}
				}
			},
			{ tooltip }
		);
	});

	return <Chart definition={definition()} ariaLabel={props.plan.title} height={260} />;
}

function ChartBody(props: { readonly plan: AnalysisChartPlan }) {
	switch (props.plan.kind) {
		case "category-count":
		case "category-value":
			return <CategoryChart plan={props.plan} />;
		case "histogram":
			return <HistogramChart plan={props.plan} />;
		case "scatter":
			return <ScatterChart plan={props.plan} />;
	}
}

function ChartCard(props: { readonly plan: AnalysisChartPlan }) {
	return (
		<article {...stylex.props(styles.card)}>
			<header {...stylex.props(styles.cardHeader)}>
				<div>
					<h3 {...stylex.props(styles.cardTitle)}>{props.plan.title}</h3>
					<p {...stylex.props(styles.cardDescription)}>{props.plan.description}</p>
				</div>
				<Show when={props.plan.source === "specified"}>
					<span {...stylex.props(styles.badge)}>Requested</span>
				</Show>
			</header>
			<div {...stylex.props(styles.surface)}>
				<ChartBody plan={props.plan} />
			</div>
		</article>
	);
}

export function AuthoringAnalysisView(props: AuthoringAnalysisViewProps) {
	const plan = createMemo(() =>
		buildAnalysisPlan({ rows: props.rows, snapshot: props.snapshot })
	);

	return (
		<section aria-label="Table charts" {...stylex.props(styles.canvas)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<h2 {...stylex.props(styles.title)}>
						Patterns in {shortObjectName(props.snapshot.table.objectPath)}
					</h2>
				</div>
				<div {...stylex.props(styles.stats)}>
					<span {...stylex.props(styles.stat)}>{plan().rowCount} rows</span>
					<span {...stylex.props(styles.stat)}>
						{plan().profiledColumnCount} chartable fields
					</span>
				</div>
			</header>

			<Show
				when={plan().charts.length > 0}
				fallback={
					<div {...stylex.props(styles.empty)}>
						<strong {...stylex.props(styles.emptyTitle)}>Nothing chartable yet</strong>
						<p {...stylex.props(styles.emptyDescription)}>
							Charts appear for boolean, enum, and numeric fields in the current
							filter.
						</p>
					</div>
				}
			>
				<div {...stylex.props(styles.gallery)}>
					<For each={plan().charts}>{(chart) => <ChartCard plan={chart} />}</For>
				</div>
			</Show>

			<Show when={plan().issues.length > 0}>
				<div {...stylex.props(styles.issues)}>
					<strong>Some requested charts could not be rendered.</strong>
					<For each={plan().issues}>{(issue) => <span>{issue}</span>}</For>
				</div>
			</Show>
		</section>
	);
}

const styles = stylex.create({
	canvas: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space4,
		minHeight: 320,
		padding: tokens.space4
	},
	header: {
		display: "flex",
		alignItems: "flex-end",
		justifyContent: "space-between",
		gap: tokens.space3,
		flexWrap: "wrap"
	},
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 16,
		fontWeight: 600
	},
	stats: {
		display: "flex",
		gap: tokens.space2,
		flexWrap: "wrap"
	},
	stat: {
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		padding: "2px 8px",
		fontSize: 11
	},
	gallery: {
		display: "grid",
		gridTemplateColumns: {
			default: "repeat(2, minmax(0, 1fr))",
			"@media (max-width: 1000px)": "minmax(0, 1fr)"
		},
		gap: tokens.space3
	},
	card: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusPanel,
		backgroundColor: tokens.colorSurfaceRaised,
		padding: tokens.space3
	},
	cardHeader: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: tokens.space2
	},
	cardTitle: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontSize: 13,
		fontWeight: 600
	},
	cardDescription: {
		margin: "4px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 12
	},
	badge: {
		borderRadius: tokens.radiusPill,
		backgroundColor: tokens.colorAccentWash,
		color: tokens.colorAccentStrong,
		padding: "2px 8px",
		fontSize: 11
	},
	surface: {
		minHeight: 260
	},
	empty: {
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: tokens.space2,
		padding: tokens.space6,
		color: tokens.colorTextMuted,
		textAlign: "center"
	},
	emptyTitle: {
		color: tokens.colorTextStrong,
		fontSize: 14
	},
	emptyDescription: {
		margin: 0,
		maxWidth: 420,
		fontSize: 13
	},
	issues: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		color: tokens.colorWarning,
		fontSize: 12
	}
});

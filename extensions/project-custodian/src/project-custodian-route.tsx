import * as stylex from "@stylexjs/stylex";
import type {
	CustodianEngineReport,
	CustodianProjectReport,
	CustodianReport,
	CustodianTarget
} from "@ue-shed/project-custodian/browser";
import { Button, createEffectAction, PageHeader } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { Accessor, JSX } from "solid-js";
import type {
	CustodianClientShape,
	CustodianPublicError,
	CustodianRunResult
} from "./custodian-client.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| { readonly status: "failed"; readonly error: CustodianPublicError }
	| { readonly status: "ready"; readonly report: CustodianReport };

type InventoryItem = CustodianProjectReport | CustodianEngineReport;

function humanBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit < 2 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return value.toFixed(digits) + " " + units[unit];
}

function leaf(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized.split("/").at(-1) ?? path;
}

function eligibilityLabel(project: CustodianProjectReport): string {
	switch (project.eligibility.kind) {
		case "candidate":
			return "eligible";
		case "opted_out":
			return "opted out";
		case "recent":
			return Math.ceil(project.eligibility.eligibleAfterDays) + "d grace";
		case "unknown_age":
			return "age unknown";
		case "invalid_policy":
			return "policy refused";
		case "empty":
			return "clean";
	}
}

function stateFrom(result: CustodianRunResult): ViewState {
	switch (result.status) {
		case "completed":
			return { status: "ready", report: result.report };
		case "failed":
			return { status: "failed", error: result.error };
		case "cancelled":
			return { status: "cancelled" };
		case "not_configured":
			return { status: "not_configured" };
	}
}

export function ProjectCustodianRoute(props: { readonly client: CustodianClientShape }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const report = createMemo(() => {
		const current = state();
		return current.status === "ready" ? current.report : undefined;
	});
	const inventory = createMemo<readonly InventoryItem[]>(() => {
		const current = report();
		return current === undefined
			? []
			: [...current.projects, ...current.engines].sort(
					(left, right) =>
						right.reclaimableBytes - left.reclaimableBytes ||
						left.name.localeCompare(right.name)
				);
	});

	const run = (operation: () => ReturnType<CustodianClientShape["configuredScan"]>) => {
		setState({ status: "loading" });
		action.run(operation(), {
			onSuccess: (result) => setState(stateFrom(result)),
			onFailure: (cause) =>
				setState({
					status: "failed",
					error: {
						code: "scan_failed",
						message: Cause.pretty(cause),
						recovery: "Choose a readable directory and retry. No files were changed.",
						retrySafe: true
					}
				})
		});
	};

	onMount(() => run(() => props.client.configuredScan()));

	return (
		<main {...stylex.props(styles.page)}>
			<PageHeader
				eyebrow="Project Custodian · storage evidence"
				actions={
					<>
						<Button
							tone="quiet"
							disabled={state().status === "loading" || report() === undefined}
							onClick={() => run(() => props.client.configuredScan())}
						>
							Rescan
						</Button>
						<Button
							tone="primary"
							disabled={state().status === "loading"}
							onClick={() => run(() => props.client.chooseAndScan())}
						>
							Choose scan root…
						</Button>
					</>
				}
			/>

			<div {...stylex.props(styles.safetyRail)}>
				<span {...stylex.props(styles.safetyMark)}>READ ONLY</span>
				<span>
					Inventory and planning only. No delete, move, Trash, or Recycle Bin authority.
				</span>
			</div>

			<Show when={state().status === "loading"}>
				<div {...stylex.props(styles.loading)} role="progressbar" aria-busy="true">
					<span {...stylex.props(styles.loadingBar)} />
				</div>
			</Show>

			<Switch>
				<Match when={state().status === "loading"}>
					<EmptyState index="00" title="Reading the rebuildable layer.">
						Walking known Unreal output directories and resolving safety policy.
						Authored content is never a candidate.
					</EmptyState>
				</Match>
				<Match when={state().status === "not_configured" || state().status === "cancelled"}>
					<EmptyState index="01" title="Name the ground to inspect.">
						Choose a project, engine directory, or parent folder. The scan never expands
						beyond that root.
						<div {...stylex.props(styles.emptyAction)}>
							<Button
								tone="primary"
								onClick={() => run(() => props.client.chooseAndScan())}
							>
								Choose scan root…
							</Button>
						</div>
					</EmptyState>
				</Match>
				<Match when={state().status === "failed"}>
					<Show when={state()} keyed>
						{(current: ViewState) => (
							<section {...stylex.props(styles.error)}>
								<span>
									{current.status === "failed" ? current.error.code : "failed"}
								</span>
								<h1>
									{current.status === "failed"
										? current.error.message
										: "Scan failed."}
								</h1>
								<p>
									{current.status === "failed"
										? current.error.recovery
										: "Retry."}
								</p>
							</section>
						)}
					</Show>
				</Match>
				<Match when={report()}>
					{(current: Accessor<CustodianReport>) => (
						<CustodianLedger report={current()} inventory={inventory()} />
					)}
				</Match>
			</Switch>
		</main>
	);
}

function EmptyState(props: {
	readonly index: string;
	readonly title: string;
	readonly children: JSX.Element;
}) {
	return (
		<section {...stylex.props(styles.empty)}>
			<span {...stylex.props(styles.emptyIndex)}>{props.index}</span>
			<h1>{props.title}</h1>
			<div {...stylex.props(styles.emptyCopy)}>{props.children}</div>
		</section>
	);
}

function CustodianLedger(props: {
	readonly report: CustodianReport;
	readonly inventory: readonly InventoryItem[];
}) {
	const pressure = () => {
		const threshold = props.report.plan.thresholdBytes;
		return threshold === 0 ? 100 : Math.min(100, (props.report.freeBytes / threshold) * 100);
	};
	return (
		<>
			<section aria-label="Storage summary" {...stylex.props(styles.summary)}>
				<div {...stylex.props(styles.heroMetric)}>
					<span {...stylex.props(styles.metricLabel)}>Rebuildable footprint</span>
					<strong>{humanBytes(props.report.totalReclaimableBytes)}</strong>
					<span {...stylex.props(styles.metricNote)}>
						{props.report.projects.length} projects · {props.report.engines.length}{" "}
						engines
					</span>
				</div>
				<Metric label="Free now" value={humanBytes(props.report.freeBytes)} />
				<Metric
					label="Dry-run queue"
					value={humanBytes(props.report.plan.reclaimableBytes)}
				/>
				<Metric
					label="After plan"
					value={humanBytes(props.report.plan.projectedFreeBytes)}
				/>
			</section>

			<section aria-label="Disk pressure" {...stylex.props(styles.pressure)}>
				<div {...stylex.props(styles.pressureHead)}>
					<span>VOLUME PRESSURE</span>
					<strong>
						{humanBytes(props.report.freeBytes)} free /{" "}
						{humanBytes(props.report.plan.thresholdBytes)} target
					</strong>
				</div>
				<div {...stylex.props(styles.pressureTrack)}>
					<span
						{...stylex.props(styles.pressureFill)}
						style={{ width: pressure() + "%" }}
					/>
					<i {...stylex.props(styles.threshold)} />
				</div>
				<p>{planExplanation(props.report)}</p>
			</section>

			<div {...stylex.props(styles.columns)}>
				<section aria-label="Custodian inventory" {...stylex.props(styles.inventory)}>
					<SectionHeader
						left={"INVENTORY / " + props.inventory.length.toString().padStart(2, "0")}
						right={leaf(props.report.root)}
					/>
					<Show
						when={props.inventory.length > 0}
						fallback={
							<p {...stylex.props(styles.noRows)}>
								No Unreal projects or engines found.
							</p>
						}
					>
						<For each={props.inventory}>
							{(item, index) => <InventoryRow item={item} index={index()} />}
						</For>
					</Show>
				</section>

				<aside aria-label="Dry-run plan" {...stylex.props(styles.plan)}>
					<SectionHeader
						left="DRY-RUN QUEUE"
						right={props.report.plan.items.length.toString().padStart(2, "0")}
					/>
					<Show
						when={props.report.plan.items.length > 0}
						fallback={
							<p {...stylex.props(styles.noRows)}>
								Nothing would be reclaimed under current age and pressure policy.
							</p>
						}
					>
						<For each={props.report.plan.items}>
							{(item, index) => (
								<div {...stylex.props(styles.planItem)}>
									<span {...stylex.props(styles.planOrder)}>
										{String(index() + 1).padStart(2, "0")}
									</span>
									<div>
										<strong>{item.name}</strong>
										<small>{item.targets.length} known targets</small>
									</div>
									<b>{humanBytes(item.bytes)}</b>
								</div>
							)}
						</For>
					</Show>
					<footer {...stylex.props(styles.planFooter)}>
						<span>EXECUTION</span>
						<strong>NOT AVAILABLE</strong>
					</footer>
				</aside>
			</div>
			<footer {...stylex.props(styles.provenance)}>
				Measured {new Date(props.report.measuredAt).toLocaleString()} · explicit root{" "}
				{props.report.root} · authored directories excluded by construction
			</footer>
		</>
	);
}

function planExplanation(report: CustodianReport): string {
	if (report.plan.status === "pressure_satisfied")
		return "Pressure threshold satisfied. Inventory remains visible; the automatic queue is empty.";
	if (report.plan.status === "nothing_eligible")
		return "No eligible rebuildable output is old enough to queue.";
	return (
		report.plan.items.length +
		" largest item(s) would restore the configured free-space target."
	);
}

function Metric(props: { readonly label: string; readonly value: string }) {
	return (
		<div {...stylex.props(styles.metric)}>
			<span {...stylex.props(styles.metricLabel)}>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	);
}

function SectionHeader(props: { readonly left: string; readonly right: string }) {
	return (
		<header {...stylex.props(styles.sectionHeader)}>
			<span>{props.left}</span>
			<span>{props.right}</span>
		</header>
	);
}

function InventoryRow(props: { readonly item: InventoryItem; readonly index: number }) {
	const status = () =>
		props.item.kind === "project"
			? eligibilityLabel(props.item)
			: props.item.buildKind + " build";
	return (
		<details {...stylex.props(styles.row)}>
			<summary {...stylex.props(styles.rowSummary)}>
				<span {...stylex.props(styles.rowIndex)}>
					{String(props.index + 1).padStart(2, "0")}
				</span>
				<span
					{...stylex.props(
						styles.kind,
						props.item.kind === "engine" && styles.engineKind
					)}
				>
					{props.item.kind === "project" ? "PROJECT" : "ENGINE"}
				</span>
				<span {...stylex.props(styles.identity)}>
					<strong>{props.item.name}</strong>
					<small>{props.item.root}</small>
				</span>
				<span {...stylex.props(styles.rowStatus)}>{status()}</span>
				<b {...stylex.props(styles.rowBytes)}>{humanBytes(props.item.reclaimableBytes)}</b>
			</summary>
			<div {...stylex.props(styles.targets)}>
				<For each={props.item.targets}>{(target) => <TargetRow target={target} />}</For>
				<For each={props.item.refusals}>
					{(entry) => (
						<div {...stylex.props(styles.refusal)}>
							<span>LOCKED</span>
							<strong>{entry.relativePath}</strong>
							<small>{entry.reason}</small>
						</div>
					)}
				</For>
			</div>
		</details>
	);
}

function TargetRow(props: { readonly target: CustodianTarget }) {
	const riskStyle = () =>
		({ low: styles.low, medium: styles.medium, high: styles.high, critical: styles.critical })[
			props.target.risk
		];
	return (
		<div {...stylex.props(styles.target)}>
			<span {...stylex.props(styles.risk, riskStyle())}>{props.target.risk}</span>
			<div>
				<strong>{props.target.relativePath}</strong>
				<small>{props.target.rebuildCost}</small>
			</div>
			<b>{humanBytes(props.target.bytes)}</b>
		</div>
	);
}

const sweep = stylex.keyframes({
	from: { transform: "translateX(-100%)" },
	to: { transform: "translateX(420%)" }
});

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "24px 30px 34px",
		backgroundColor: "#0d100f",
		backgroundImage:
			"linear-gradient(#88908708 1px, transparent 1px), linear-gradient(90deg, #88908708 1px, transparent 1px)",
		backgroundSize: "24px 24px",
		color: tokens.colorText
	},
	safetyRail: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		margin: "10px 0 18px",
		padding: "9px 12px",
		borderLeft: "3px solid #7bc8b2",
		backgroundColor: "#101a17e6",
		color: "#9db0a9",
		fontSize: 10,
		letterSpacing: ".03em"
	},
	safetyMark: { color: "#9be2cd", fontWeight: 800, letterSpacing: ".14em" },
	loading: { height: 2, overflow: "hidden", backgroundColor: "#28302d" },
	loadingBar: {
		display: "block",
		width: "24%",
		height: "100%",
		backgroundColor: "#e39b54",
		animationName: sweep,
		animationDuration: "1.2s",
		animationIterationCount: "infinite",
		animationTimingFunction: "ease-in-out"
	},
	empty: {
		position: "relative",
		maxWidth: 670,
		margin: "72px auto",
		padding: "30px 0 30px 88px",
		borderTop: "1px solid #3b433f",
		borderBottom: "1px solid #3b433f"
	},
	emptyIndex: {
		position: "absolute",
		left: 0,
		top: 30,
		color: "#e39b54",
		fontFamily: "Georgia, serif",
		fontSize: 34
	},
	emptyCopy: { color: "#8b9690", fontSize: 11, lineHeight: 1.7 },
	emptyAction: { marginTop: 18 },
	error: {
		maxWidth: 780,
		margin: "50px auto",
		padding: 24,
		border: "1px solid #874d45",
		backgroundColor: "#1e1210"
	},
	summary: {
		display: "grid",
		gridTemplateColumns: "minmax(290px, 1.5fr) repeat(3, minmax(130px, .7fr))",
		border: "1px solid #353d39",
		backgroundColor: "#111513f2"
	},
	heroMetric: { padding: "18px 22px", borderRight: "1px solid #353d39" },
	metric: { padding: "18px", borderRight: "1px solid #353d39" },
	metricLabel: {
		display: "block",
		marginBottom: 8,
		color: "#6e7973",
		fontSize: 8,
		letterSpacing: ".14em",
		textTransform: "uppercase"
	},
	metricNote: { display: "block", marginTop: 7, color: "#728078", fontSize: 9 },
	pressure: {
		marginTop: 12,
		padding: "13px 16px",
		border: "1px solid #303834",
		backgroundColor: "#0f1311e6"
	},
	pressureHead: {
		display: "flex",
		justifyContent: "space-between",
		color: "#758079",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	pressureTrack: {
		position: "relative",
		height: 7,
		marginTop: 11,
		backgroundColor: "#232a27",
		overflow: "hidden"
	},
	pressureFill: { display: "block", height: "100%", backgroundColor: "#76bda9" },
	threshold: {
		position: "absolute",
		right: 0,
		top: -2,
		width: 2,
		height: 11,
		backgroundColor: "#e39b54"
	},
	columns: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1.8fr) minmax(280px, .7fr)",
		gap: 12,
		marginTop: 12
	},
	inventory: { border: "1px solid #343c38", backgroundColor: "#111513f2" },
	plan: { border: "1px solid #343c38", backgroundColor: "#121614f2" },
	sectionHeader: {
		display: "flex",
		justifyContent: "space-between",
		padding: "10px 13px",
		borderBottom: "1px solid #343c38",
		color: "#718078",
		fontSize: 8,
		letterSpacing: ".13em"
	},
	noRows: { padding: 18, color: "#748078", fontSize: 10, lineHeight: 1.6 },
	row: { borderBottom: "1px solid #2b322f" },
	rowSummary: {
		display: "grid",
		gridTemplateColumns: "30px 58px minmax(0, 1fr) 88px 88px",
		alignItems: "center",
		gap: 9,
		padding: "12px 13px",
		cursor: "pointer",
		listStyle: "none",
		backgroundColor: { default: "transparent", ":hover": "#18201ce6" }
	},
	rowIndex: { color: "#4c5650", fontFamily: "Georgia, serif", fontSize: 13 },
	kind: { color: "#e2a669", fontSize: 7, fontWeight: 800, letterSpacing: ".12em" },
	engineKind: { color: "#7bc8b2" },
	identity: { minWidth: 0, overflow: "hidden" },
	rowStatus: { color: "#77827b", fontSize: 8, textTransform: "uppercase" },
	rowBytes: { color: "#dce3de", fontSize: 11, textAlign: "right" },
	targets: { padding: "0 13px 10px 110px", backgroundColor: "#0c100eee" },
	target: {
		display: "grid",
		gridTemplateColumns: "48px minmax(0, 1fr) 72px",
		alignItems: "center",
		gap: 10,
		padding: "9px 0",
		borderBottom: "1px dotted #303733"
	},
	risk: { fontSize: 7, letterSpacing: ".08em", textTransform: "uppercase" },
	low: { color: "#7bc8b2" },
	medium: { color: "#d3bd72" },
	high: { color: "#e39b54" },
	critical: { color: "#e26d5c" },
	refusal: {
		display: "grid",
		gridTemplateColumns: "48px 150px minmax(0, 1fr)",
		gap: 10,
		padding: "9px 0",
		color: "#936a63",
		fontSize: 8
	},
	planItem: {
		display: "grid",
		gridTemplateColumns: "28px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 10,
		padding: "13px",
		borderBottom: "1px solid #2e3531"
	},
	planOrder: { color: "#e39b54", fontFamily: "Georgia, serif", fontSize: 16 },
	planFooter: {
		display: "flex",
		justifyContent: "space-between",
		margin: 12,
		paddingTop: 12,
		borderTop: "1px solid #3b433f",
		color: "#7b8780",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	provenance: {
		marginTop: 12,
		color: "#535d57",
		fontSize: 8,
		letterSpacing: ".04em",
		overflowWrap: "anywhere"
	}
});

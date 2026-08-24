import * as stylex from "@stylexjs/stylex";
import type {
	TextCorpus,
	TextCorpusRunResult,
	TextOccurrence,
	TextUnit
} from "@ue-shed/game-text/browser";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import {
	filterTextUnits,
	identityLabel,
	occurrenceContext,
	sourceText,
	type CapabilityFilter
} from "./game-text-view.js";

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: Extract<TextCorpusRunResult, { status: "failed" }>["error"];
	  }
	| { readonly status: "ready"; readonly corpus: TextCorpus };

/** Retained only for compatibility with tests of the pre-query presentation model. */
export interface LegacyGameTextClientApi {
	readonly chooseProjectAndScan: () => import("effect").Effect.Effect<
		TextCorpusRunResult,
		unknown
	>;
	readonly loadConfiguredProject: () => import("effect").Effect.Effect<
		TextCorpusRunResult,
		unknown
	>;
}

const filters: readonly { readonly value: CapabilityFilter; readonly label: string }[] = [
	{ value: "all", label: "All text" },
	{ value: "source_editable", label: "Source editable" },
	{ value: "read_only", label: "Read only" }
];

function sourceKind(unit: TextUnit): string {
	const kinds = new Set(unit.occurrences.map((occurrence) => occurrence.location.kind));
	if (kinds.size > 1) return "Multiple sources";
	const kind = kinds.values().next().value;
	if (kind === "string_table_entry") return "String Table";
	if (kind === "data_table_cell") return "DataTable";
	return "Asset property";
}

function OccurrenceCard(props: { readonly occurrence: TextOccurrence }) {
	return (
		<article {...stylex.props(styles.occurrence)}>
			<div {...stylex.props(styles.occurrenceHeading)}>
				<strong>{occurrenceContext(props.occurrence)}</strong>
				<span
					{...stylex.props(
						styles.authority,
						props.occurrence.editCapability === "source_editable"
							? styles.authorityEditable
							: styles.authorityReadOnly
					)}
				>
					{props.occurrence.editCapability === "source_editable"
						? "Source editable"
						: "Read only"}
				</span>
			</div>
			<p {...stylex.props(styles.objectPath)}>{props.occurrence.location.objectPath}</p>
			<code {...stylex.props(styles.packagePath)}>{props.occurrence.packageFile}</code>
		</article>
	);
}

export function LegacyGameTextRoute(props: { readonly client: LegacyGameTextClientApi }) {
	const scanAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [query, setQuery] = createSignal("");
	const [capability, setCapability] = createSignal<CapabilityFilter>("all");
	const [selectedId, setSelectedId] = createSignal<string>();
	const corpus = () => {
		const current = state();
		return current.status === "ready" ? current.corpus : undefined;
	};
	const visible = createMemo(() => {
		const current = corpus();
		return current
			? filterTextUnits({ corpus: current, query: query(), capability: capability() })
			: [];
	});
	const selected = createMemo(
		() => visible().find((unit) => unit.id === selectedId()) ?? visible()[0]
	);
	const applyResult = (result: TextCorpusRunResult) => {
		if (result.status === "completed") {
			setState({ status: "ready", corpus: result.corpus });
			setSelectedId(result.corpus.units[0]?.id);
		} else if (result.status === "failed") {
			setState({ status: "failed", error: result.error });
		} else setState({ status: result.status });
	};
	const run = () => {
		setState({ status: "loading" });
		scanAction.run(props.client.loadConfiguredProject(), {
			onFailure: (cause) =>
				setState({
					error: {
						code: "contract_failure",
						message: Cause.pretty(cause),
						recovery:
							"Restart Workbench. If the problem persists, verify package versions.",
						retrySafe: true
					},
					status: "failed"
				}),
			onSuccess: applyResult
		});
	};
	onMount(run);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div {...stylex.props(styles.headerLead)}>
					<h1 {...stylex.props(styles.title)}>Game text</h1>
					<p {...stylex.props(styles.subtitle)}>
						Find player-facing text and jump straight back to its package and property.
					</p>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<Button type="button" onClick={run} tone="secondary">
						Rescan
					</Button>
				</div>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<p role="status" {...stylex.props(styles.loadingLine)}>
						Loading saved game text…
					</p>
				</Match>
				<Match when={state().status === "not_configured"}>
					<section {...stylex.props(styles.noticeCard)}>
						<strong {...stylex.props(styles.noticeTitle)}>
							No project is configured.
						</strong>
						<p {...stylex.props(styles.noticeCopy)}>
							Choose an Unreal project in the Workbench header, then rescan.
						</p>
						<Button type="button" onClick={run} tone="secondary">
							Retry
						</Button>
					</section>
				</Match>
				<Match when={state().status === "cancelled"}>
					<section {...stylex.props(styles.noticeCard)}>
						<strong {...stylex.props(styles.noticeTitle)}>
							Project selection was cancelled.
						</strong>
						<p {...stylex.props(styles.noticeCopy)}>
							Pick a project to load its saved game text.
						</p>
						<Button type="button" onClick={run} tone="secondary">
							Retry
						</Button>
					</section>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<section role="alert" {...stylex.props(styles.failureCard)}>
								<strong {...stylex.props(styles.failureTitle)}>
									Couldn’t load saved game text.
								</strong>
								<p {...stylex.props(styles.failureCopy)}>
									{current.error.recovery}
								</p>
								<Button type="button" onClick={run} tone="secondary">
									Retry
								</Button>
								<details {...stylex.props(styles.technicalDetails)}>
									<summary {...stylex.props(styles.techSummary)}>
										Technical details
									</summary>
									<pre {...stylex.props(styles.techPre)}>
										{current.error.message}
									</pre>
								</details>
							</section>
						);
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					{(() => {
						const current = state();
						if (current.status !== "ready") return null;
						return (
							<CorpusWorkspace
								corpus={current.corpus}
								query={query()}
								capability={capability()}
								visible={visible()}
								selected={selected()}
								onQuery={setQuery}
								onCapability={setCapability}
								onSelect={setSelectedId}
							/>
						);
					})()}
				</Match>
			</Switch>
		</main>
	);
}

function CorpusWorkspace(props: {
	readonly corpus: TextCorpus;
	readonly query: string;
	readonly capability: CapabilityFilter;
	readonly visible: readonly TextUnit[];
	readonly selected: TextUnit | undefined;
	readonly onQuery: (value: string) => void;
	readonly onCapability: (value: CapabilityFilter) => void;
	readonly onSelect: (value: string) => void;
}) {
	const coverage = props.corpus.coverage;
	return (
		<div {...stylex.props(styles.workspace)}>
			<section aria-label="Saved text coverage" {...stylex.props(styles.coverage)}>
				<div
					{...stylex.props(
						styles.coverageLead,
						props.corpus.status === "partial" && styles.coveragePartial
					)}
				>
					<strong {...stylex.props(styles.metricValue)}>
						{coverage.textUnits.toLocaleString()}
					</strong>
					<span>text units</span>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong {...stylex.props(styles.metricValue)}>
						{coverage.textOccurrences.toLocaleString()}
					</strong>
					<span>occurrences</span>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong {...stylex.props(styles.metricValue)}>
						{coverage.inspectedPackages}/{coverage.discoveredPackages}
					</strong>
					<span>packages read</span>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong {...stylex.props(styles.metricValue)}>
						{coverage.unsupportedTextProperties}
					</strong>
					<span>properties not decoded</span>
				</div>
				<div {...stylex.props(styles.coverageStatus)}>
					<span
						{...stylex.props(
							styles.coverageBadge,
							props.corpus.status === "complete" ? styles.complete : styles.partial
						)}
					>
						{props.corpus.status === "complete" ? "Complete" : "Partial"}
					</span>
				</div>
			</section>
			<form
				aria-label="Search game text"
				onSubmit={(event) => event.preventDefault()}
				{...stylex.props(styles.searchBar)}
			>
				<input
					autofocus
					type="search"
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
					placeholder="Search source text…"
					aria-label="Search game text"
					{...stylex.props(styles.searchInput)}
				/>
				<div
					aria-label="Filter by source support"
					role="group"
					{...stylex.props(styles.filterBar)}
				>
					<For each={filters}>
						{(filter) => (
							<button
								type="button"
								aria-pressed={props.capability === filter.value}
								onClick={() => props.onCapability(filter.value)}
								{...stylex.props(
									styles.filterButton,
									props.capability === filter.value && styles.filterActive
								)}
							>
								{filter.label}
							</button>
						)}
					</For>
				</div>
				<span {...stylex.props(styles.matchCount)}>
					{props.visible.length} / {coverage.textUnits.toLocaleString()}
				</span>
			</form>
			<div {...stylex.props(styles.contentGrid)}>
				<section aria-label="Results" {...stylex.props(styles.results)}>
					<Show
						when={props.visible.length > 0}
						fallback={
							<p {...stylex.props(styles.noMatches)}>
								No matches. Widen the search or clear filters.
							</p>
						}
					>
						<For each={props.visible}>
							{(unit) => (
								<button
									type="button"
									onClick={() => props.onSelect(unit.id)}
									aria-pressed={props.selected?.id === unit.id}
									{...stylex.props(
										styles.resultRow,
										props.selected?.id === unit.id && styles.resultActive
									)}
								>
									<span {...stylex.props(styles.resultCopy)}>
										<strong>{sourceText(unit) || "Untitled text"}</strong>
										<small>
											{sourceKind(unit)} · {unit.occurrences.length}{" "}
											{unit.occurrences.length === 1
												? "occurrence"
												: "occurrences"}
										</small>
									</span>
									<span {...stylex.props(styles.resultIdentity)}>
										<code>
											{unit.identity.status !== "unresolved"
												? unit.identity.key
												: "Unresolved ID"}
										</code>
										<small>
											{unit.identity.status === "resolved"
												? unit.identity.namespace
												: unit.identity.status === "string_table"
													? unit.identity.tableId
													: unit.identity.reason.replaceAll("_", " ")}
										</small>
									</span>
									<span {...stylex.props(styles.chevron)}>›</span>
								</button>
							)}
						</For>
					</Show>
				</section>
				<FocusPanel corpus={props.corpus} unit={props.selected} />
			</div>
		</div>
	);
}

function FocusPanel(props: { readonly corpus: TextCorpus; readonly unit: TextUnit | undefined }) {
	return (
		<aside aria-label="Text focus" {...stylex.props(styles.focus)}>
			<Show
				when={props.unit}
				fallback={
					<p {...stylex.props(styles.focusEmpty)}>
						Select a result to see its identity and every place it appears.
					</p>
				}
			>
				{(unit) => {
					const diagnostics = () =>
						props.corpus.diagnostics.filter((diagnostic) =>
							unit().occurrences.some(
								(occurrence) => occurrence.packageFile === diagnostic.packageFile
							)
						);
					return (
						<>
							<blockquote {...stylex.props(styles.focusSource)}>
								“{sourceText(unit())}”
							</blockquote>
							<div {...stylex.props(styles.identityCard)}>
								<small>Unreal identity</small>
								<strong>{identityLabel(unit())}</strong>
								<code>{unit().id}</code>
							</div>
							<div {...stylex.props(styles.sectionHeading)}>
								<span>Occurrences</span>
								<b>{unit().occurrences.length}</b>
							</div>
							<div {...stylex.props(styles.occurrenceList)}>
								<For each={unit().occurrences}>
									{(occurrence) => <OccurrenceCard occurrence={occurrence} />}
								</For>
							</div>
							<Show when={diagnostics().length > 0}>
								<div {...stylex.props(styles.diagnosticBlock)}>
									<span>Notes</span>
									<For each={diagnostics()}>
										{(diagnostic) => (
											<p>
												{diagnostic.message}{" "}
												{diagnostic.propertyPath
													? `(${diagnostic.propertyPath})`
													: ""}
											</p>
										)}
									</For>
								</div>
							</Show>
						</>
					);
				}}
			</Show>
		</aside>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: `${tokens.space5} ${tokens.space6} ${tokens.space6}`,
		color: tokens.colorText,
		fontFamily: tokens.fontBody,
		backgroundColor: tokens.colorCanvas,
		backgroundImage: "none"
	},
	header: {
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: tokens.space6,
		paddingBottom: tokens.space4,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		marginBottom: tokens.space5
	},
	headerLead: { display: "flex", flexDirection: "column", gap: tokens.space1 },
	title: {
		margin: 0,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 22,
		fontWeight: 590,
		letterSpacing: "-0.02em"
	},
	subtitle: {
		maxWidth: 560,
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 14,
		lineHeight: 1.5
	},
	headerActions: { display: "flex", alignItems: "center", flexShrink: 0, gap: tokens.space2 },
	loadingLine: {
		minHeight: 320,
		display: "grid",
		placeItems: "center",
		margin: 0,
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	noticeCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		maxWidth: 520,
		padding: tokens.space4,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	noticeTitle: { color: tokens.colorTextStrong, fontSize: 14 },
	noticeCopy: { margin: 0, color: tokens.colorTextMuted, fontSize: 13, lineHeight: 1.5 },
	failureCard: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space2,
		maxWidth: 520,
		padding: tokens.space4,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	failureTitle: { color: tokens.colorTextStrong, fontSize: 14 },
	failureCopy: { margin: 0, color: tokens.colorTextMuted, fontSize: 13, lineHeight: 1.5 },
	technicalDetails: {
		width: "100%",
		color: tokens.colorTextFaint,
		fontSize: 11
	},
	techSummary: { cursor: "pointer", color: tokens.colorTextSubtle },
	techPre: {
		margin: `${tokens.space2} 0 0`,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		whiteSpace: "pre-wrap",
		wordBreak: "break-word"
	},
	workspace: { display: "flex", flexDirection: "column", gap: tokens.space3 },
	coverage: {
		display: "grid",
		gridTemplateColumns: "repeat(4, minmax(110px, .6fr)) auto",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		overflow: "hidden"
	},
	coverageLead: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 2,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderTopColor: tokens.colorSuccess,
		borderTopStyle: "solid",
		borderTopWidth: 3
	},
	coveragePartial: { borderTopColor: tokens.colorWarning },
	coverageMetric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		gap: 2,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1
	},
	coverageStatus: {
		display: "flex",
		alignItems: "center",
		padding: `${tokens.space3} ${tokens.space4}`,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1
	},
	coverageBadge: {
		padding: "1px 6px",
		borderRadius: tokens.radiusBadge,
		fontSize: 11
	},
	metricValue: {
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontMono,
		fontSize: 13,
		fontVariantNumeric: "tabular-nums"
	},
	complete: {
		color: tokens.colorSuccess,
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	partial: {
		color: tokens.colorWarning,
		backgroundColor: "rgba(242, 153, 74, 0.12)"
	},
	searchBar: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "center",
		gap: tokens.space2,
		padding: tokens.space2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset
	},
	searchInput: {
		flex: 1,
		minWidth: 220,
		padding: `${tokens.space2} ${tokens.space3}`,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextStrong,
		outlineColor: { default: "transparent", ":focus-visible": tokens.colorTextMuted },
		outlineOffset: 2,
		outlineStyle: "solid",
		outlineWidth: 1,
		fontFamily: tokens.fontBody,
		fontSize: 13,
		"::placeholder": { color: tokens.colorTextFaint },
		":focus-visible": { borderColor: tokens.colorAccent }
	},
	filterBar: {
		display: "flex",
		gap: 2,
		padding: 2,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	filterButton: {
		borderStyle: "none",
		borderWidth: 0,
		borderRadius: tokens.radiusBadge,
		backgroundColor: "transparent",
		color: tokens.colorTextMuted,
		padding: `${tokens.space1} ${tokens.space2}`,
		cursor: "pointer",
		fontFamily: tokens.fontBody,
		fontSize: 12,
		transition: `background-color ${tokens.motionFast} ease`
	},
	filterActive: {
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextStrong,
		fontWeight: 500
	},
	matchCount: {
		padding: `0 ${tokens.space3}`,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontVariantNumeric: "tabular-nums",
		fontSize: 11,
		whiteSpace: "nowrap"
	},
	contentGrid: {
		display: "grid",
		gridTemplateColumns: "minmax(520px, 1.45fr) minmax(330px, .72fr)",
		gap: tokens.space3,
		alignItems: "start"
	},
	results: {
		minWidth: 0,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		maxHeight: "calc(100vh - 320px)",
		minHeight: 470,
		overflow: "auto"
	},
	resultRow: {
		width: "100%",
		minHeight: 72,
		display: "grid",
		gridTemplateColumns: "minmax(220px, 1.2fr) minmax(190px, .8fr) 20px",
		alignItems: "center",
		borderStyle: "none",
		borderWidth: 0,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		borderRadius: 0,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		textAlign: "left",
		cursor: "pointer",
		fontFamily: tokens.fontBody
	},
	resultActive: { backgroundColor: "rgba(255, 255, 255, 0.07)" },
	resultCopy: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: `${tokens.space3} ${tokens.space4}`
	},
	resultIdentity: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: `${tokens.space3} ${tokens.space4}`,
		borderLeftColor: tokens.colorBorder,
		borderLeftStyle: "solid",
		borderLeftWidth: 1
	},
	chevron: { color: tokens.colorTextSubtle, fontSize: 20 },
	noMatches: {
		padding: tokens.space6,
		color: tokens.colorTextMuted,
		textAlign: "center",
		fontSize: 12
	},
	focus: {
		minHeight: 470,
		maxHeight: "calc(100vh - 320px)",
		overflow: "auto",
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		padding: tokens.space4
	},
	focusEmpty: { margin: 0, color: tokens.colorTextMuted, fontSize: 12, lineHeight: 1.6 },
	focusSource: {
		margin: `0 0 ${tokens.space3}`,
		padding: `0 0 ${tokens.space3} ${tokens.space3}`,
		borderLeftColor: tokens.colorAccent,
		borderLeftStyle: "solid",
		borderLeftWidth: 2,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 22,
		fontWeight: 590,
		lineHeight: 1.25,
		letterSpacing: "-0.01em"
	},
	identityCard: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space1,
		padding: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		overflow: "hidden"
	},
	sectionHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: tokens.space4,
		paddingBottom: tokens.space2,
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500
	},
	occurrenceList: {
		display: "flex",
		flexDirection: "column",
		gap: tokens.space2,
		marginTop: tokens.space2
	},
	occurrence: {
		padding: tokens.space3,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceRaised
	},
	occurrenceHeading: {
		display: "flex",
		justifyContent: "space-between",
		gap: tokens.space2,
		alignItems: "center",
		fontSize: 11
	},
	authority: {
		flexShrink: 0,
		padding: "1px 5px",
		borderRadius: tokens.radiusBadge,
		fontSize: 11
	},
	authorityEditable: {
		color: tokens.colorSuccess,
		backgroundColor: "rgba(76, 183, 130, 0.12)"
	},
	authorityReadOnly: {
		color: tokens.colorTextMuted,
		backgroundColor: "rgba(255, 255, 255, 0.05)"
	},
	objectPath: {
		margin: `${tokens.space2} 0 ${tokens.space1}`,
		color: tokens.colorTextMuted,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		wordBreak: "break-all"
	},
	packagePath: {
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		wordBreak: "break-all"
	},
	diagnosticBlock: {
		marginTop: tokens.space4,
		padding: tokens.space3,
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorWarning,
		fontSize: 11,
		lineHeight: 1.5
	}
});

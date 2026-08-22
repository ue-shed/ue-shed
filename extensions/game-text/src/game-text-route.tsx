import * as stylex from "@stylexjs/stylex";
import type {
	TextCorpus,
	TextCorpusRunResult,
	TextOccurrence,
	TextUnit
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
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
	if (kinds.size > 1) return "MULTI-SOURCE";
	const kind = kinds.values().next().value;
	if (kind === "string_table_entry") return "STRING TABLE";
	if (kind === "data_table_cell") return "DATA TABLE";
	return "ASSET TEXT";
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
						? "EDITABLE"
						: "READ ONLY"}
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
				<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
					Game text / Corpus
				</nav>
				<div {...stylex.props(styles.headerActions)}>
					<button type="button" onClick={run} {...stylex.props(styles.secondaryButton)}>
						Rescan
					</button>
				</div>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.emptyState)}>
						<span {...stylex.props(styles.scanMark)}>¶</span> Reading the saved language
						corpus…
					</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.emptyState)}>
						<strong>No project is configured.</strong>
						<span>
							Choose an Unreal project from the Workbench header, then rescan.
						</span>
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.emptyState)}>Project selection cancelled.</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>{current.error.message}</strong>
								<span>{current.error.recovery}</span>
							</div>
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
					<span>
						{props.corpus.status === "partial" ? "QUALIFIED CORPUS" : "COMPLETE CORPUS"}
					</span>
					<strong>{coverage.textUnits}</strong>
					<small>text units</small>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong>{coverage.textOccurrences}</strong>
					<span>occurrences</span>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong>
						{coverage.inspectedPackages}/{coverage.discoveredPackages}
					</strong>
					<span>packages read</span>
				</div>
				<div {...stylex.props(styles.coverageMetric)}>
					<strong>{coverage.unsupportedTextProperties}</strong>
					<span>visible blind spots</span>
				</div>
				<div {...stylex.props(styles.coverageNote)}>
					<span>Saved-package evidence</span>
					<strong>READ ONLY UNTIL AUTHORITY IS PROVEN</strong>
				</div>
			</section>
			<section {...stylex.props(styles.searchDesk)} aria-label="Search game text">
				<span {...stylex.props(styles.searchGlyph)}>⌕</span>
				<input
					autofocus
					type="search"
					value={props.query}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
					placeholder="Search source text, namespace, key, table, row, asset, or property…"
					aria-label="Search game text"
					{...stylex.props(styles.searchInput)}
				/>
				<span {...stylex.props(styles.matchCount)}>
					{props.visible.length} / {coverage.textUnits}
				</span>
			</section>
			<div {...stylex.props(styles.filterBar)}>
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
				<span {...stylex.props(styles.filterHint)}>SEARCH PRESERVES CORPUS CONTEXT</span>
			</div>
			<div {...stylex.props(styles.contentGrid)}>
				<section aria-label="Text units" {...stylex.props(styles.results)}>
					<div {...stylex.props(styles.columnHead)}>
						<span>Source text</span>
						<span>Identity / evidence</span>
					</div>
					<Show
						when={props.visible.length > 0}
						fallback={
							<div {...stylex.props(styles.noMatches)}>
								No text matches this search and authority filter.
							</div>
						}
					>
						<For each={props.visible}>
							{(unit, index) => (
								<button
									type="button"
									onClick={() => props.onSelect(unit.id)}
									aria-pressed={props.selected?.id === unit.id}
									{...stylex.props(
										styles.resultRow,
										props.selected?.id === unit.id && styles.resultActive
									)}
								>
									<span {...stylex.props(styles.resultNumber)}>
										{String(index() + 1).padStart(2, "0")}
									</span>
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
											{unit.identity.status === "resolved"
												? unit.identity.key
												: "UNRESOLVED"}
										</code>
										<small>
											{unit.identity.status === "resolved"
												? unit.identity.namespace
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
						Select a text unit to inspect its identity and occurrences.
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
							<p {...stylex.props(styles.focusKicker)}>
								TEXT FOCUS / {sourceKind(unit())}
							</p>
							<blockquote {...stylex.props(styles.focusSource)}>
								“{sourceText(unit())}”
							</blockquote>
							<div {...stylex.props(styles.identityCard)}>
								<span>UNREAL IDENTITY</span>
								<strong>{identityLabel(unit())}</strong>
								<code>{unit().id}</code>
							</div>
							<div {...stylex.props(styles.sectionHeading)}>
								<span>Occurrences</span>
								<strong>{unit().occurrences.length}</strong>
							</div>
							<div {...stylex.props(styles.occurrenceList)}>
								<For each={unit().occurrences}>
									{(occurrence) => <OccurrenceCard occurrence={occurrence} />}
								</For>
							</div>
							<Show when={diagnostics().length > 0}>
								<div {...stylex.props(styles.diagnostic)}>
									<span>∴ COVERAGE NOTE</span>
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
		padding: "30px 34px 44px",
		color: tokens.colorText,
		backgroundColor: tokens.colorCanvas,
		backgroundImage: "none",
		backgroundSize: "46px 46px, auto"
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 40,
		padding: "4px 2px 16px"
	},
	eyebrow: {
		margin: 0,
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11,
		letterSpacing: 0
	},
	headerActions: { display: "flex", gap: 8 },
	primaryButton: {
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText,
		padding: "10px 15px",
		cursor: "pointer",
		fontSize: 12,
		fontWeight: 590,
		letterSpacing: 0,
		textTransform: "none"
	},
	secondaryButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: tokens.colorSurface, ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "10px 15px",
		borderRadius: tokens.radiusControl,
		cursor: "pointer",
		fontSize: 12,
		letterSpacing: 0,
		textTransform: "none"
	},
	emptyState: {
		minHeight: 380,
		border: `1px solid ${tokens.colorBorder}`,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 13,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	scanMark: { fontFamily: tokens.fontDisplay, fontSize: 42, color: tokens.colorWarning },
	errorState: {
		minHeight: 300,
		border: `1px solid ${tokens.colorDanger}`,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		backgroundColor: "rgba(235, 87, 87, 0.06)",
		color: tokens.colorDanger
	},
	workspace: { display: "flex", flexDirection: "column" },
	coverage: {
		minHeight: 76,
		display: "grid",
		gridTemplateColumns: "190px repeat(3, minmax(110px, .55fr)) minmax(230px, 1.15fr)",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	coverageLead: {
		padding: "12px 15px",
		display: "grid",
		gridTemplateColumns: "1fr auto",
		alignItems: "end",
		borderTop: `3px solid ${tokens.colorSuccess}`
	},
	coveragePartial: { borderTopColor: tokens.colorWarning },
	coverageMetric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		padding: "12px 16px",
		borderLeft: `1px solid ${tokens.colorBorder}`,
		gap: 4
	},
	coverageNote: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		padding: "12px 16px",
		borderLeft: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		gap: 5
	},
	searchDesk: {
		minHeight: 68,
		display: "grid",
		gridTemplateColumns: "44px 1fr auto",
		alignItems: "center",
		marginTop: 10,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		boxShadow: tokens.shadowCard
	},
	searchGlyph: { color: tokens.colorTextSubtle, textAlign: "center", fontSize: 22 },
	searchInput: {
		width: "100%",
		height: 66,
		border: 0,
		backgroundColor: "transparent",
		color: tokens.colorTextStrong,
		outline: "none",
		fontFamily: tokens.fontBody,
		fontSize: 13,
		letterSpacing: 0,
		"::placeholder": { color: tokens.colorTextFaint }
	},
	matchCount: {
		padding: "0 18px",
		color: tokens.colorTextSubtle,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	filterBar: {
		minHeight: 40,
		display: "flex",
		alignItems: "center",
		border: `1px solid ${tokens.colorBorder}`,
		borderTop: 0,
		backgroundColor: tokens.colorSurface
	},
	filterButton: {
		alignSelf: "stretch",
		border: 0,
		borderRight: `1px solid ${tokens.colorBorder}`,
		padding: "0 15px",
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		cursor: "pointer",
		fontSize: 11,
		textTransform: "none",
		letterSpacing: 0
	},
	filterActive: {
		color: tokens.colorTextStrong,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		boxShadow: "inset 0 -2px rgba(228, 242, 34, 0.8)"
	},
	filterHint: {
		marginLeft: "auto",
		paddingRight: 14,
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	contentGrid: {
		display: "grid",
		gridTemplateColumns: "minmax(520px, 1.45fr) minmax(330px, .72fr)",
		gap: 10,
		marginTop: 10
	},
	results: {
		minWidth: 0,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		maxHeight: "calc(100vh - 348px)",
		minHeight: 470,
		overflow: "auto"
	},
	columnHead: {
		position: "sticky",
		top: 0,
		zIndex: 2,
		display: "grid",
		gridTemplateColumns: "1.1fr .8fr",
		padding: "11px 55px 10px 52px",
		backgroundColor: tokens.colorSurfaceRaised,
		color: tokens.colorTextSubtle,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		fontSize: 11,
		letterSpacing: 0,
		textTransform: "none"
	},
	resultRow: {
		width: "100%",
		minHeight: 86,
		display: "grid",
		gridTemplateColumns: "36px minmax(220px, 1.1fr) minmax(190px, .8fr) 20px",
		alignItems: "center",
		border: 0,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.03)" },
		color: tokens.colorText,
		textAlign: "left",
		cursor: "pointer"
	},
	resultActive: {
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		boxShadow: "inset 3px 0 rgba(228, 242, 34, 0.55)"
	},
	resultNumber: {
		textAlign: "center",
		color: tokens.colorTextFaint,
		fontFamily: tokens.fontMono,
		fontSize: 11
	},
	resultCopy: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 8,
		padding: "14px 12px"
	},
	resultIdentity: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 7,
		padding: "14px 12px",
		borderLeft: `1px solid ${tokens.colorBorder}`
	},
	chevron: { color: tokens.colorTextSubtle, fontSize: 20 },
	noMatches: { padding: 50, color: tokens.colorTextMuted, textAlign: "center", fontSize: 11 },
	focus: {
		minHeight: 470,
		maxHeight: "calc(100vh - 348px)",
		overflow: "auto",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface,
		padding: 20
	},
	focusEmpty: { color: tokens.colorTextMuted, fontSize: 11, lineHeight: 1.6 },
	focusKicker: { margin: 0, color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	focusSource: {
		margin: "19px 0",
		padding: "8px 0 18px 16px",
		borderLeft: `2px solid ${tokens.colorWarning}`,
		color: tokens.colorTextStrong,
		fontFamily: tokens.fontDisplay,
		fontSize: 24,
		lineHeight: 1.22
	},
	identityCard: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		padding: 14,
		backgroundColor: tokens.colorSurfaceInset,
		border: `1px solid ${tokens.colorBorder}`,
		overflow: "hidden"
	},
	sectionHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 22,
		paddingBottom: 9,
		borderBottom: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextMuted,
		fontSize: 11,
		textTransform: "none",
		letterSpacing: 0
	},
	occurrenceList: { display: "flex", flexDirection: "column", gap: 7, marginTop: 9 },
	occurrence: {
		padding: 12,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised
	},
	occurrenceHeading: {
		display: "flex",
		justifyContent: "space-between",
		gap: 10,
		alignItems: "center",
		fontSize: 11
	},
	authority: { flexShrink: 0, padding: "3px 5px", fontSize: 11, letterSpacing: 0 },
	authorityEditable: { color: tokens.colorSuccess, backgroundColor: "rgba(76, 183, 130, 0.12)" },
	authorityReadOnly: {
		color: tokens.colorTextMuted,
		backgroundColor: "rgba(255, 255, 255, 0.05)"
	},
	objectPath: {
		margin: "9px 0 5px",
		color: tokens.colorTextMuted,
		fontSize: 11,
		wordBreak: "break-all"
	},
	packagePath: { color: tokens.colorTextFaint, fontSize: 11, wordBreak: "break-all" },
	diagnostic: {
		marginTop: 16,
		padding: 12,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorWarning,
		fontSize: 11,
		lineHeight: 1.5
	}
});

import * as stylex from "@stylexjs/stylex";
import type {
	TextCorpus,
	TextCorpusRunResult,
	TextOccurrence,
	TextUnit
} from "@ue-shed/game-text/browser";
import { For, Match, Show, Switch, createMemo, createSignal, onMount } from "solid-js";
import {
	filterTextUnits,
	identityLabel,
	occurrenceContext,
	sourceText,
	type CapabilityFilter
} from "./game-text-view.js";

export interface GameTextClient {
	readonly loadConfiguredProject: () => Promise<TextCorpusRunResult>;
	readonly chooseProjectAndScan: () => Promise<TextCorpusRunResult>;
}

type ViewState =
	| { readonly status: "loading" }
	| { readonly status: "not_configured" }
	| { readonly status: "cancelled" }
	| {
			readonly status: "failed";
			readonly error: Extract<TextCorpusRunResult, { status: "failed" }>["error"];
	  }
	| { readonly status: "ready"; readonly corpus: TextCorpus };

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

export function GameTextRoute(props: { readonly client: GameTextClient }) {
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
	const run = async (choose: boolean) => {
		setState({ status: "loading" });
		applyResult(
			await (choose
				? props.client.chooseProjectAndScan()
				: props.client.loadConfiguredProject())
		);
	};
	onMount(() => void run(false));

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<div>
					<p {...stylex.props(styles.eyebrow)}>GAME TEXT / CORPUS DESK</p>
					<h1 {...stylex.props(styles.title)}>Find the words in the game.</h1>
					<p {...stylex.props(styles.subtitle)}>
						Search language first. Storage, identity, and authority stay close enough to
						explain every result.
					</p>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<button
						type="button"
						onClick={() => void run(true)}
						{...stylex.props(styles.primaryButton)}
					>
						Choose project
					</button>
					<button
						type="button"
						onClick={() => void run(false)}
						{...stylex.props(styles.secondaryButton)}
					>
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
						<span>Choose an Unreal project to scan without launching the editor.</span>
						<button
							type="button"
							onClick={() => void run(true)}
							{...stylex.props(styles.primaryButton)}
						>
							Choose project
						</button>
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
			<section aria-label="Corpus coverage" {...stylex.props(styles.coverage)}>
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
					aria-label="Search corpus"
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
		color: "#ede9df",
		backgroundColor: "#11100f",
		backgroundImage:
			"linear-gradient(90deg, #ffffff06 1px, transparent 1px), radial-gradient(circle at 78% -10%, #e65f3b18, transparent 34%)",
		backgroundSize: "46px 46px, auto"
	},
	header: {
		display: "flex",
		alignItems: "end",
		justifyContent: "space-between",
		gap: 40,
		padding: "4px 2px 26px"
	},
	eyebrow: {
		margin: "0 0 10px",
		color: "#e87655",
		fontFamily: "Cascadia Mono, Consolas, monospace",
		fontSize: 9,
		letterSpacing: ".18em"
	},
	title: {
		margin: 0,
		fontFamily: "Palatino Linotype, Book Antiqua, serif",
		fontSize: 48,
		lineHeight: 1,
		fontWeight: 400,
		letterSpacing: "-.035em"
	},
	subtitle: {
		maxWidth: 720,
		margin: "12px 0 0",
		color: "#99938a",
		fontSize: 11,
		lineHeight: 1.6
	},
	headerActions: { display: "flex", gap: 8 },
	primaryButton: {
		border: "1px solid #e76b49",
		backgroundColor: { default: "#e76b49", ":hover": "#f47d5d" },
		color: "#1b0e09",
		padding: "10px 15px",
		cursor: "pointer",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	secondaryButton: {
		border: "1px solid #4a4540",
		backgroundColor: { default: "#191715", ":hover": "#28231f" },
		color: "#c8c1b6",
		padding: "10px 15px",
		cursor: "pointer",
		fontSize: 9,
		letterSpacing: ".1em",
		textTransform: "uppercase"
	},
	emptyState: {
		minHeight: 380,
		border: "1px solid #39342f",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 13,
		backgroundColor: "#171513",
		color: "#9c958b",
		fontSize: 11
	},
	scanMark: { fontFamily: "Palatino Linotype, serif", fontSize: 42, color: "#e76b49" },
	errorState: {
		minHeight: 300,
		border: "1px solid #7b4132",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		backgroundColor: "#211512",
		color: "#e39b86"
	},
	workspace: { display: "flex", flexDirection: "column" },
	coverage: {
		minHeight: 76,
		display: "grid",
		gridTemplateColumns: "190px repeat(3, minmax(110px, .55fr)) minmax(230px, 1.15fr)",
		border: "1px solid #3b3631",
		backgroundColor: "#171513"
	},
	coverageLead: {
		padding: "12px 15px",
		display: "grid",
		gridTemplateColumns: "1fr auto",
		alignItems: "end",
		borderTop: "3px solid #728e69"
	},
	coveragePartial: { borderTopColor: "#e76b49" },
	coverageMetric: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		padding: "12px 16px",
		borderLeft: "1px solid #332f2b",
		gap: 4
	},
	coverageNote: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		padding: "12px 16px",
		borderLeft: "1px solid #332f2b",
		color: "#756f67",
		fontSize: 8,
		gap: 5
	},
	searchDesk: {
		minHeight: 68,
		display: "grid",
		gridTemplateColumns: "44px 1fr auto",
		alignItems: "center",
		marginTop: 10,
		border: "1px solid #4c4540",
		backgroundColor: "#0d0c0b",
		boxShadow: "0 12px 35px #00000025"
	},
	searchGlyph: { color: "#e76b49", textAlign: "center", fontSize: 22 },
	searchInput: {
		width: "100%",
		height: 66,
		border: 0,
		backgroundColor: "transparent",
		color: "#f0ece3",
		outline: "none",
		fontFamily: "Palatino Linotype, serif",
		fontSize: 19,
		letterSpacing: ".005em",
		"::placeholder": { color: "#5d5852" }
	},
	matchCount: {
		padding: "0 18px",
		color: "#817a72",
		fontFamily: "Cascadia Mono, monospace",
		fontSize: 9
	},
	filterBar: {
		minHeight: 40,
		display: "flex",
		alignItems: "center",
		border: "1px solid #322e2a",
		borderTop: 0,
		backgroundColor: "#151311"
	},
	filterButton: {
		alignSelf: "stretch",
		border: 0,
		borderRight: "1px solid #322e2a",
		padding: "0 15px",
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: "#7f786f",
		cursor: "pointer",
		fontSize: 9,
		textTransform: "uppercase",
		letterSpacing: ".08em"
	},
	filterActive: {
		color: "#f0e9df",
		backgroundColor: "#28211d",
		boxShadow: "inset 0 -2px #e76b49"
	},
	filterHint: {
		marginLeft: "auto",
		paddingRight: 14,
		color: "#514c47",
		fontFamily: "Cascadia Mono, monospace",
		fontSize: 8
	},
	contentGrid: {
		display: "grid",
		gridTemplateColumns: "minmax(520px, 1.45fr) minmax(330px, .72fr)",
		gap: 10,
		marginTop: 10
	},
	results: {
		minWidth: 0,
		border: "1px solid #39342f",
		backgroundColor: "#151311",
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
		backgroundColor: "#201d1a",
		color: "#746e66",
		borderBottom: "1px solid #403a35",
		fontSize: 8,
		letterSpacing: ".12em",
		textTransform: "uppercase"
	},
	resultRow: {
		width: "100%",
		minHeight: 86,
		display: "grid",
		gridTemplateColumns: "36px minmax(220px, 1.1fr) minmax(190px, .8fr) 20px",
		alignItems: "center",
		border: 0,
		borderBottom: "1px solid #2e2a27",
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: "#d9d3c9",
		textAlign: "left",
		cursor: "pointer"
	},
	resultActive: { backgroundColor: "#2b221e", boxShadow: "inset 3px 0 #e76b49" },
	resultNumber: {
		textAlign: "center",
		color: "#514c46",
		fontFamily: "Cascadia Mono, monospace",
		fontSize: 8
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
		borderLeft: "1px solid #2d2926"
	},
	chevron: { color: "#6d655f", fontSize: 20 },
	noMatches: { padding: 50, color: "#777069", textAlign: "center", fontSize: 10 },
	focus: {
		minHeight: 470,
		maxHeight: "calc(100vh - 348px)",
		overflow: "auto",
		border: "1px solid #39342f",
		backgroundColor: "#191614",
		padding: 20
	},
	focusEmpty: { color: "#756e67", fontSize: 10, lineHeight: 1.6 },
	focusKicker: { margin: 0, color: "#e76b49", fontSize: 8, letterSpacing: ".15em" },
	focusSource: {
		margin: "19px 0",
		padding: "8px 0 18px 16px",
		borderLeft: "2px solid #e76b49",
		color: "#f0e9df",
		fontFamily: "Palatino Linotype, serif",
		fontSize: 28,
		lineHeight: 1.22
	},
	identityCard: {
		display: "flex",
		flexDirection: "column",
		gap: 7,
		padding: 14,
		backgroundColor: "#0f0e0d",
		border: "1px solid #332f2b",
		overflow: "hidden"
	},
	sectionHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginTop: 22,
		paddingBottom: 9,
		borderBottom: "1px solid #39342f",
		color: "#8a8279",
		fontSize: 9,
		textTransform: "uppercase",
		letterSpacing: ".1em"
	},
	occurrenceList: { display: "flex", flexDirection: "column", gap: 7, marginTop: 9 },
	occurrence: { padding: 12, border: "1px solid #302c28", backgroundColor: "#13110f" },
	occurrenceHeading: {
		display: "flex",
		justifyContent: "space-between",
		gap: 10,
		alignItems: "center",
		fontSize: 9
	},
	authority: { flexShrink: 0, padding: "3px 5px", fontSize: 7, letterSpacing: ".09em" },
	authorityEditable: { color: "#9fbd90", backgroundColor: "#293226" },
	authorityReadOnly: { color: "#cda07d", backgroundColor: "#35261e" },
	objectPath: { margin: "9px 0 5px", color: "#8b847c", fontSize: 8, wordBreak: "break-all" },
	packagePath: { color: "#56514c", fontSize: 7, wordBreak: "break-all" },
	diagnostic: {
		marginTop: 16,
		padding: 12,
		border: "1px solid #6b4032",
		backgroundColor: "#251713",
		color: "#c88d79",
		fontSize: 8,
		lineHeight: 1.5
	}
});

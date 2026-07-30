import * as stylex from "@stylexjs/stylex";
import type {
	TextCorpusFocus,
	TextCorpusQueryRunResult,
	TextCorpusQuerySummary,
	TextCorpusSearchPage,
	TextUnitSearchResult
} from "@ue-shed/game-text/browser";
import { createEffectAction } from "@ue-shed/ui";
import { For, Match, Show, Switch, createSignal, onMount, type Accessor } from "solid-js";
import type { GameTextClientShape } from "./game-text-client.js";
import {
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
			readonly error: Extract<TextCorpusQueryRunResult, { status: "failed" }>["error"];
	  }
	| { readonly status: "ready" };

const filters: readonly { readonly value: CapabilityFilter; readonly label: string }[] = [
	{ value: "all", label: "All text" },
	{ value: "source_editable", label: "Source editable" },
	{ value: "read_only", label: "Read only" }
];

function sourceKind(unit: TextUnitSearchResult): string {
	if (unit.locationKinds.length > 1) return "MULTI-SOURCE";
	const kind = unit.locationKinds[0];
	if (kind === "string_table_entry") return "STRING TABLE";
	if (kind === "data_table_cell") return "DATA TABLE";
	return "ASSET TEXT";
}

function failure(cause: unknown): Extract<ViewState, { status: "failed" }> {
	return {
		error: {
			code: "contract_failure",
			message: String(cause),
			recovery: "Restart Workbench. If the problem persists, verify package versions.",
			retrySafe: true
		},
		status: "failed"
	};
}

function OccurrenceCard(props: { readonly occurrence: TextCorpusFocus["occurrences"][number] }) {
	return (
		<article {...stylex.props(styles.occurrence)}>
			<strong>{occurrenceContext(props.occurrence)}</strong>
			<span>
				{props.occurrence.editCapability === "source_editable" ? "EDITABLE" : "READ ONLY"}
			</span>
			<code>{props.occurrence.location.objectPath}</code>
		</article>
	);
}

/** Bounded query presentation; the renderer never receives the whole corpus. */
export function GameTextRoute(props: { readonly client: GameTextClientShape }) {
	const refreshAction = createEffectAction();
	const searchAction = createEffectAction();
	const focusAction = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [summary, setSummary] = createSignal<TextCorpusQuerySummary>();
	const [page, setPage] = createSignal<TextCorpusSearchPage>({ total: 0, units: [] });
	const [query, setQuery] = createSignal("");
	const [capability, setCapability] = createSignal<CapabilityFilter>("all");
	const [selectedId, setSelectedId] = createSignal<TextUnitSearchResult["id"]>();
	const [focus, setFocus] = createSignal<TextCorpusFocus>();
	let searchGeneration = 0;
	let focusGeneration = 0;

	const requestFocus = (id: TextUnitSearchResult["id"]) => {
		const generation = ++focusGeneration;
		focusAction.run(props.client.focus({ id, pageSize: 50 }), {
			onFailure: (cause) => {
				if (generation === focusGeneration) setState(failure(cause));
			},
			onSuccess: (result) => {
				if (generation !== focusGeneration) return;
				if (result.status === "found") setFocus(result.focus);
				else setFocus(undefined);
			}
		});
	};

	const requestPage = (
		options: {
			readonly capability?: CapabilityFilter;
			readonly cursor?: TextUnitSearchResult["id"];
			readonly query?: string;
		} = {}
	) => {
		const generation = ++searchGeneration;
		searchAction.run(
			props.client.search({
				capability: options.capability ?? capability(),
				...(options.cursor === undefined ? {} : { cursor: options.cursor }),
				pageSize: 50,
				query: options.query ?? query()
			}),
			{
				onFailure: (cause) => {
					if (generation === searchGeneration) setState(failure(cause));
				},
				onSuccess: (result) => {
					if (generation !== searchGeneration || result.status !== "ready") return;
					if (state().status !== "ready") return;
					setPage(result.page);
					const next =
						result.page.units.find((unit) => unit.id === selectedId()) ??
						result.page.units[0];
					setSelectedId(next?.id);
					if (next) requestFocus(next.id);
					else {
						focusGeneration += 1;
						setFocus(undefined);
					}
				}
			}
		);
	};

	const applyRefresh = (result: TextCorpusQueryRunResult) => {
		if (result.status === "completed") {
			setSummary(result.summary);
			setPage({ total: 0, units: [] });
			setSelectedId(undefined);
			focusGeneration += 1;
			setFocus(undefined);
			setState({ status: "ready" });
			requestPage();
		} else if (result.status === "failed") {
			setState({ error: result.error, status: "failed" });
		} else setState({ status: result.status });
	};

	const refresh = () => {
		setState({ status: "loading" });
		refreshAction.run(props.client.loadConfiguredProject(), {
			onFailure: (cause) => setState(failure(cause)),
			onSuccess: applyRefresh
		});
	};

	onMount(refresh);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<nav aria-label="Breadcrumb">Game text / Corpus</nav>
				<button type="button" onClick={refresh} {...stylex.props(styles.button)}>
					Rescan
				</button>
			</header>
			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.empty)}>Reading the saved language corpus…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.empty)}>
						Choose an Unreal project from the Workbench header.
					</div>
				</Match>
				<Match when={state().status === "cancelled"}>
					<div {...stylex.props(styles.empty)}>Project selection cancelled.</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						return current.status === "failed" ? (
							<div {...stylex.props(styles.error)}>
								<strong>{current.error.message}</strong>
								<span>{current.error.recovery}</span>
							</div>
						) : null;
					})()}
				</Match>
				<Match when={state().status === "ready"}>
					<Show when={summary()}>
						{(currentSummary) => (
							<TextCorpusWorkspace
								summary={currentSummary()}
								page={page}
								query={query}
								capability={capability}
								selectedId={selectedId}
								focus={focus}
								onQuery={(value) => {
									setQuery(value);
									requestPage({ query: value });
								}}
								onCapability={(value) => {
									setCapability(value);
									requestPage({ capability: value });
								}}
								onNextPage={(cursor) => requestPage({ cursor })}
								onSelect={(id) => {
									setSelectedId(id);
									requestFocus(id);
								}}
							/>
						)}
					</Show>
				</Match>
			</Switch>
		</main>
	);
}

function TextCorpusWorkspace(props: {
	readonly summary: TextCorpusQuerySummary;
	readonly page: Accessor<TextCorpusSearchPage>;
	readonly query: Accessor<string>;
	readonly capability: Accessor<CapabilityFilter>;
	readonly selectedId: Accessor<TextUnitSearchResult["id"] | undefined>;
	readonly focus: Accessor<TextCorpusFocus | undefined>;
	readonly onQuery: (value: string) => void;
	readonly onCapability: (value: CapabilityFilter) => void;
	readonly onNextPage: (cursor: TextUnitSearchResult["id"]) => void;
	readonly onSelect: (id: TextUnitSearchResult["id"]) => void;
}) {
	const coverage = props.summary.coverage;
	return (
		<div {...stylex.props(styles.workspace)}>
			<section aria-label="Corpus coverage" {...stylex.props(styles.coverage)}>
				<strong>
					{props.summary.status === "partial" ? "QUALIFIED CORPUS" : "COMPLETE CORPUS"}
				</strong>
				<span>{coverage.textUnits} indexed text units</span>
				<span>{coverage.textOccurrences} occurrences</span>
				<span>
					{coverage.inspectedPackages}/{coverage.discoveredPackages} packages read
				</span>
				<span>{coverage.unsupportedTextProperties} visible blind spots</span>
			</section>
			<section aria-label="Search game text" {...stylex.props(styles.tools)}>
				<input
					autofocus
					type="search"
					value={props.query()}
					onInput={(event) => props.onQuery(event.currentTarget.value)}
					placeholder="Search source text…"
					aria-label="Search corpus"
					{...stylex.props(styles.searchInput)}
				/>
				<span {...stylex.props(styles.matchCount)}>{props.page().total} matches</span>
				<For each={filters}>
					{(filter) => (
						<button
							type="button"
							aria-pressed={props.capability() === filter.value}
							onClick={() => props.onCapability(filter.value)}
							{...stylex.props(
								styles.filterButton,
								props.capability() === filter.value && styles.filterActive
							)}
						>
							{filter.label}
						</button>
					)}
				</For>
			</section>
			<div {...stylex.props(styles.grid)}>
				<section aria-label="Text units" {...stylex.props(styles.results)}>
					<Show
						when={props.page().units.length > 0}
						fallback={
							<p {...stylex.props(styles.noMatches)}>
								No text matches this search and authority filter.
							</p>
						}
					>
						<For each={props.page().units}>
							{(unit) => (
								<button
									type="button"
									aria-pressed={props.selectedId() === unit.id}
									onClick={() => props.onSelect(unit.id)}
									{...stylex.props(
										styles.resultRow,
										props.selectedId() === unit.id && styles.resultActive
									)}
								>
									<strong>{sourceText(unit)}</strong>
									<small>
										{sourceKind(unit)} · {unit.occurrenceCount} occurrences ·{" "}
										{identityLabel(unit)}
									</small>
								</button>
							)}
						</For>
					</Show>
					<Show when={props.page().nextCursor}>
						{(cursor) => (
							<button
								type="button"
								onClick={() => props.onNextPage(cursor())}
								{...stylex.props(styles.nextPage)}
							>
								Next page
							</button>
						)}
					</Show>
				</section>
				<FocusPanel focus={props.focus()} />
			</div>
		</div>
	);
}

function FocusPanel(props: { readonly focus: TextCorpusFocus | undefined }) {
	return (
		<aside aria-label="Text focus" {...stylex.props(styles.focus)}>
			<Show
				when={props.focus}
				fallback={<p>Select a text unit to inspect its identity and occurrences.</p>}
			>
				{(result) => (
					<>
						<blockquote>“{sourceText(result().unit)}”</blockquote>
						<strong>{identityLabel(result().unit)}</strong>
						<div>Occurrences: {result().totalOccurrences}</div>
						<For each={result().occurrences}>
							{(occurrence) => <OccurrenceCard occurrence={occurrence} />}
						</For>
						<Show when={result().diagnostics.length > 0}>
							<p>
								{result().diagnostics.length} coverage notes for this focused text.
							</p>
						</Show>
					</>
				)}
			</Show>
		</aside>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		padding: "30px 34px",
		color: "#ede9df",
		backgroundColor: "#11100f"
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 16,
		color: "#e87655",
		fontSize: 10,
		letterSpacing: ".15em"
	},
	button: {
		border: "1px solid #4a4540",
		backgroundColor: "#191715",
		color: "#c8c1b6",
		padding: "9px 14px",
		cursor: "pointer"
	},
	empty: {
		minHeight: 380,
		display: "grid",
		placeItems: "center",
		border: "1px solid #39342f",
		color: "#9c958b"
	},
	error: {
		minHeight: 300,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 10,
		border: "1px solid #7b4132",
		color: "#e39b86"
	},
	workspace: { display: "flex", flexDirection: "column", gap: 10 },
	coverage: {
		display: "flex",
		gap: 22,
		flexWrap: "wrap",
		padding: 14,
		border: "1px solid #3b3631",
		backgroundColor: "#171513",
		fontSize: 10
	},
	tools: {
		display: "flex",
		gap: 8,
		alignItems: "center",
		padding: 10,
		border: "1px solid #4c4540",
		backgroundColor: "#0d0c0b"
	},
	searchInput: {
		minWidth: 0,
		flex: 1,
		border: "1px solid #4a4540",
		backgroundColor: "#151311",
		color: "#f0ece3",
		padding: "9px 11px",
		outline: "none",
		fontFamily: "Cascadia Mono, Consolas, monospace",
		fontSize: 12,
		"::placeholder": { color: "#716b64" }
	},
	matchCount: {
		flexShrink: 0,
		color: "#9c958b",
		fontFamily: "Cascadia Mono, Consolas, monospace",
		fontSize: 10
	},
	filterButton: {
		border: "1px solid #4a4540",
		backgroundColor: { default: "#191715", ":hover": "#28231f" },
		color: "#c8c1b6",
		padding: "9px 10px",
		cursor: "pointer",
		fontSize: 9,
		letterSpacing: ".06em"
	},
	filterActive: { borderColor: "#e87655", color: "#f0ece3", backgroundColor: "#30201b" },
	grid: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 10 },
	results: {
		display: "flex",
		flexDirection: "column",
		border: "1px solid #39342f",
		backgroundColor: "#151311",
		maxHeight: "calc(100vh - 320px)",
		overflow: "auto"
	},
	resultRow: {
		width: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: 6,
		border: 0,
		borderBottom: "1px solid #302c28",
		backgroundColor: { default: "transparent", ":hover": "#211d1a" },
		color: "#e6e0d6",
		padding: "13px 16px",
		textAlign: "left",
		cursor: "pointer"
	},
	resultActive: { backgroundColor: "#2b221e", boxShadow: "inset 3px 0 #e87655" },
	noMatches: { padding: 40, color: "#8f877d", textAlign: "center", fontSize: 11 },
	nextPage: {
		border: 0,
		backgroundColor: { default: "#211d1a", ":hover": "#302a25" },
		color: "#c8c1b6",
		padding: 12,
		cursor: "pointer",
		fontSize: 10,
		letterSpacing: ".08em"
	},
	focus: {
		border: "1px solid #39342f",
		backgroundColor: "#191614",
		padding: 18,
		overflow: "auto",
		maxHeight: "calc(100vh - 320px)"
	},
	occurrence: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		padding: 10,
		marginTop: 8,
		border: "1px solid #332f2b",
		fontSize: 10
	}
});

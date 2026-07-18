import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount
} from "solid-js";
import type {
	MapReviewClientShape,
	MapReviewResult,
	MapReviewRunView
} from "./map-review-client.js";
import { MapReviewAuthoring } from "./map-review-authoring.js";
import { WorldScout } from "./world-scout.js";
import type { ObservedActor } from "@ue-shed/observatory";

type ViewState =
	| { readonly status: "loading" }
	| {
			readonly status: "capturing";
			readonly previous?: Extract<MapReviewResult, { status: "ready" }>;
	  }
	| MapReviewResult;

function PreviewImage(props: { readonly run: MapReviewRunView }) {
	const [source, setSource] = createSignal<string>();
	createEffect(() => {
		const preview = props.run.preview;
		if (!preview) {
			setSource(undefined);
			return;
		}
		const bytes = Uint8Array.from(preview.bytes);
		const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" }));
		setSource(url);
		onCleanup(() => URL.revokeObjectURL(url));
	});
	return (
		<Show
			when={source()}
			fallback={
				<div {...stylex.props(styles.missingPreview)}>
					<span>NO VALID FRAME</span>
					<small>{props.run.failedViews} failed view</small>
				</div>
			}
		>
			{(url) => (
				<img
					src={url()}
					alt={`${props.run.preview?.viewName ?? "Review view"} from run ${props.run.id}`}
					{...stylex.props(styles.previewImage)}
				/>
			)}
		</Show>
	);
}

export function MapReviewRoute(props: { readonly client: MapReviewClientShape }) {
	const action = createEffectAction();
	const [state, setState] = createSignal<ViewState>({ status: "loading" });
	const [selectedRunId, setSelectedRunId] = createSignal<string>();
	const [focusedActor, setFocusedActor] = createSignal<ObservedActor>();
	const [focusGeneration, setFocusGeneration] = createSignal(0);
	const ready = createMemo(() => {
		const current = state();
		if (current.status === "ready") return current;
		if (current.status === "capturing") return current.previous;
		return undefined;
	});
	const selected = createMemo(() => {
		const current = ready();
		return current?.runs.find((run) => run.id === selectedRunId()) ?? current?.runs[0];
	});
	const apply = (result: MapReviewResult) => {
		setState(result);
		if (result.status === "ready") setSelectedRunId(result.runs[0]?.id);
	};
	const clientFailure = (cause: Cause.Cause<unknown>): MapReviewResult => ({
		error: {
			message: Cause.pretty(cause),
			recovery: "Restart Workbench. If the problem persists, verify package versions."
		},
		status: "failed"
	});
	const load = () =>
		action.run(props.client.load(), {
			onFailure: (cause) => apply(clientFailure(cause)),
			onSuccess: apply
		});
	const capture = () => {
		const previous = ready();
		setState(previous ? { status: "capturing", previous } : { status: "capturing" });
		action.run(props.client.capture(), {
			onFailure: (cause) => apply(clientFailure(cause)),
			onSuccess: apply
		});
	};
	onMount(load);

	return (
		<main {...stylex.props(styles.page)}>
			<header {...stylex.props(styles.header)}>
				<nav aria-label="Breadcrumb" {...stylex.props(styles.eyebrow)}>
					Map review / Live world
				</nav>
				<button
					type="button"
					disabled={state().status === "capturing"}
					onClick={capture}
					{...stylex.props(styles.captureButton)}
				>
					{state().status === "capturing" ? "CAPTURING…" : "CAPTURE SET"}
				</button>
			</header>
			<WorldScout
				client={props.client}
				onActorFocused={(actor) => {
					setFocusedActor(actor);
					setFocusGeneration((current) => current + 1);
				}}
			/>

			<Switch>
				<Match when={state().status === "loading"}>
					<div {...stylex.props(styles.centerState)}>Opening local review history…</div>
				</Match>
				<Match when={state().status === "not_configured"}>
					<div {...stylex.props(styles.centerState)}>
						<strong>No review project is configured.</strong>
						<span>
							Set UE_SHED_PROJECT_ROOT to a project with a portable Review Set.
						</span>
					</div>
				</Match>
				<Match when={state().status === "failed"}>
					{(() => {
						const current = state();
						if (current.status !== "failed") return null;
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>{current.error.message}</strong>
								<span>{current.error.recovery}</span>
								<button type="button" onClick={() => void load()}>
									Retry
								</button>
							</div>
						);
					})()}
				</Match>
				<Match when={state().status === "blocked"}>
					{(() => {
						const current = state();
						if (current.status !== "blocked") return null;
						return (
							<div {...stylex.props(styles.errorState)}>
								<strong>{current.policy.message}</strong>
								<span>{current.policy.recovery}</span>
								<button type="button" onClick={() => void load()}>
									Return to review
								</button>
							</div>
						);
					})()}
				</Match>
				<Match when={ready()}>
					{(current) => (
						<div {...stylex.props(styles.workspace)}>
							<section
								aria-label="Review set status"
								{...stylex.props(styles.statusStrip)}
							>
								<div {...stylex.props(styles.setIdentity)}>
									<span>REVIEW SET</span>
									<strong>{current().reviewSet.displayName}</strong>
								</div>
								<div>
									<strong>{current().reviewSet.viewCount}</strong>
									<span>approved view</span>
								</div>
								<div>
									<strong>{current().runs.length}</strong>
									<span>durable runs</span>
								</div>
								<code>{current().reviewSet.mapPath}</code>
							</section>
							<MapReviewAuthoring
								client={props.client}
								focusedActor={focusedActor()}
								focusGeneration={focusGeneration()}
								onApproved={load}
							/>

							<Show
								when={selected()}
								fallback={
									<section {...stylex.props(styles.firstCapture)}>
										<span {...stylex.props(styles.aperture)}>◉</span>
										<h2>No visual history yet.</h2>
										<p>
											Capture the set to establish its first immutable
											observation.
										</p>
									</section>
								}
							>
								{(run) => (
									<section
										aria-label="Selected capture"
										{...stylex.props(styles.stage)}
									>
										<div {...stylex.props(styles.imageFrame)}>
											<PreviewImage run={run()} />
											<div {...stylex.props(styles.imageChrome)}>
												<span>PURE / ORDINARY WORLD</span>
												<code>{run().id}</code>
											</div>
										</div>
										<aside {...stylex.props(styles.runInspector)}>
											<p>CAPTURE RUN</p>
											<h2>{new Date(run().completedAt).toLocaleString()}</h2>
											<dl>
												<div>
													<dt>Result</dt>
													<dd>{run().status.replaceAll("_", " ")}</dd>
												</div>
												<div>
													<dt>Captured</dt>
													<dd>{run().successfulViews}</dd>
												</div>
												<div>
													<dt>Failed</dt>
													<dd>{run().failedViews}</dd>
												</div>
												<Show when={run().preview}>
													{(preview) => (
														<div>
															<dt>Frame</dt>
															<dd>
																{preview().width} ×{" "}
																{preview().height}
															</dd>
														</div>
													)}
												</Show>
											</dl>
										</aside>
									</section>
								)}
							</Show>

							<section aria-label="Capture history" {...stylex.props(styles.history)}>
								<div {...stylex.props(styles.historyHeading)}>
									<span>VISUAL HISTORY</span>
									<small>NEWEST FIRST</small>
								</div>
								<div {...stylex.props(styles.runRail)}>
									<For each={current().runs}>
										{(run, index) => (
											<button
												type="button"
												aria-pressed={selected()?.id === run.id}
												onClick={() => setSelectedRunId(run.id)}
												{...stylex.props(
													styles.runCard,
													selected()?.id === run.id &&
														styles.runCardActive
												)}
											>
												<span>
													{String(
														current().runs.length - index()
													).padStart(2, "0")}
												</span>
												<strong>
													{new Date(run.completedAt).toLocaleTimeString()}
												</strong>
												<small>{run.status.replaceAll("_", " ")}</small>
											</button>
										)}
									</For>
								</div>
							</section>
						</div>
					)}
				</Match>
			</Switch>
		</main>
	);
}

const styles = stylex.create({
	page: {
		minHeight: "calc(100vh - 52px)",
		width: "100%",
		boxSizing: "border-box",
		overflowX: "hidden",
		padding: "30px 34px 44px",
		backgroundColor: "#0d0f0e",
		backgroundImage:
			"linear-gradient(#ffffff06 1px, transparent 1px), linear-gradient(90deg, #ffffff06 1px, transparent 1px), radial-gradient(circle at 78% -10%, #b9f22712, transparent 38%)",
		backgroundSize: "32px 32px, 32px 32px, auto",
		color: tokens.colorText
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		paddingBottom: 16,
		borderBottom: "1px solid #343936"
	},
	eyebrow: { margin: 0, color: "#b9f227", fontSize: 9, letterSpacing: ".19em" },
	captureButton: {
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d0ff4f", ":disabled": "#5d6d35" },
		color: "#10130c",
		padding: "11px 16px",
		fontWeight: 800,
		fontSize: 9,
		letterSpacing: ".12em",
		cursor: { default: "pointer", ":disabled": "wait" },
		transition: "transform 140ms cubic-bezier(.23,1,.32,1)",
		transform: { default: "scale(1)", ":active": "scale(.97)" }
	},
	centerState: {
		minHeight: 430,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 10,
		color: "#879089"
	},
	errorState: {
		minHeight: 360,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 12,
		color: "#e9967b"
	},
	workspace: { paddingTop: 14 },
	statusStrip: {
		display: "grid",
		gridTemplateColumns: "1.3fr .45fr .45fr 1.4fr",
		minHeight: 70,
		border: "1px solid #333936",
		backgroundColor: "#121513"
	},
	setIdentity: { borderTop: "3px solid #b9f227" },
	stage: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: 12, marginTop: 12 },
	imageFrame: {
		minHeight: 430,
		position: "relative",
		border: "1px solid #3b423e",
		backgroundColor: "#060706",
		overflow: "hidden"
	},
	previewImage: {
		width: "100%",
		height: "100%",
		maxHeight: "65vh",
		objectFit: "contain",
		display: "block"
	},
	missingPreview: {
		minHeight: 430,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 9,
		color: "#8b665a",
		backgroundImage:
			"repeating-linear-gradient(-45deg, transparent, transparent 9px, #ffffff06 9px, #ffffff06 10px)"
	},
	imageChrome: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: 0,
		display: "flex",
		justifyContent: "space-between",
		padding: "12px 14px",
		backgroundImage: "linear-gradient(transparent, #050605e8)",
		color: "#b9f227",
		fontSize: 8,
		letterSpacing: ".12em"
	},
	runInspector: { border: "1px solid #373d39", backgroundColor: "#131614", padding: 18 },
	firstCapture: {
		minHeight: 430,
		marginTop: 12,
		border: "1px solid #353b37",
		backgroundColor: "#111412",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		color: "#8c958f"
	},
	aperture: { color: "#b9f227", fontSize: 44 },
	history: { marginTop: 12, border: "1px solid #343a36", backgroundColor: "#111412" },
	historyHeading: {
		display: "flex",
		justifyContent: "space-between",
		padding: "10px 13px",
		borderBottom: "1px solid #343a36",
		color: "#7e8781",
		fontSize: 8,
		letterSpacing: ".13em"
	},
	runRail: { display: "flex", minHeight: 88, overflowX: "auto" },
	runCard: {
		minWidth: 170,
		display: "grid",
		gridTemplateColumns: "30px 1fr",
		alignItems: "center",
		border: 0,
		borderRight: "1px solid #303632",
		backgroundColor: { default: "transparent", ":hover": "#1d211e" },
		color: "#8b948e",
		textAlign: "left",
		cursor: "pointer",
		padding: 12
	},
	runCardActive: {
		backgroundColor: "#252b26",
		boxShadow: "inset 0 -2px #b9f227",
		color: "#edf1eb"
	}
});

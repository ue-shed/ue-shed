import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { For, Match, Show, Switch, createSignal, onMount } from "solid-js";
import type {
	MapReviewClientApi,
	MapReviewResult,
	MapReviewSetLibraryResult
} from "./map-review-client.js";

type LibraryState = { readonly status: "loading" } | MapReviewSetLibraryResult;

export function ReviewSetLibrary(props: {
	readonly canCreate: boolean;
	readonly client: MapReviewClientApi;
	readonly onChanged: (review: MapReviewResult) => void;
	readonly onClose: () => void;
}) {
	const loadAction = createEffectAction();
	const mutationAction = createEffectAction();
	const [state, setState] = createSignal<LibraryState>({ status: "loading" });
	const [displayName, setDisplayName] = createSignal("");
	const [workingId, setWorkingId] = createSignal<string>();
	const [operationFailure, setOperationFailure] = createSignal<{
		readonly message: string;
		readonly recovery: string;
	}>();

	const load = () => {
		setState({ status: "loading" });
		loadAction.run(props.client.reviewSetLibrary(), {
			onFailure: (cause) =>
				setState({
					error: {
						message: Cause.pretty(cause),
						recovery: "Restart Workbench, then reopen the Review Set library."
					},
					status: "failed"
				}),
			onSuccess: setState
		});
	};

	onMount(load);

	const finishMutation = (result: MapReviewResult) => {
		setWorkingId(undefined);
		if (result.status === "failed") {
			setOperationFailure(result.error);
			return;
		}
		props.onChanged(result);
		props.onClose();
	};

	const select = (reviewSetId: string) => {
		setOperationFailure(undefined);
		setWorkingId(reviewSetId);
		mutationAction.run(props.client.selectReviewSet({ reviewSetId }), {
			onFailure: (cause) => {
				setWorkingId(undefined);
				setOperationFailure({
					message: Cause.pretty(cause),
					recovery: "Reload the set library and try again."
				});
			},
			onSuccess: finishMutation
		});
	};

	const create = () => {
		const name = displayName().trim();
		if (name.length === 0 || !props.canCreate) return;
		setOperationFailure(undefined);
		setWorkingId("create");
		mutationAction.run(props.client.createReviewSet({ displayName: name }), {
			onFailure: (cause) => {
				setWorkingId(undefined);
				setOperationFailure({
					message: Cause.pretty(cause),
					recovery: "Verify the project review directory is writable and try again."
				});
			},
			onSuccess: finishMutation
		});
	};

	return (
		<div {...stylex.props(styles.scrim)}>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="review-set-library-title"
				{...stylex.props(styles.drawer)}
			>
				<header {...stylex.props(styles.header)}>
					<div>
						<span {...stylex.props(styles.kicker)}>
							MAP REVIEW / PORTABLE DEFINITIONS
						</span>
						<h2 id="review-set-library-title" {...stylex.props(styles.title)}>
							Review Set library
						</h2>
						<p {...stylex.props(styles.subtitle)}>
							Move between focused collections without changing the Unreal map.
						</p>
					</div>
					<button
						type="button"
						aria-label="Close Review Set library"
						onClick={props.onClose}
						{...stylex.props(styles.close)}
					>
						×
					</button>
				</header>

				<div {...stylex.props(styles.body)}>
					<Switch>
						<Match when={state().status === "loading"}>
							<div {...stylex.props(styles.centerState)}>Indexing Review Sets…</div>
						</Match>
						<Match when={state().status === "not_configured"}>
							<div {...stylex.props(styles.centerState)}>
								<strong>No project selected</strong>
								<span>Choose a project before opening its Review Set library.</span>
							</div>
						</Match>
						<Match when={state().status === "failed"}>
							{(() => {
								const current = state();
								if (current.status !== "failed") return null;
								return (
									<div role="alert" {...stylex.props(styles.failure)}>
										<strong>{current.error.message}</strong>
										<span>{current.error.recovery}</span>
										<button type="button" onClick={load}>
											RETRY
										</button>
									</div>
								);
							})()}
						</Match>
						<Match when={state().status === "ready"}>
							{(() => {
								const current = state();
								if (current.status !== "ready") return null;
								return (
									<>
										<section aria-label="Available Review Sets">
											<div {...stylex.props(styles.sectionHeading)}>
												<span>AVAILABLE SETS</span>
												<strong>{current.sets.length}</strong>
											</div>
											<Show
												when={current.sets.length > 0}
												fallback={
													<div {...stylex.props(styles.empty)}>
														No Review Sets have been saved for this
														project yet.
													</div>
												}
											>
												<div {...stylex.props(styles.setList)}>
													<For each={current.sets}>
														{(reviewSet, index) => {
															const active = () =>
																current.activeReviewSetId ===
																reviewSet.id;
															return (
																<article
																	{...stylex.props(
																		styles.setCard,
																		active() &&
																			styles.setCardActive
																	)}
																>
																	<span
																		{...stylex.props(
																			styles.setIndex
																		)}
																	>
																		{String(
																			index() + 1
																		).padStart(2, "0")}
																	</span>
																	<div
																		{...stylex.props(
																			styles.setCopy
																		)}
																	>
																		<div
																			{...stylex.props(
																				styles.setTitle
																			)}
																		>
																			<strong>
																				{
																					reviewSet.displayName
																				}
																			</strong>
																			<Show when={active()}>
																				<span
																					{...stylex.props(
																						styles.activeBadge
																					)}
																				>
																					ACTIVE
																				</span>
																			</Show>
																		</div>
																		<code>
																			{reviewSet.mapPath}
																		</code>
																		<small>
																			{reviewSet.viewCount}{" "}
																			APPROVED{" "}
																			{reviewSet.viewCount ===
																			1
																				? "VIEW"
																				: "VIEWS"}
																		</small>
																	</div>
																	<button
																		type="button"
																		disabled={
																			active() ||
																			workingId() !==
																				undefined
																		}
																		onClick={() =>
																			select(reviewSet.id)
																		}
																		{...stylex.props(
																			styles.openButton
																		)}
																	>
																		{workingId() ===
																		reviewSet.id
																			? "OPENING…"
																			: active()
																				? "OPEN"
																				: "OPEN SET"}
																	</button>
																</article>
															);
														}}
													</For>
												</div>
											</Show>
										</section>

										<section
											aria-label="Create Review Set"
											{...stylex.props(styles.createPanel)}
										>
											<div>
												<span {...stylex.props(styles.createLabel)}>
													NEW COLLECTION
												</span>
												<strong>Create an empty sibling set</strong>
												<p>
													Reuses the active set’s map, capture profiles,
													and visibility policies—never its Views.
												</p>
											</div>
											<form
												onSubmit={(event) => {
													event.preventDefault();
													create();
												}}
												{...stylex.props(styles.createForm)}
											>
												<label>
													<span>SET NAME</span>
													<input
														aria-label="New Review Set name"
														maxLength={80}
														placeholder="Lighting review"
														value={displayName()}
														disabled={
															!props.canCreate ||
															workingId() !== undefined
														}
														onInput={(event) =>
															setDisplayName(
																event.currentTarget.value
															)
														}
													/>
												</label>
												<button
													type="submit"
													disabled={
														!props.canCreate ||
														displayName().trim().length === 0 ||
														workingId() !== undefined
													}
												>
													{workingId() === "create"
														? "CREATING…"
														: "CREATE + OPEN"}
												</button>
											</form>
											<Show when={!props.canCreate}>
												<small {...stylex.props(styles.createHint)}>
													Open an existing set or keep the first View
													before creating a sibling.
												</small>
											</Show>
										</section>
									</>
								);
							})()}
						</Match>
					</Switch>

					<Show when={operationFailure()}>
						{(failure) => (
							<div role="alert" {...stylex.props(styles.operationFailure)}>
								<strong>{failure().message}</strong>
								<span>{failure().recovery}</span>
							</div>
						)}
					</Show>
				</div>
			</section>
		</div>
	);
}

const styles = stylex.create({
	scrim: {
		position: "fixed",
		inset: 0,
		zIndex: 82,
		backgroundColor: "#030504c7",
		backdropFilter: "blur(4px)",
		display: "flex",
		justifyContent: "flex-start"
	},
	drawer: {
		width: "min(760px, 96vw)",
		height: "100%",
		backgroundColor: "#0d100e",
		borderRight: "1px solid #4a554b",
		boxShadow: "28px 0 90px #000b",
		display: "grid",
		gridTemplateRows: "auto minmax(0, 1fr)",
		color: tokens.colorText
	},
	header: {
		minHeight: 136,
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		padding: "28px 30px 24px",
		borderBottom: "1px solid #343b36",
		backgroundImage: "linear-gradient(115deg, #171d18 0%, #0d100e 68%)"
	},
	kicker: { color: tokens.colorAccent, fontSize: 8, letterSpacing: ".16em" },
	title: {
		margin: "8px 0 5px",
		fontFamily: "Georgia, serif",
		fontWeight: 400,
		fontSize: 30
	},
	subtitle: { margin: 0, color: "#89938c", fontSize: 11 },
	close: {
		width: 34,
		height: 34,
		border: "1px solid #424b44",
		backgroundColor: { default: "transparent", ":hover": "#222923" },
		color: "#96a099",
		fontSize: 21,
		cursor: "pointer"
	},
	body: { overflowY: "auto", padding: "24px 28px 40px" },
	centerState: {
		minHeight: 240,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		gap: 10,
		color: "#7f8982",
		fontSize: 11
	},
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		marginBottom: 10,
		color: "#707a73",
		fontSize: 8,
		letterSpacing: ".14em"
	},
	setList: { display: "grid", gap: 8 },
	setCard: {
		minHeight: 82,
		display: "grid",
		gridTemplateColumns: "42px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 13,
		padding: "0 14px",
		border: "1px solid #333b35",
		backgroundColor: "#131714"
	},
	setCardActive: {
		borderColor: "#78856d",
		backgroundColor: "#192019",
		boxShadow: "inset 3px 0 #b9f227"
	},
	setIndex: { color: tokens.colorAccent, fontFamily: "Georgia, serif", fontSize: 21 },
	setCopy: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		fontSize: 10
	},
	setTitle: {
		display: "flex",
		alignItems: "center",
		gap: 9
	},
	activeBadge: {
		padding: "2px 5px",
		border: "1px solid #7b8a69",
		color: tokens.colorAccent,
		fontSize: 7,
		letterSpacing: ".12em"
	},
	openButton: {
		minWidth: 88,
		height: 32,
		border: "1px solid #68745f",
		backgroundColor: { default: "transparent", ":hover": "#252c25", ":disabled": "#171b18" },
		color: { default: "#b9c1ba", ":disabled": "#626a64" },
		fontSize: 8,
		fontWeight: 800,
		letterSpacing: ".1em",
		cursor: { default: "pointer", ":disabled": "default" }
	},
	empty: {
		padding: 24,
		border: "1px dashed #3b433d",
		color: "#778179",
		fontSize: 10
	},
	createPanel: {
		marginTop: 28,
		padding: 20,
		border: "1px solid #3b433d",
		borderLeft: "3px solid #899881",
		backgroundColor: "#151a16",
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) minmax(260px, .85fr)",
		gap: 24,
		fontSize: 10,
		color: "#89938c"
	},
	createLabel: {
		display: "block",
		marginBottom: 7,
		color: tokens.colorAccent,
		fontSize: 8,
		letterSpacing: ".14em"
	},
	createForm: { display: "flex", alignItems: "flex-end", gap: 8 },
	createHint: { gridColumn: "1 / -1", color: "#c8966f" },
	failure: {
		minHeight: 220,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		justifyContent: "center",
		gap: 10,
		color: "#dc9278"
	},
	operationFailure: {
		marginTop: 16,
		padding: 14,
		border: "1px solid #7e5547",
		backgroundColor: "#241713",
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: "#e2a087",
		fontSize: 10
	}
});

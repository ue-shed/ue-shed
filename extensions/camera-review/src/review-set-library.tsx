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
						<h2 id="review-set-library-title" {...stylex.props(styles.title)}>
							Review sets
						</h2>
						<p {...stylex.props(styles.subtitle)}>
							Move between focused collections without changing the Unreal map.
						</p>
					</div>
					<button
						type="button"
						aria-label="Close review sets"
						onClick={props.onClose}
						{...stylex.props(styles.close)}
					>
						×
					</button>
				</header>

				<div {...stylex.props(styles.body)}>
					<Switch>
						<Match when={state().status === "loading"}>
							<div {...stylex.props(styles.centerState)}>Loading review sets…</div>
						</Match>
						<Match when={state().status === "not_configured"}>
							<div {...stylex.props(styles.centerState)}>
								<strong>No project selected</strong>
								<span>Choose a project before opening its review sets.</span>
							</div>
						</Match>
						<Match when={state().status === "failed"}>
							{(() => {
								const current = state();
								if (current.status !== "failed") return null;
								return (
									<div role="alert" {...stylex.props(styles.failure)}>
										<strong {...stylex.props(styles.failureTitle)}>
											Couldn't load review sets
										</strong>
										<span>{current.error.recovery}</span>
										<button
											type="button"
											onClick={load}
											{...stylex.props(styles.retry)}
										>
											Retry
										</button>
										<details {...stylex.props(styles.technical)}>
											<summary>Technical details</summary>
											<code>{current.error.message}</code>
										</details>
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
										<section aria-label="Available sets">
											<div {...stylex.props(styles.sectionHeading)}>
												<span>Sets · {current.sets.length}</span>
											</div>
											<Show
												when={current.sets.length > 0}
												fallback={
													<div {...stylex.props(styles.empty)}>
														No review sets have been saved for this
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
																					Active
																				</span>
																			</Show>
																		</div>
																		<code>
																			{reviewSet.mapPath}
																		</code>
																		<small>
																			{reviewSet.viewCount}{" "}
																			{reviewSet.viewCount ===
																			1
																				? "view"
																				: "views"}
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
																			? "Opening…"
																			: active()
																				? "Open"
																				: "Open set"}
																	</button>
																</article>
															);
														}}
													</For>
												</div>
											</Show>
										</section>

										<section
											aria-label="Create a set"
											{...stylex.props(styles.createPanel)}
										>
											<div>
												<strong {...stylex.props(styles.createTitle)}>
													Create an empty set
												</strong>
												<p>
													Reuses the active set's map, capture profiles,
													and visibility policies—never its views.
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
													<span>Name</span>
													<input
														aria-label="New review set name"
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
														? "Creating…"
														: "Create and open"}
												</button>
											</form>
											<Show when={!props.canCreate}>
												<small {...stylex.props(styles.createHint)}>
													Open an existing set or add a first view before
													creating a sibling.
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
								<strong {...stylex.props(styles.failureTitle)}>
									Couldn't finish that operation
								</strong>
								<span>{failure().recovery}</span>
								<details {...stylex.props(styles.technical)}>
									<summary>Technical details</summary>
									<code>{failure().message}</code>
								</details>
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
		backgroundColor: "rgba(8, 9, 10, 0.78)",
		backdropFilter: "blur(4px)",
		display: "flex",
		justifyContent: "flex-start"
	},
	drawer: {
		width: "min(760px, 96vw)",
		height: "100%",
		backgroundColor: tokens.colorSurface,
		borderRight: `1px solid ${tokens.colorBorder}`,
		boxShadow: tokens.shadowOverlay,
		display: "grid",
		gridTemplateRows: "auto minmax(0, 1fr)",
		color: tokens.colorText
	},
	header: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		gap: 18,
		padding: `${tokens.space5}px ${tokens.space5}px ${tokens.space4}px`,
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	title: { margin: 0, fontFamily: tokens.fontDisplay, fontWeight: 590, fontSize: 22 },
	subtitle: {
		margin: "6px 0 0",
		color: tokens.colorTextMuted,
		fontSize: 13
	},
	close: {
		width: 34,
		height: 34,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
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
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	sectionHeading: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "baseline",
		marginBottom: 10,
		color: tokens.colorTextStrong,
		fontSize: 12,
		fontWeight: 600
	},
	setList: { display: "grid", gap: 8 },
	setCard: {
		minHeight: 82,
		display: "grid",
		gridTemplateColumns: "42px minmax(0, 1fr) auto",
		alignItems: "center",
		gap: 13,
		padding: "0 14px",
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface
	},
	setCardActive: {
		borderColor: tokens.colorBorderStrong,
		backgroundColor: "rgba(255, 255, 255, 0.05)",
		boxShadow: `inset 2px 0 ${tokens.colorAccent}`
	},
	setIndex: { color: tokens.colorAccent, fontFamily: tokens.fontMono, fontSize: 21 },
	setCopy: {
		minWidth: 0,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		fontSize: 11
	},
	setTitle: {
		display: "flex",
		alignItems: "center",
		gap: 9
	},
	activeBadge: {
		padding: "2px 6px",
		borderRadius: tokens.radiusBadge,
		border: `1px solid ${tokens.colorBorderStrong}`,
		color: tokens.colorAccent,
		fontSize: 11,
		fontWeight: 500
	},
	openButton: {
		minWidth: 88,
		height: 32,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: {
			default: "transparent",
			":hover": "rgba(255, 255, 255, 0.04)",
			":disabled": "transparent"
		},
		color: { default: tokens.colorText, ":disabled": tokens.colorTextFaint },
		fontSize: 12,
		fontWeight: 500,
		cursor: { default: "pointer", ":disabled": "default" }
	},
	empty: {
		padding: tokens.space5,
		border: `1px dashed ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	createPanel: {
		marginTop: 28,
		padding: 20,
		border: `1px solid ${tokens.colorBorder}`,
		borderLeft: `3px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurface,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) minmax(260px, .85fr)",
		gap: 24,
		fontSize: 12,
		color: tokens.colorTextMuted
	},
	createTitle: {
		display: "block",
		marginBottom: 6,
		color: tokens.colorTextStrong
	},
	createForm: { display: "flex", alignItems: "flex-end", gap: 8 },
	createHint: { gridColumn: "1 / -1", color: tokens.colorWarning },
	retry: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: { default: "transparent", ":hover": tokens.colorSurfaceHover },
		color: tokens.colorText,
		padding: "6px 12px",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer"
	},
	failure: {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: tokens.space3,
		padding: tokens.space5,
		border: `1px solid ${tokens.colorBorder}`,
		borderRadius: tokens.radiusControl,
		backgroundColor: tokens.colorSurface,
		color: tokens.colorTextMuted
	},
	failureTitle: { color: tokens.colorTextStrong, fontSize: 15, fontWeight: 600 },
	technical: {
		alignSelf: "stretch",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	operationFailure: {
		marginTop: 16,
		padding: 14,
		border: "1px solid rgba(235, 87, 87, 0.4)",
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: tokens.colorDanger,
		fontSize: 12
	}
});

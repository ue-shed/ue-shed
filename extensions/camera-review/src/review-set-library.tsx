import * as stylex from "@stylexjs/stylex";
import { Button, createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect } from "effect";
import { MapSwitchDialog } from "./map-switch-dialog.js";
import { For, Match, Show, Switch, createSignal, onSettled } from "solid-js";
import type {
	MapReviewClientApi,
	MapReviewResult,
	MapReviewSetLibraryResult
} from "./map-review-client.js";

type LibraryState = { readonly status: "loading" } | MapReviewSetLibraryResult;

export function ReviewSetLibrary(props: {
	readonly canCreate: boolean;
	readonly client: Pick<
		MapReviewClientApi,
		| "reviewSetLibrary"
		| "selectReviewSet"
		| "createReviewSet"
		| "editorWorld"
		| "openMapInUnreal"
	>;
	readonly onChanged: (review: MapReviewResult) => void;
	readonly onClose: () => void;
	readonly onNewCameraSet?: (() => void) | undefined;
}) {
	const loadAction = createEffectAction();
	const mutationAction = createEffectAction();
	const [state, setState] = createSignal<LibraryState>({ status: "loading" });
	const [displayName, setDisplayName] = createSignal("");
	const [workingId, setWorkingId] = createSignal<string>();
	const [switchTarget, setSwitchTarget] = createSignal<{
		id: string;
		mapPath: string;
		currentMap?: string | undefined;
	}>();
	const [switchError, setSwitchError] = createSignal<string>();
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

	onSettled(load);

	const finishMutation = (result: MapReviewResult) => {
		setWorkingId(undefined);
		if (result.status !== "ready") {
			setOperationFailure(
				result.status === "failed"
					? result.error
					: {
							message: "The Review Set was not opened.",
							recovery: "Choose a project and reopen the library."
						}
			);
			return;
		}
		props.onChanged(result);
		props.onClose();
	};

	const openSavedSet = (reviewSetId: string) => {
		const current = state();
		if (current.status === "ready" && current.activeReviewSetId === reviewSetId) {
			props.onClose();
			return;
		}
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
	const select = (reviewSetId: string, mapPath: string) => {
		if (workingId()) return;
		const inspect = props.client.editorWorld;
		if (!inspect) {
			openSavedSet(reviewSetId);
			return;
		}
		setWorkingId(reviewSetId);
		setOperationFailure(undefined);
		mutationAction.run(inspect(), {
			onFailure: (cause) => {
				setWorkingId(undefined);
				setOperationFailure({
					message: Cause.pretty(cause),
					recovery: "Check the editor connection and try again."
				});
			},
			onSuccess: (editor) => {
				setWorkingId(undefined);
				if (editor.status === "opening") {
					setOperationFailure({
						message: "Unreal is loading a map.",
						recovery: "Wait for it to finish before opening another review set."
					});
				} else if (editor.status === "ready" && editor.world.snapshot.mapPath !== mapPath) {
					setSwitchError(undefined);
					setSwitchTarget({
						id: reviewSetId,
						mapPath,
						currentMap: editor.world.snapshot.mapPath
					});
				} else openSavedSet(reviewSetId);
			}
		});
	};
	const confirmSwitch = () => {
		const target = switchTarget();
		const open = props.client.openMapInUnreal;
		if (!target || workingId()) return;
		if (!open) {
			setSwitchError(
				"This host cannot switch maps. Open the map in Unreal, or browse the saved review only."
			);
			return;
		}
		setWorkingId(target.id);
		setSwitchError(undefined);
		mutationAction.run(
			open(target.mapPath).pipe(
				Effect.flatMap((result) =>
					result.outcome === "opened" || result.outcome === "already_open"
						? props.client.selectReviewSet({ reviewSetId: target.id })
						: Effect.succeed({
								status: "failed" as const,
								error: { message: result.message, recovery: result.recovery }
							})
				)
			),
			{
				onFailure: (cause) => {
					setWorkingId(undefined);
					setSwitchError(Cause.pretty(cause));
				},
				onSuccess: (result) => {
					if (result.status === "ready") {
						setSwitchTarget(undefined);
						finishMutation(result);
					} else {
						setWorkingId(undefined);
						setSwitchError(
							result.status === "failed"
								? `${result.error.message} ${result.error.recovery}`
								: "The review set is not available."
						);
					}
				}
			}
		);
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
		<div {...stylex.attrs(styles.scrim)}>
			<Show when={switchTarget()}>
				{(target) => (
					<MapSwitchDialog
						currentMap={target().currentMap}
						targetMap={target().mapPath}
						busy={workingId() !== undefined}
						error={switchError()}
						onConfirm={confirmSwitch}
						onCancel={() => setSwitchTarget(undefined)}
						onBrowseOnly={() => {
							const id = target().id;
							setSwitchTarget(undefined);
							openSavedSet(id);
						}}
					/>
				)}
			</Show>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="review-set-library-title"
				{...stylex.attrs(styles.drawer)}
			>
				<header {...stylex.attrs(styles.header)}>
					<div>
						<h2 id="review-set-library-title" {...stylex.attrs(styles.title)}>
							Saved views & captures
						</h2>
						<p {...stylex.attrs(styles.subtitle)}>
							Open a collection to view its saved cameras and capture history, or to
							choose where Save views stores your current cameras. To continue editing
							a camera setup, use Open camera draft in the camera workspace.
						</p>
					</div>
					<button
						type="button"
						aria-label="Close review sets"
						onClick={props.onClose}
						{...stylex.attrs(styles.close)}
					>
						×
					</button>
				</header>

				<div {...stylex.attrs(styles.body)}>
					<Switch>
						<Match when={state().status === "loading"}>
							<div {...stylex.attrs(styles.centerState)}>Loading review sets…</div>
						</Match>
						<Match when={state().status === "not_configured"}>
							<div {...stylex.attrs(styles.centerState)}>
								<strong>No project selected</strong>
								<span>Choose a project before opening its review sets.</span>
							</div>
						</Match>
						<Match when={state().status === "failed"}>
							{(() => {
								const current = state();
								if (current.status !== "failed") return null;
								return (
									<div role="alert" {...stylex.attrs(styles.failure)}>
										<strong {...stylex.attrs(styles.failureTitle)}>
											Couldn't load review sets
										</strong>
										<span>{current.error.recovery}</span>
										<button
											type="button"
											onClick={load}
											{...stylex.attrs(styles.retry)}
										>
											Retry
										</button>
										<details {...stylex.attrs(styles.technical)}>
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
											<div {...stylex.attrs(styles.sectionHeading)}>
												<span>Sets · {current.sets.length}</span>
											</div>
											<Show
												when={current.sets.length > 0}
												fallback={
													<div {...stylex.attrs(styles.empty)}>
														No review sets have been saved for this
														project yet.
													</div>
												}
											>
												<div {...stylex.attrs(styles.setList)}>
													<For each={current.sets}>
														{(reviewSet, index) => {
															const active = () =>
																current.activeReviewSetId ===
																reviewSet.id;
															return (
																<article
																	{...stylex.attrs(
																		styles.setCard,
																		active() &&
																			styles.setCardActive
																	)}
																>
																	<span
																		{...stylex.attrs(
																			styles.setIndex
																		)}
																	>
																		{String(
																			index() + 1
																		).padStart(2, "0")}
																	</span>
																	<div
																		{...stylex.attrs(
																			styles.setCopy
																		)}
																	>
																		<div
																			{...stylex.attrs(
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
																					{...stylex.attrs(
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
																			workingId() !==
																			undefined
																		}
																		onClick={() =>
																			select(
																				reviewSet.id,
																				reviewSet.mapPath
																			)
																		}
																		{...stylex.attrs(
																			styles.openButton
																		)}
																	>
																		{workingId() ===
																		reviewSet.id
																			? "Opening…"
																			: active()
																				? "Return to set"
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
											{...stylex.attrs(styles.createPanel)}
										>
											<Show
												when={props.canCreate}
												fallback={
													<div>
														<strong
															{...stylex.attrs(styles.createTitle)}
														>
															Starting a new camera setup?
														</strong>
														<p>
															Create a camera set from an actor. Its
															Review Set is created automatically—you
															don't need an existing set first.
														</p>
														<Show when={props.onNewCameraSet}>
															<Button
																tone="primary"
																onClick={props.onNewCameraSet}
															>
																New camera set
															</Button>
														</Show>
													</div>
												}
											>
												<div>
													<strong {...stylex.attrs(styles.createTitle)}>
														Create another Review Set
													</strong>
													<p>
														Reuses the active set's map, capture
														profiles, and visibility policies—never its
														views.
													</p>
												</div>
												<form
													onSubmit={(event) => {
														event.preventDefault();
														create();
													}}
													{...stylex.attrs(styles.createForm)}
												>
													<label {...stylex.attrs(styles.nameField)}>
														<span>Name</span>
														<input
															{...stylex.attrs(styles.nameInput)}
															aria-label="New review set name"
															maxlength={80}
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
													<Button
														tone="primary"
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
													</Button>
												</form>
											</Show>
										</section>
									</>
								);
							})()}
						</Match>
					</Switch>

					<Show when={operationFailure()}>
						{(failure) => (
							<div role="alert" {...stylex.attrs(styles.operationFailure)}>
								<strong {...stylex.attrs(styles.failureTitle)}>
									{failure().message}
								</strong>
								<span>{failure().recovery}</span>
								<details {...stylex.attrs(styles.technical)}>
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
		borderRightColor: tokens.colorBorder,
		borderRightStyle: "solid",
		borderRightWidth: 1,
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
		borderBottomColor: tokens.colorBorder,
		borderBottomStyle: "solid",
		borderBottomWidth: 1
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
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
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
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
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
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
		color: tokens.colorAccent,
		fontSize: 11,
		fontWeight: 500
	},
	openButton: {
		minWidth: 88,
		height: 32,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
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
		borderColor: tokens.colorBorder,
		borderStyle: "dashed",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	createPanel: {
		marginTop: 28,
		padding: 20,
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
		borderLeftColor: tokens.colorBorderStrong,
		borderLeftStyle: "solid",
		borderLeftWidth: 3,
		backgroundColor: tokens.colorSurface,
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr)",
		gap: 24,
		fontSize: 12,
		color: tokens.colorTextMuted
	},
	createTitle: {
		display: "block",
		marginBottom: 6,
		color: tokens.colorTextStrong
	},
	createForm: { display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: 8 },
	nameField: { display: "flex", flexDirection: "column", flex: "1 1 200px", gap: 6 },
	nameInput: {
		minWidth: 0,
		width: "100%",
		boxSizing: "border-box",
		padding: "10px 12px",
		fontFamily: tokens.fontBody,
		color: tokens.colorText,
		backgroundColor: tokens.colorSurfaceInset,
		borderColor: tokens.colorBorderInteractive,
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl
	},
	retry: {
		borderColor: tokens.colorBorderStrong,
		borderStyle: "solid",
		borderWidth: 1,
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
		borderColor: tokens.colorBorder,
		borderStyle: "solid",
		borderWidth: 1,
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
		borderColor: "rgba(235, 87, 87, 0.4)",
		borderStyle: "solid",
		borderWidth: 1,
		borderRadius: tokens.radiusControl,
		backgroundColor: "rgba(235, 87, 87, 0.08)",
		display: "flex",
		flexDirection: "column",
		gap: 6,
		color: tokens.colorDanger,
		fontSize: 12
	}
});

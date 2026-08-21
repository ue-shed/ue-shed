import * as stylex from "@stylexjs/stylex";
import { createEffectAction } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause } from "effect";
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type {
	MapReviewCaptureCompletedJob,
	MapReviewClientApi,
	MapReviewResult
} from "./map-review-client.js";

type ReadyReview = Extract<MapReviewResult, { status: "ready" }>;
type WorkflowState =
	| { readonly stage: "prepare" }
	| { readonly stage: "preview" }
	| { readonly stage: "capturing" }
	| { readonly stage: "completed"; readonly job: MapReviewCaptureCompletedJob }
	| {
			readonly stage: "blocked" | "failed";
			readonly message: string;
			readonly recovery: string;
	  };

const stageOrder = ["PREPARE", "PREVIEW", "CAPTURE"] as const;

export function CaptureWorkflow(props: {
	readonly client: MapReviewClientApi;
	readonly onCaptured: (review: ReadyReview) => void;
	readonly onClose: () => void;
	readonly review: ReadyReview;
}) {
	const action = createEffectAction();
	const [state, setState] = createSignal<WorkflowState>({ stage: "prepare" });
	const [selectedIds, setSelectedIds] = createSignal<ReadonlyArray<string>>(
		props.review.reviewSet.views.map((view) => view.id)
	);
	const selectedViews = createMemo(() =>
		props.review.reviewSet.views.filter((view) => selectedIds().includes(view.id))
	);
	const activeStep = createMemo(() => {
		const stage = state().stage;
		if (stage === "prepare") return 0;
		if (stage === "preview") return 1;
		return 2;
	});
	const toggleView = (viewId: string) => {
		setSelectedIds((current) =>
			current.includes(viewId)
				? current.filter((candidate) => candidate !== viewId)
				: [...current, viewId]
		);
	};
	const capture = () => {
		const viewIds = selectedIds();
		if (viewIds.length === 0) return;
		setState({ stage: "capturing" });
		action.run(props.client.capture({ viewIds }), {
			onFailure: (cause) =>
				setState({
					message: Cause.pretty(cause),
					recovery: "Verify the Workbench connection and retry the capture plan.",
					stage: "failed"
				}),
			onSuccess: (result) => {
				switch (result.status) {
					case "completed":
						props.onCaptured(result.review);
						setState({ job: result.job, stage: "completed" });
						break;
					case "blocked":
						setState({
							message: result.policy.message,
							recovery: result.policy.recovery,
							stage: "blocked"
						});
						break;
					case "failed":
						setState({
							message: result.error.message,
							recovery: result.error.recovery,
							stage: "failed"
						});
						break;
					case "not_configured":
						setState({
							message: "No Review Set is configured.",
							recovery: "Configure a Review Set, then reopen this capture workflow.",
							stage: "failed"
						});
				}
			}
		});
	};

	return (
		<div {...stylex.props(styles.scrim)}>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="capture-workflow-title"
				{...stylex.props(styles.drawer)}
			>
				<header {...stylex.props(styles.header)}>
					<div>
						<span {...stylex.props(styles.kicker)}>CAPTURE</span>
						<h2 id="capture-workflow-title" {...stylex.props(styles.title)}>
							Capture review set
						</h2>
					</div>
					<button
						type="button"
						aria-label="Close capture workflow"
						disabled={state().stage === "capturing"}
						onClick={props.onClose}
						{...stylex.props(styles.close)}
					>
						×
					</button>
				</header>

				<ol aria-label="Capture workflow progress" {...stylex.props(styles.steps)}>
					<For each={stageOrder}>
						{(label, index) => (
							<li
								{...stylex.props(
									styles.step,
									index() <= activeStep() && styles.stepActive
								)}
							>
								<span>{String(index() + 1).padStart(2, "0")}</span>
								<strong>{label}</strong>
							</li>
						)}
					</For>
				</ol>

				<div {...stylex.props(styles.body)}>
					<Switch>
						<Match when={state().stage === "prepare"}>
							<section aria-label="Prepare capture" {...stylex.props(styles.stage)}>
								<p {...stylex.props(styles.stageNumber)}>01 / PREPARE</p>
								<h3 {...stylex.props(styles.stageTitle)}>Confirm what will run</h3>
								<p {...stylex.props(styles.copy)}>
									Captures approved Review Set poses to PNG on disk. Does not save
									or modify the Unreal map.
								</p>
								<dl {...stylex.props(styles.facts)}>
									<div {...stylex.props(styles.fact)}>
										<dt {...stylex.props(styles.factLabel)}>
											Execution context
										</dt>
										<dd {...stylex.props(styles.factValue)}>
											<span {...stylex.props(styles.contextDot)} />
											Editor World
										</dd>
									</div>
									<div {...stylex.props(styles.fact)}>
										<dt {...stylex.props(styles.factLabel)}>Review Set</dt>
										<dd {...stylex.props(styles.factValue)}>
											{props.review.reviewSet.displayName}
										</dd>
									</div>
									<div {...stylex.props(styles.fact)}>
										<dt {...stylex.props(styles.factLabel)}>Map</dt>
										<dd {...stylex.props(styles.factValue)}>
											<code>{props.review.reviewSet.mapPath}</code>
										</dd>
									</div>
									<div {...stylex.props(styles.fact)}>
										<dt {...stylex.props(styles.factLabel)}>Approved views</dt>
										<dd {...stylex.props(styles.factValue)}>
											{props.review.reviewSet.viewCount}
										</dd>
									</div>
								</dl>
								<div {...stylex.props(styles.distinction)}>
									<span>PREVIEW</span>
									<p>Pick which views to include. Nothing is written yet.</p>
									<span>CAPTURE</span>
									<p>Writes a run folder with PNG artifacts under .ue-shed.</p>
								</div>
							</section>
						</Match>

						<Match when={state().stage === "preview"}>
							<section
								aria-label="Preview capture plan"
								{...stylex.props(styles.stage)}
							>
								<p {...stylex.props(styles.stageNumber)}>02 / PREVIEW</p>
								<h3 {...stylex.props(styles.stageTitle)}>
									Review the capture plan.
								</h3>
								<p {...stylex.props(styles.copy)}>
									Inspect coverage and resolution before Unreal renders.
									Deselecting a view changes only this run—not the Review Set.
								</p>
								<div {...stylex.props(styles.planSummary)}>
									<strong>{selectedViews().length}</strong>
									<span>OF {props.review.reviewSet.viewCount} VIEWS ARMED</span>
								</div>
								<ul {...stylex.props(styles.viewList)}>
									<For each={props.review.reviewSet.views}>
										{(view, index) => (
											<li
												{...stylex.props(
													styles.view,
													selectedIds().includes(view.id) &&
														styles.viewSelected
												)}
											>
												<label {...stylex.props(styles.viewLabel)}>
													<input
														type="checkbox"
														checked={selectedIds().includes(view.id)}
														onChange={() => toggleView(view.id)}
													/>
													<span {...stylex.props(styles.viewIndex)}>
														{String(index() + 1).padStart(2, "0")}
													</span>
													<span {...stylex.props(styles.viewCopy)}>
														<strong>{view.displayName}</strong>
														<small>
															{view.resolution.width} ×{" "}
															{view.resolution.height} / APPROVED POSE
														</small>
														<small>
															PROFILE{" "}
															{view.captureProfileId ??
																"PROJECT DEFAULT"}{" "}
															/ POLICY{" "}
															{view.visibilityPolicy?.name ??
																"PROJECT DEFAULT"}
														</small>
													</span>
												</label>
											</li>
										)}
									</For>
								</ul>
								<Show when={selectedIds().length === 0}>
									<p role="alert" {...stylex.props(styles.warning)}>
										Select at least one approved view to continue.
									</p>
								</Show>
							</section>
						</Match>

						<Match when={state().stage === "capturing"}>
							<section
								aria-label="Capture in progress"
								aria-live="polite"
								{...stylex.props(styles.captureStage)}
							>
								<div {...stylex.props(styles.aperture)} />
								<p {...stylex.props(styles.stageNumber)}>03 / CAPTURE</p>
								<h3 {...stylex.props(styles.stageTitle)}>Capturing in Unreal</h3>
								<p>
									{selectedIds().length} approved{" "}
									{selectedIds().length === 1 ? "view" : "views"} in this run.
								</p>
								<div {...stylex.props(styles.progressTrack)}>
									<span {...stylex.props(styles.progressFill)} />
								</div>
								<small>
									Capture is synchronous in this version. Keep Workbench and
									Unreal open.
								</small>
							</section>
						</Match>

						<Match when={state().stage === "completed"}>
							{(() => {
								const current = state();
								if (current.stage !== "completed") return null;
								return (
									<section
										aria-label="Capture complete"
										aria-live="polite"
										{...stylex.props(styles.stage)}
									>
										<p {...stylex.props(styles.stageNumber)}>
											03 / CAPTURE COMPLETE
										</p>
										<h3 {...stylex.props(styles.stageTitle)}>
											Capture finished
										</h3>
										<p {...stylex.props(styles.copy)}>
											The new run is listed in capture history for this Review
											Set.
										</p>
										<div {...stylex.props(styles.resultGrid)}>
											<div {...stylex.props(styles.result)}>
												<strong>{current.job.successfulViews}</strong>
												<span>CAPTURED</span>
											</div>
											<div {...stylex.props(styles.result)}>
												<strong>{current.job.failedViews}</strong>
												<span>FAILED</span>
											</div>
											<div {...stylex.props(styles.result)}>
												<strong>
													{current.job.progress.completedViews}/
													{current.job.progress.totalViews}
												</strong>
												<span>PROCESSED</span>
											</div>
										</div>
										<code {...stylex.props(styles.runId)}>
											{current.job.runId}
										</code>
									</section>
								);
							})()}
						</Match>

						<Match when={state().stage === "blocked" || state().stage === "failed"}>
							{(() => {
								const current = state();
								if (current.stage !== "blocked" && current.stage !== "failed")
									return null;
								return (
									<section role="alert" {...stylex.props(styles.failure)}>
										<p {...stylex.props(styles.stageNumber)}>
											CAPTURE NOT STARTED
										</p>
										<h3>{current.message}</h3>
										<p>{current.recovery}</p>
									</section>
								);
							})()}
						</Match>
					</Switch>
				</div>

				<footer {...stylex.props(styles.footer)}>
					<Show when={state().stage === "prepare"}>
						<button
							type="button"
							onClick={props.onClose}
							{...stylex.props(styles.secondary)}
						>
							CANCEL
						</button>
						<button
							type="button"
							onClick={() => setState({ stage: "preview" })}
							{...stylex.props(styles.primary)}
						>
							REVIEW CAPTURE PLAN →
						</button>
					</Show>
					<Show when={state().stage === "preview"}>
						<button
							type="button"
							onClick={() => setState({ stage: "prepare" })}
							{...stylex.props(styles.secondary)}
						>
							← BACK
						</button>
						<button
							type="button"
							disabled={selectedIds().length === 0}
							onClick={capture}
							{...stylex.props(styles.primary)}
						>
							CAPTURE {selectedIds().length}{" "}
							{selectedIds().length === 1 ? "VIEW" : "VIEWS"}
						</button>
					</Show>
					<Show when={state().stage === "completed"}>
						<button
							type="button"
							onClick={props.onClose}
							{...stylex.props(styles.primary)}
						>
							DONE
						</button>
					</Show>
					<Show when={state().stage === "blocked" || state().stage === "failed"}>
						<button
							type="button"
							onClick={() => setState({ stage: "prepare" })}
							{...stylex.props(styles.secondary)}
						>
							REVIEW SETUP
						</button>
						<button
							type="button"
							onClick={props.onClose}
							{...stylex.props(styles.primary)}
						>
							CLOSE
						</button>
					</Show>
				</footer>
			</section>
		</div>
	);
}

const styles = stylex.create({
	scrim: {
		position: "fixed",
		inset: 0,
		zIndex: 80,
		backgroundColor: "rgba(8, 9, 10, 0.72)",
		backdropFilter: "blur(3px)",
		display: "flex",
		justifyContent: "flex-end"
	},
	drawer: {
		width: "min(570px, 94vw)",
		height: "100%",
		backgroundColor: tokens.colorSurface,
		borderLeft: `1px solid ${tokens.colorBorder}`,
		boxShadow: "-28px 0 80px rgba(8, 9, 10, 0.7)",
		display: "grid",
		gridTemplateRows: "auto auto minmax(0, 1fr) auto",
		color: tokens.colorText
	},
	header: {
		minHeight: 94,
		display: "flex",
		justifyContent: "space-between",
		alignItems: "flex-start",
		padding: "22px 24px 18px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	kicker: { color: tokens.colorAccent, fontSize: 11, letterSpacing: 0 },
	title: { margin: "7px 0 0", fontFamily: tokens.fontDisplay, fontWeight: 590, fontSize: 22 },
	close: {
		width: 32,
		height: 32,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorTextMuted,
		fontSize: 20,
		cursor: "pointer"
	},
	steps: {
		listStyle: "none",
		margin: 0,
		padding: 0,
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	step: {
		padding: "12px 16px",
		display: "flex",
		gap: 8,
		color: tokens.colorTextFaint,
		fontSize: 11,
		letterSpacing: 0,
		borderRight: `1px solid ${tokens.colorBorder}`
	},
	stepActive: { color: tokens.colorAccent, boxShadow: `inset 0 -2px ${tokens.colorAccent}` },
	body: { overflowY: "auto" },
	stage: { padding: "30px 26px" },
	stageNumber: { color: tokens.colorAccent, fontSize: 11, letterSpacing: 0 },
	stageTitle: {
		margin: "8px 0 10px",
		fontFamily: tokens.fontDisplay,
		fontWeight: 590,
		fontSize: 17
	},
	copy: { color: tokens.colorTextMuted, lineHeight: 1.7, fontSize: 13 },
	facts: { margin: "24px 0", border: `1px solid ${tokens.colorBorder}` },
	fact: {
		minHeight: 42,
		display: "grid",
		gridTemplateColumns: "140px 1fr",
		alignItems: "center",
		borderBottom: `1px solid ${tokens.colorBorder}`,
		padding: "0 13px"
	},
	factLabel: { color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: 0 },
	factValue: {
		margin: 0,
		color: tokens.colorText,
		fontSize: 13,
		overflow: "hidden",
		textOverflow: "ellipsis"
	},
	contextDot: {
		display: "inline-block",
		width: 6,
		height: 6,
		marginRight: 7,
		borderRadius: "50%",
		backgroundColor: tokens.colorAccent,
		boxShadow: "0 0 8px rgba(228, 242, 34, 0.35)"
	},
	distinction: {
		display: "grid",
		gridTemplateColumns: "80px 1fr",
		gap: "8px 14px",
		padding: 16,
		borderLeft: `2px solid ${tokens.colorBorderStrong}`,
		backgroundColor: tokens.colorSurfaceInset,
		fontSize: 12,
		color: tokens.colorTextMuted
	},
	planSummary: {
		display: "flex",
		alignItems: "baseline",
		gap: 10,
		margin: "20px 0 12px",
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	viewList: { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 7 },
	view: {
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset,
		opacity: 0.55
	},
	viewSelected: {
		borderColor: tokens.colorBorderStrong,
		backgroundColor: "rgba(255, 255, 255, 0.07)",
		opacity: 1
	},
	viewLabel: {
		minHeight: 62,
		display: "grid",
		gridTemplateColumns: "18px 34px 1fr",
		alignItems: "center",
		gap: 9,
		padding: "0 13px",
		cursor: "pointer"
	},
	viewIndex: { color: tokens.colorAccent, fontFamily: tokens.fontMono, fontSize: 15 },
	viewCopy: {
		display: "flex",
		flexDirection: "column",
		gap: 5,
		fontSize: 12,
		letterSpacing: ".04em"
	},
	warning: { color: tokens.colorWarning, fontSize: 12 },
	captureStage: {
		minHeight: "100%",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		justifyContent: "center",
		textAlign: "center",
		padding: 30,
		color: tokens.colorTextMuted
	},
	aperture: {
		width: 78,
		height: 78,
		position: "relative",
		marginBottom: 20,
		border: `1px solid ${tokens.colorBorderStrong}`,
		borderTopColor: tokens.colorAccent,
		borderRadius: "50%",
		boxShadow: "inset 0 0 28px rgba(228, 242, 34, 0.05)",
		animationName: stylex.keyframes({ to: { transform: "rotate(360deg)" } }),
		animationDuration: "2.4s",
		animationIterationCount: "infinite",
		animationTimingFunction: "linear"
	},
	progressTrack: {
		width: "70%",
		height: 2,
		margin: "22px 0",
		backgroundColor: tokens.colorBorder,
		overflow: "hidden"
	},
	progressFill: {
		display: "block",
		width: "42%",
		height: "100%",
		backgroundColor: tokens.colorAccent,
		animationName: stylex.keyframes({
			from: { transform: "translateX(-120%)" },
			to: { transform: "translateX(280%)" }
		}),
		animationDuration: "1.4s",
		animationIterationCount: "infinite",
		animationTimingFunction: "ease-in-out"
	},
	resultGrid: {
		display: "grid",
		gridTemplateColumns: "repeat(3, 1fr)",
		border: `1px solid ${tokens.colorBorder}`,
		margin: "24px 0"
	},
	result: {
		minHeight: 82,
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 7,
		borderRight: `1px solid ${tokens.colorBorder}`,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: 0
	},
	runId: {
		display: "block",
		padding: 12,
		border: `1px dashed ${tokens.colorBorderStrong}`,
		color: tokens.colorTextSubtle,
		fontSize: 12
	},
	failure: { padding: 30, color: tokens.colorDanger },
	footer: {
		minHeight: 70,
		padding: "14px 20px",
		borderTop: `1px solid ${tokens.colorBorder}`,
		display: "flex",
		justifyContent: "flex-end",
		gap: 8,
		backgroundColor: tokens.colorCanvas
	},
	secondary: {
		minHeight: 38,
		padding: "5px 12px",
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		fontSize: 13,
		letterSpacing: 0,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	},
	primary: {
		minHeight: 38,
		padding: "5px 12px",
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":disabled": tokens.colorBorderStrong
		},
		color: tokens.colorAccentText,
		fontWeight: 500,
		fontSize: 13,
		letterSpacing: 0,
		cursor: { default: "pointer", ":disabled": "not-allowed" }
	}
});

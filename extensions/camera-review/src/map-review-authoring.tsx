import * as stylex from "@stylexjs/stylex";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type {
	MapReviewAuthoringCandidate,
	MapReviewAuthoringResult,
	MapReviewClient,
	MapReviewPose
} from "./map-review-client.js";

type AuthoringState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "saving"; readonly session: ReadyAuthoring }
	| { readonly status: "ready"; readonly session: ReadyAuthoring }
	| { readonly status: "failed"; readonly message: string; readonly recovery: string }
	| {
			readonly status: "approved";
			readonly session: ReadyAuthoring;
			readonly candidateId: string;
	  };

type ReadyAuthoring = Extract<MapReviewAuthoringResult, { status: "ready" }>;

function CandidateImage(props: { readonly candidate: MapReviewAuthoringCandidate }) {
	const [source, setSource] = createSignal<string>();
	createEffect(() => {
		if (props.candidate.preview.status !== "ready") {
			setSource(undefined);
			return;
		}
		const bytes = Uint8Array.from(props.candidate.preview.bytes);
		const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" }));
		setSource(url);
		onCleanup(() => URL.revokeObjectURL(url));
	});
	return (
		<Show
			when={source()}
			fallback={
				<div {...stylex.props(styles.previewFailure)}>
					<span>
						{props.candidate.preview.status === "pending"
							? "RENDERING PREVIEW"
							: "PREVIEW UNAVAILABLE"}
					</span>
					<small>
						{props.candidate.preview.status === "failed"
							? props.candidate.preview.message
							: "One bounded Unreal capture is in progress."}
					</small>
				</div>
			}
		>
			{(url) => (
				<img
					src={url()}
					alt={`${props.candidate.displayName} candidate preview`}
					{...stylex.props(styles.candidateImage)}
				/>
			)}
		</Show>
	);
}

function samePose(left: MapReviewPose, right: MapReviewPose): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function poseFieldValue(
	pose: MapReviewPose | undefined,
	section: "location" | "rotation" | "pose",
	field: "x" | "y" | "z" | "pitch" | "yaw" | "fieldOfViewDegrees"
): number | undefined {
	if (!pose) return undefined;
	if (section === "pose") return pose.fieldOfViewDegrees;
	if (section === "location") {
		return field === "x" || field === "y" || field === "z" ? pose.location[field] : undefined;
	}
	return field === "pitch" || field === "yaw" ? pose.rotation[field] : undefined;
}

export function MapReviewAuthoring(props: {
	readonly client: MapReviewClient;
	readonly onApproved: () => Promise<void>;
}) {
	const [state, setState] = createSignal<AuthoringState>({ status: "idle" });
	const [selectedId, setSelectedId] = createSignal<string>();
	const [discarded, setDiscarded] = createSignal<ReadonlySet<string>>(new Set<string>());
	const [draftPose, setDraftPose] = createSignal<MapReviewPose>();
	const [manualReason, setManualReason] = createSignal("");
	let disposed = false;
	let generation = 0;
	onCleanup(() => {
		disposed = true;
		generation += 1;
	});
	const session = createMemo(() => {
		const current = state();
		return current.status === "ready" ||
			current.status === "saving" ||
			current.status === "approved"
			? current.session
			: undefined;
	});
	const candidates = createMemo(
		() => session()?.candidates.filter((candidate) => !discarded().has(candidate.id)) ?? []
	);
	const selected = createMemo(
		() => candidates().find((candidate) => candidate.id === selectedId()) ?? candidates()[0]
	);

	const select = (candidate: MapReviewAuthoringCandidate) => {
		setSelectedId(candidate.id);
		setDraftPose(structuredClone(candidate.pose));
		setManualReason("");
	};
	const hydratePreviews = async (initial: ReadyAuthoring, activeGeneration: number) => {
		for (const candidate of initial.candidates) {
			const result = await props.client.previewCandidate(candidate.id);
			if (disposed || activeGeneration !== generation) return;
			setState((current) => {
				if (
					current.status !== "ready" &&
					current.status !== "saving" &&
					current.status !== "approved"
				) {
					return current;
				}
				return {
					...current,
					session: {
						...current.session,
						candidates: current.session.candidates.map((currentCandidate) =>
							currentCandidate.id === candidate.id
								? {
										...currentCandidate,
										preview:
											result.status === "ready"
												? result
												: {
														message: result.error.message,
														status: "failed" as const
													}
									}
								: currentCandidate
						)
					}
				};
			});
		}
	};
	const generate = async () => {
		const activeGeneration = ++generation;
		setState({ status: "loading" });
		const result = await props.client.authorFromSelection();
		if (disposed || activeGeneration !== generation) return;
		if (result.status === "failed") {
			setState({
				message: result.error.message,
				recovery: result.error.recovery,
				status: "failed"
			});
			return;
		}
		setDiscarded(new Set<string>());
		setState({ session: result, status: "ready" });
		const first = result.candidates[0];
		if (first) select(first);
		void hydratePreviews(result, activeGeneration);
	};
	const discard = (candidateId: string) => {
		setDiscarded((current) => new Set([...current, candidateId]));
		if (selectedId() === candidateId) {
			const next = candidates().find((candidate) => candidate.id !== candidateId);
			if (next) select(next);
		}
	};
	const updateNumber = (
		section: "location" | "rotation" | "pose",
		field: "x" | "y" | "z" | "pitch" | "yaw" | "fieldOfViewDegrees",
		value: string
	) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		setDraftPose((current) => {
			if (!current) return current;
			if (section === "pose") return { ...current, fieldOfViewDegrees: parsed };
			return { ...current, [section]: { ...current[section], [field]: parsed } };
		});
	};
	const approve = async () => {
		const activeSession = session();
		const candidate = selected();
		const pose = draftPose();
		if (!activeSession || !candidate || !pose) return;
		setState({ session: activeSession, status: "saving" });
		const adjusted = !samePose(candidate.pose, pose);
		const result = await props.client.approveCandidate({
			candidateId: candidate.id,
			candidatePose: candidate.pose,
			...(adjusted ? { manualPose: pose } : {}),
			...(adjusted
				? { manualReason: manualReason().trim() || "Adjusted in Map Review authoring" }
				: {}),
			sourceActorPath: activeSession.selection.actorPath,
			viewId: activeSession.viewId
		});
		if (result.status === "failed") {
			setState({
				message: result.error.message,
				recovery: result.error.recovery,
				status: "failed"
			});
			return;
		}
		setState({ candidateId: result.candidateId, session: activeSession, status: "approved" });
		await props.onApproved();
	};

	return (
		<section aria-label="Review View authoring" {...stylex.props(styles.authoringDesk)}>
			<div {...stylex.props(styles.authoringHeader)}>
				<div>
					<p>SPATIAL AUTHORING / TRANSIENT CAMERA</p>
					<h2>Frame what matters.</h2>
					<span>
						Selection and bounds come from Unreal. Approved views remain outside the
						map.
					</span>
				</div>
				<button
					type="button"
					disabled={state().status === "loading" || state().status === "saving"}
					onClick={() => void generate()}
					{...stylex.props(styles.generateButton)}
				>
					{state().status === "loading" ? "GENERATING…" : "REFRAME SELECTED ACTOR"}
				</button>
			</div>

			<Show when={state().status === "idle"}>
				<div {...stylex.props(styles.emptyAuthoring)}>
					<span>01</span>
					<p>
						Select one actor in the Level Editor, then generate bounded candidate views.
					</p>
				</div>
			</Show>
			<Show when={state().status === "failed"}>
				{(() => {
					const current = state();
					if (current.status !== "failed") return null;
					return (
						<div role="alert" {...stylex.props(styles.authoringError)}>
							<strong>{current.message}</strong>
							<span>{current.recovery}</span>
						</div>
					);
				})()}
			</Show>
			<Show when={session()}>
				{(activeSession) => (
					<div {...stylex.props(styles.authoringBody)}>
						<div {...stylex.props(styles.selectionLine)}>
							<span>SELECTED SUBJECT</span>
							<strong>{activeSession().selection.displayName}</strong>
							<code>{activeSession().selection.actorPath}</code>
						</div>
						<div
							aria-label="Framing candidates"
							role="region"
							{...stylex.props(styles.contactSheet)}
						>
							<For each={candidates()}>
								{(candidate, index) => (
									<article
										{...stylex.props(
											styles.candidateCard,
											selected()?.id === candidate.id &&
												styles.candidateSelected
										)}
									>
										<button
											type="button"
											aria-label={`Select ${candidate.displayName}`}
											onClick={() => select(candidate)}
											{...stylex.props(styles.candidateSelect)}
										>
											<CandidateImage candidate={candidate} />
											<div {...stylex.props(styles.candidateMeta)}>
												<span {...stylex.props(styles.candidateIndex)}>
													{String(index() + 1).padStart(2, "0")}
												</span>
												<div {...stylex.props(styles.candidateCopy)}>
													<strong>{candidate.displayName}</strong>
													<small>
														{candidate.preset.replaceAll("_", " ")}
													</small>
												</div>
											</div>
										</button>
										<button
											type="button"
											onClick={() => discard(candidate.id)}
											{...stylex.props(styles.discardButton)}
										>
											DISCARD
										</button>
									</article>
								)}
							</For>
						</div>
						<Show when={selected()}>
							{(candidate) => (
								<div {...stylex.props(styles.approvalBench)}>
									<div>
										<p>
											APPROVED POSE / {candidate().displayName.toUpperCase()}
										</p>
										<div {...stylex.props(styles.poseGrid)}>
											<For
												each={
													[
														["X", "location", "x"],
														["Y", "location", "y"],
														["Z", "location", "z"],
														["PITCH", "rotation", "pitch"],
														["YAW", "rotation", "yaw"],
														["FOV", "pose", "fieldOfViewDegrees"]
													] as const
												}
											>
												{([label, section, field]) => (
													<label {...stylex.props(styles.poseField)}>
														<span>{label}</span>
														<input
															type="number"
															step="0.1"
															value={poseFieldValue(
																draftPose(),
																section,
																field
															)}
															{...stylex.props(styles.poseInput)}
															onInput={(event) =>
																updateNumber(
																	section,
																	field,
																	event.currentTarget.value
																)
															}
														/>
													</label>
												)}
											</For>
										</div>
										<label {...stylex.props(styles.reasonField)}>
											<span>MANUAL ADJUSTMENT NOTE</span>
											<input
												value={manualReason()}
												{...stylex.props(styles.poseInput)}
												onInput={(event) =>
													setManualReason(event.currentTarget.value)
												}
												placeholder="Why did this framing need art direction?"
											/>
										</label>
									</div>
									<div {...stylex.props(styles.approveColumn)}>
										<span>NO MAP ACTOR WILL BE CREATED</span>
										<button
											type="button"
											disabled={state().status === "saving"}
											onClick={() => void approve()}
											{...stylex.props(styles.keepButton)}
										>
											{state().status === "saving" ? "SAVING…" : "KEEP VIEW"}
										</button>
										<Show when={state().status === "approved"}>
											<strong {...stylex.props(styles.savedMark)}>
												APPROVED + SAVED
											</strong>
										</Show>
									</div>
								</div>
							)}
						</Show>
					</div>
				)}
			</Show>
		</section>
	);
}

const styles = stylex.create({
	authoringDesk: {
		marginTop: 14,
		border: "1px solid #39413c",
		backgroundColor: "#101311",
		boxShadow: "inset 4px 0 #b9f227"
	},
	authoringHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "end",
		gap: 24,
		padding: "18px 20px",
		borderBottom: "1px solid #303632"
	},
	generateButton: {
		border: "1px solid #899881",
		backgroundColor: { default: "transparent", ":hover": "#20271f" },
		color: "#d8ded7",
		padding: "10px 14px",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".11em",
		cursor: { default: "pointer", ":disabled": "wait" }
	},
	emptyAuthoring: { display: "flex", gap: 16, padding: 20, color: "#7e8881" },
	authoringError: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: 20,
		color: "#e9967b"
	},
	authoringBody: { padding: 14 },
	selectionLine: {
		display: "grid",
		gridTemplateColumns: "150px 180px minmax(0, 1fr)",
		gap: 12,
		alignItems: "center",
		padding: "9px 12px",
		backgroundColor: "#181d19",
		color: "#a4ada7",
		fontSize: 9
	},
	contactSheet: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 8,
		marginTop: 10
	},
	candidateCard: {
		position: "relative",
		border: "1px solid #303732",
		backgroundColor: "#090b0a"
	},
	candidateSelected: { borderColor: "#b9f227", boxShadow: "0 0 0 1px #b9f227" },
	candidateSelect: {
		width: "100%",
		border: 0,
		backgroundColor: "transparent",
		color: "#dce1dc",
		textAlign: "left",
		padding: 0,
		cursor: "pointer"
	},
	candidateImage: { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block" },
	previewFailure: {
		aspectRatio: "16 / 9",
		display: "flex",
		flexDirection: "column",
		justifyContent: "center",
		alignItems: "center",
		gap: 5,
		padding: 12,
		color: "#9d7062",
		backgroundImage: "repeating-linear-gradient(-45deg,#111,#111 8px,#161916 8px,#161916 9px)"
	},
	candidateIndex: {
		color: "#b9f227",
		fontSize: 9
	},
	candidateMeta: {
		display: "grid",
		gridTemplateColumns: "24px 1fr",
		gap: 8,
		padding: "9px 10px"
	},
	candidateCopy: { display: "flex", flexDirection: "column", gap: 3 },
	discardButton: {
		position: "absolute",
		top: 6,
		right: 6,
		border: "1px solid #606861",
		backgroundColor: "#0b0d0bcc",
		color: "#abb2ac",
		fontSize: 7,
		padding: "5px 6px",
		cursor: "pointer"
	},
	approvalBench: {
		display: "grid",
		gridTemplateColumns: "minmax(0, 1fr) 190px",
		gap: 18,
		marginTop: 10,
		padding: 16,
		border: "1px solid #39413c",
		backgroundColor: "#171b18"
	},
	poseGrid: { display: "grid", gridTemplateColumns: "repeat(6, minmax(70px, 1fr))", gap: 7 },
	poseField: { display: "grid", gap: 4, color: "#a9b2ab", fontSize: 8 },
	poseInput: {
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid #465048",
		backgroundColor: "#0b0e0c",
		color: "#edf1ed",
		padding: "7px 8px",
		fontFamily: "inherit",
		fontSize: 10,
		outline: { ":focus": "1px solid #b9f227" }
	},
	reasonField: { display: "grid", gap: 5, marginTop: 10 },
	approveColumn: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "end",
		gap: 10,
		fontSize: 8
	},
	keepButton: {
		border: "1px solid #b9f227",
		backgroundColor: { default: "#b9f227", ":hover": "#d1ff53", ":disabled": "#526130" },
		color: "#10130c",
		fontWeight: 900,
		padding: 12,
		cursor: { default: "pointer", ":disabled": "wait" }
	},
	savedMark: { color: "#b9f227", letterSpacing: ".09em" }
});

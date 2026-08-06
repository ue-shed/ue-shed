import * as stylex from "@stylexjs/stylex";
import {
	defaultFramingParameters,
	type FramingCandidateOverride,
	type FramingParameters
} from "@ue-shed/cameras";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { Cause, Effect, Stream } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
	MapReviewAuthoringCandidate,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewClientShape,
	MapReviewLiveFrame,
	MapReviewPose
} from "./map-review-client.js";
import type { ObservedActor } from "@ue-shed/observatory";
import { FramingSettings } from "./framing-settings.js";

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
type CandidateId = MapReviewAuthoringCandidate["id"];
type AuthoringPatch = Parameters<MapReviewClientShape["authoringPatch"]>[0]["patch"];

function clampPreviewFps(fps: number): number {
	return Math.min(10, Math.max(1, Math.round(fps)));
}

function CandidateImage(props: { readonly candidate: MapReviewAuthoringCandidate }) {
	const [canvasEl, setCanvasEl] = createSignal<HTMLCanvasElement>();
	let rgba = new Uint8ClampedArray(0);
	let imageData: ImageData | undefined;
	const [pngUrl, setPngUrl] = createSignal<string>();
	const preview = createMemo(() => props.candidate.preview);
	const isLive = createMemo(() => {
		const current = preview();
		return current.status === "ready" && current.pixelFormat === "bgra8";
	});
	const isPng = createMemo(() => {
		const current = preview();
		return (
			current.status === "ready" &&
			(current.pixelFormat === "png" || current.pixelFormat === undefined)
		);
	});

	createEffect(() => {
		const current = preview();
		const canvas = canvasEl();
		if (current.status !== "ready" || current.pixelFormat !== "bgra8" || !canvas) return;
		const context = canvas.getContext("2d", { alpha: false });
		if (!context) return;
		if (canvas.width !== current.width || canvas.height !== current.height) {
			canvas.width = current.width;
			canvas.height = current.height;
			rgba = new Uint8ClampedArray(current.bytes.byteLength);
			imageData = new ImageData(rgba, current.width, current.height);
		}
		for (let offset = 0; offset < current.bytes.byteLength; offset += 4) {
			rgba[offset] = current.bytes[offset + 2] ?? 0;
			rgba[offset + 1] = current.bytes[offset + 1] ?? 0;
			rgba[offset + 2] = current.bytes[offset] ?? 0;
			rgba[offset + 3] = 255;
		}
		if (imageData) context.putImageData(imageData, 0, 0);
	});

	createEffect(() => {
		const current = preview();
		if (
			current.status !== "ready" ||
			current.pixelFormat === "bgra8" ||
			(current.pixelFormat !== "png" && current.pixelFormat !== undefined)
		) {
			setPngUrl(undefined);
			return;
		}
		const bytes = Uint8Array.from(current.bytes);
		const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" }));
		setPngUrl(url);
		onCleanup(() => URL.revokeObjectURL(url));
	});

	return (
		<>
			<Show when={isLive()}>
				<canvas
					ref={setCanvasEl}
					aria-label={`${props.candidate.displayName} live preview`}
					{...stylex.props(styles.candidateImage)}
				/>
			</Show>
			<Show when={isPng() ? pngUrl() : undefined}>
				{(url) => (
					<img
						src={url()}
						alt={`${props.candidate.displayName} candidate preview`}
						{...stylex.props(styles.candidateImage)}
					/>
				)}
			</Show>
			{(() => {
				const current = preview();
				if (current.status === "ready") return null;
				return (
					<div {...stylex.props(styles.previewFailure)}>
						<span>
							{current.status === "pending"
								? "RENDERING PREVIEW"
								: "PREVIEW UNAVAILABLE"}
						</span>
						<small>
							{current.status === "failed"
								? current.message
								: "Waiting for the first frame."}
						</small>
					</div>
				);
			})()}
		</>
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
	readonly client: MapReviewClientShape;
	readonly focusRequest?:
		| {
				readonly actor: ObservedActor;
				readonly nonce: number;
		  }
		| undefined;
	readonly onApproved: () => void;
}) {
	const generateAction = createEffectAction();
	const previewSubscription = createEffectSubscription();
	const liveFrameSubscription = createEffectSubscription();
	const fpsAction = createEffectAction();
	const approveAction = createEffectAction();
	const resumeAction = createEffectAction();
	const patchAction = createEffectAction();
	const framingPatchAction = createEffectAction();
	const [state, setState] = createSignal<AuthoringState>({ status: "idle" });
	const [selectedId, setSelectedId] = createSignal<CandidateId>();
	const [discarded, setDiscarded] = createSignal<ReadonlySet<CandidateId>>(
		new Set<CandidateId>()
	);
	const [draftPose, setDraftPose] = createSignal<MapReviewPose>();
	const [manualReason, setManualReason] = createSignal("");
	const [liveFps, setLiveFps] = createSignal(5);
	const [framingParameters, setFramingParameters] = createSignal<FramingParameters>(
		defaultFramingParameters()
	);
	const [candidateOverrides, setCandidateOverrides] = createSignal<
		readonly FramingCandidateOverride[]
	>([]);
	const [liveBindings, setLiveBindings] = createSignal<ReadonlyMap<string, number>>(new Map());
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
	const liveStreaming = createMemo(() => liveBindings().size > 0);
	const authoringBlocked = createMemo(() => {
		const durable = session()?.session;
		if (durable && durable.lifecycle !== "active") return true;
		return (
			selected()?.diagnostics.some((diagnostic) => diagnostic.severity === "warning") ?? false
		);
	});
	const activate = (result: ReadyAuthoring) => {
		const durable = result.session;
		setFramingParameters(durable?.framingParameters ?? defaultFramingParameters());
		setCandidateOverrides(durable?.candidateOverrides ?? []);
		setDiscarded(new Set(durable?.discardedCandidateIds ?? []));
		setSelectedId(durable?.selectedCandidateId ?? result.candidates[0]?.id);
		setDraftPose(durable?.draftPose ?? structuredClone(result.candidates[0]?.pose));
		setManualReason(durable?.manualReason ?? "");
		setLiveBindings(new Map());
		setState({ session: result, status: "ready" });
		hydratePreviews(result);
	};
	const persist = (
		patch: AuthoringPatch,
		options: { readonly refreshPreviews?: boolean } = {}
	) => {
		const durable = session()?.session;
		if (!durable || durable.lifecycle !== "active") return;
		patchAction.run(props.client.authoringPatch({ patch, sessionId: durable.id }), {
			onFailure: () => undefined,
			onSuccess: (result) => {
				if (result.status !== "ready") return;
				if (options.refreshPreviews) {
					activate(result);
					return;
				}
				const durableSession = result.session;
				setDiscarded(new Set(durableSession?.discardedCandidateIds ?? []));
				setSelectedId(durableSession?.selectedCandidateId ?? result.candidates[0]?.id);
				setDraftPose(
					durableSession?.draftPose ?? structuredClone(result.candidates[0]?.pose)
				);
				setManualReason(durableSession?.manualReason ?? "");
				setState((current) => {
					if (
						current.status !== "ready" &&
						current.status !== "saving" &&
						current.status !== "approved"
					) {
						return { session: result, status: "ready" };
					}
					const previousPreviews = new Map(
						current.session.candidates.map((candidate) => [
							candidate.id,
							candidate.preview
						])
					);
					return {
						session: {
							...result,
							candidates: result.candidates.map((candidate) => ({
								...candidate,
								preview: previousPreviews.get(candidate.id) ?? candidate.preview
							}))
						},
						status: "ready"
					};
				});
			}
		});
	};
	const currentPatch = (
		overrides: {
			readonly discardedCandidateIds?: ReadonlyArray<CandidateId>;
			readonly draftPose?: MapReviewPose;
			readonly manualReason?: string;
			readonly selectedCandidateId?: CandidateId;
		} = {}
	): AuthoringPatch => {
		const nextDraftPose = overrides.draftPose ?? draftPose();
		const nextSelectedId = overrides.selectedCandidateId ?? selectedId();
		const discardedCandidateIds = (overrides.discardedCandidateIds ?? [
			...discarded()
		]) as AuthoringPatch["discardedCandidateIds"];
		const selectedCandidateId = nextSelectedId as AuthoringPatch["selectedCandidateId"];
		return {
			discardedCandidateIds,
			manualReason: overrides.manualReason ?? manualReason(),
			...(nextDraftPose === undefined ? {} : { draftPose: nextDraftPose }),
			...(selectedCandidateId === undefined ? {} : { selectedCandidateId })
		};
	};
	const scheduleFramingPatch = (args: {
		readonly candidateOverrides: readonly FramingCandidateOverride[];
		readonly parameters: FramingParameters;
	}) => {
		framingPatchAction.run(
			Effect.sleep("400 millis").pipe(
				Effect.tap(() =>
					Effect.sync(() =>
						persist(
							{
								...currentPatch(),
								candidateOverrides: args.candidateOverrides,
								framingParameters: args.parameters
							},
							{ refreshPreviews: true }
						)
					)
				)
			),
			{ onSuccess: () => undefined }
		);
	};

	const select = (candidate: MapReviewAuthoringCandidate) => {
		setSelectedId(candidate.id);
		setDraftPose(structuredClone(candidate.pose));
		setManualReason("");
		persist(
			currentPatch({
				draftPose: structuredClone(candidate.pose),
				manualReason: "",
				selectedCandidateId: candidate.id
			})
		);
	};
	const applyPreviewResult = (
		candidateId: CandidateId,
		result: MapReviewCandidatePreviewResult
	) => {
		if (
			result.status === "ready" &&
			result.pixelFormat === "bgra8" &&
			result.cameraIndex !== undefined
		) {
			setLiveBindings((current) => {
				const next = new Map(current);
				next.set(candidateId, result.cameraIndex as number);
				return next;
			});
		} else {
			setLiveBindings((current) => {
				if (!current.has(candidateId)) return current;
				const next = new Map(current);
				next.delete(candidateId);
				return next;
			});
		}
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
						currentCandidate.id === candidateId
							? {
									...currentCandidate,
									...(result.status === "ready" && result.diagnostics
										? { diagnostics: result.diagnostics }
										: {}),
									preview:
										result.status === "ready"
											? {
													bytes: result.bytes,
													height: result.height,
													...(result.cameraIndex === undefined
														? {}
														: { cameraIndex: result.cameraIndex }),
													...(result.pixelFormat === undefined
														? {}
														: { pixelFormat: result.pixelFormat }),
													status: "ready" as const,
													width: result.width
												}
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
	};
	const applyLiveFrames = (frames: ReadonlyMap<number, MapReviewLiveFrame>) => {
		const bindings = liveBindings();
		if (bindings.size === 0 || frames.size === 0) return;
		setState((current) => {
			if (
				current.status !== "ready" &&
				current.status !== "saving" &&
				current.status !== "approved"
			) {
				return current;
			}
			let changed = false;
			const candidatesNext = current.session.candidates.map((candidate) => {
				const cameraIndex = bindings.get(candidate.id);
				if (cameraIndex === undefined) return candidate;
				const frame = frames.get(cameraIndex);
				if (frame === undefined) return candidate;
				changed = true;
				return {
					...candidate,
					preview: {
						bytes: frame.pixels,
						cameraIndex,
						height: frame.height,
						pixelFormat: "bgra8" as const,
						status: "ready" as const,
						width: frame.width
					}
				};
			});
			if (!changed) return current;
			return {
				...current,
				session: {
					...current.session,
					candidates: candidatesNext
				}
			};
		});
	};
	const hydratePreviews = (initial: ReadyAuthoring) => {
		previewSubscription.subscribe(
			Stream.fromIterable(initial.candidates).pipe(
				Stream.mapEffect(
					(candidate) =>
						(initial.session
							? props.client.previewAuthoringCandidate({
									candidateId: candidate.id,
									sessionId: initial.session.id
								})
							: props.client.previewCandidate(candidate.id)
						).pipe(Effect.map((result) => ({ candidateId: candidate.id, result }))),
					{ concurrency: 4, unordered: true }
				)
			),
			{
				onFailure: () => undefined,
				onValue: ({ candidateId, result }) => {
					applyPreviewResult(candidateId as CandidateId, result);
				}
			}
		);
	};
	createEffect(() => {
		const bindings = liveBindings();
		const fps = liveFps();
		liveFrameSubscription.cancel();
		if (bindings.size === 0) return;
		const intervalMs = 1_000 / fps;
		let lastPaint = 0;
		const pending = new Map<number, MapReviewLiveFrame>();
		liveFrameSubscription.subscribe(props.client.liveFrames, {
			onFailure: () => undefined,
			onValue: (frame) => {
				const bound = [...bindings.values()].includes(frame.cameraIndex);
				if (!bound) return;
				pending.set(frame.cameraIndex, frame);
				const now = performance.now();
				if (now - lastPaint < intervalMs) return;
				lastPaint = now;
				const batch = new Map(pending);
				pending.clear();
				applyLiveFrames(batch);
			}
		});
		onCleanup(() => liveFrameSubscription.cancel());
	});
	const updateLiveFps = (value: number) => {
		const next = clampPreviewFps(value);
		setLiveFps(next);
		fpsAction.run(props.client.setLivePreviewFps(next), {
			onFailure: () => undefined,
			onSuccess: (applied) => setLiveFps(applied)
		});
	};
	const generate = () => {
		const durable = session()?.session;
		setState({ status: "loading" });
		generateAction.run(
			durable && durable.lifecycle !== "approved" && durable.lifecycle !== "discarded"
				? props.client.authoringReframe({ sessionId: durable.id })
				: props.client.authorFromSelection(),
			{
				onFailure: (cause) =>
					setState({
						message: Cause.pretty(cause),
						recovery:
							"Restart Workbench. If the problem persists, verify package versions.",
						status: "failed"
					}),
				onSuccess: (result) => {
					if (result.status === "failed") {
						setState({
							message: result.error.message,
							recovery: result.error.recovery,
							status: "failed"
						});
						return;
					}
					activate(result);
				}
			}
		);
	};
	onMount(() => {
		resumeAction.run(props.client.authoringResume(), {
			onFailure: () => undefined,
			onSuccess: (result) => {
				if (result.status === "ready") activate(result);
			}
		});
	});
	let handledFocusNonce = 0;
	createEffect(() => {
		const request = props.focusRequest;
		if (request === undefined || request.nonce <= handledFocusNonce) return;
		handledFocusNonce = request.nonce;
		generate();
	});
	const discard = (candidateId: string) => {
		const nextDiscarded = new Set([...discarded(), candidateId]);
		setDiscarded(nextDiscarded);
		if (selectedId() === candidateId) {
			const next = candidates().find((candidate) => candidate.id !== candidateId);
			if (next) select(next);
		}
		persist(currentPatch({ discardedCandidateIds: [...nextDiscarded] }));
	};
	const updateNumber = (
		section: "location" | "rotation" | "pose",
		field: "x" | "y" | "z" | "pitch" | "yaw" | "fieldOfViewDegrees",
		value: string
	) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		const current = draftPose();
		if (!current) return;
		const next =
			section === "pose"
				? { ...current, fieldOfViewDegrees: parsed }
				: { ...current, [section]: { ...current[section], [field]: parsed } };
		setDraftPose(next);
		persist(currentPatch({ draftPose: next }));
	};
	const approve = () => {
		const activeSession = session();
		const candidate = selected();
		const pose = draftPose();
		if (!activeSession || !candidate || !pose) return;
		setState({ session: activeSession, status: "saving" });
		const adjusted = !samePose(candidate.pose, pose);
		const durable = activeSession.session;
		approveAction.run(
			durable
				? props.client.approveAuthoring({ sessionId: durable.id })
				: props.client.approveCandidate({
						candidateId: candidate.id,
						candidatePose: candidate.pose,
						...(adjusted ? { manualPose: pose } : {}),
						...(adjusted
							? {
									manualReason:
										manualReason().trim() || "Adjusted in Map Review authoring"
								}
							: {}),
						sourceActorPath: activeSession.selection.actorPath,
						viewId: activeSession.viewId
					}),
			{
				onFailure: (cause) =>
					setState({
						message: Cause.pretty(cause),
						recovery:
							"Restart Workbench. If the problem persists, verify package versions.",
						status: "failed"
					}),
				onSuccess: (result) => {
					if (result.status === "failed") {
						setState({
							message: result.error.message,
							recovery: result.error.recovery,
							status: "failed"
						});
						return;
					}
					setState({
						candidateId: result.candidateId,
						session: activeSession,
						status: "approved"
					});
					props.onApproved();
				}
			}
		);
	};

	return (
		<section aria-label="Review View authoring" {...stylex.props(styles.authoringDesk)}>
			<div {...stylex.props(styles.authoringHeader)}>
				<div {...stylex.props(styles.headerSubject)}>
					<span {...stylex.props(styles.headerLabel)}>SUBJECT</span>
					<Show
						when={session()}
						fallback={<strong>Select an actor, then reframe</strong>}
					>
						{(active) => (
							<>
								<strong>{active().selection.displayName}</strong>
								<code {...stylex.props(styles.headerPath)}>
									{active().selection.actorPath}
								</code>
							</>
						)}
					</Show>
				</div>
				<div {...stylex.props(styles.headerActions)}>
					<button
						type="button"
						disabled={state().status === "loading" || state().status === "saving"}
						onClick={() => void generate()}
						{...stylex.props(styles.generateButton)}
					>
						{state().status === "loading" ? "GENERATING…" : "REFRAME SELECTED ACTOR"}
					</button>
					<Show when={liveStreaming()}>
						<label {...stylex.props(styles.fpsControl)}>
							<span>LIVE {liveFps()} FPS</span>
							<input
								type="range"
								min={1}
								max={10}
								step={1}
								value={liveFps()}
								aria-label="Live preview frame rate"
								onInput={(event) =>
									updateLiveFps(
										Number((event.currentTarget as HTMLInputElement).value)
									)
								}
							/>
						</label>
					</Show>
				</div>
			</div>

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
				<div {...stylex.props(styles.authoringBody)}>
					<FramingSettings
						parameters={framingParameters()}
						candidateOverrides={candidateOverrides()}
						selectedCandidateId={selectedId()}
						onParametersChange={(parameters) => {
							setFramingParameters(parameters);
							scheduleFramingPatch({
								candidateOverrides: candidateOverrides(),
								parameters
							});
						}}
						onCandidateOverridesChange={(overrides) => {
							setCandidateOverrides(overrides);
							scheduleFramingPatch({
								candidateOverrides: overrides,
								parameters: framingParameters()
							});
						}}
					/>
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
										selected()?.id === candidate.id && styles.candidateSelected
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
									<p>APPROVED POSE / {candidate().displayName.toUpperCase()}</p>
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
											onInput={(event) => {
												const next = event.currentTarget.value;
												setManualReason(next);
												persist(currentPatch({ manualReason: next }));
											}}
											placeholder="Why did this framing need art direction?"
										/>
									</label>
								</div>
								<div {...stylex.props(styles.approveColumn)}>
									<span>
										Keeps a Review View only — does not spawn a map actor
									</span>
									<Show when={candidate().diagnostics.length > 0}>
										<div role="status" {...stylex.props(styles.diagnosticList)}>
											<For each={candidate().diagnostics}>
												{(diagnostic) => (
													<span>
														{diagnostic.severity.toUpperCase()} /{" "}
														{diagnostic.message}
													</span>
												)}
											</For>
										</div>
									</Show>
									<Show when={authoringBlocked()}>
										<small {...stylex.props(styles.reframeNotice)}>
											Reframe before keeping this view. The persisted subject
											or the framing evidence needs attention.
										</small>
									</Show>
									<button
										type="button"
										disabled={state().status === "saving" || authoringBlocked()}
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
			</Show>
		</section>
	);
}

const styles = stylex.create({
	authoringDesk: {
		marginTop: 8,
		border: "1px solid #39413c",
		backgroundColor: "#101311"
	},
	authoringHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 16,
		padding: "8px 12px",
		borderBottom: "1px solid #303632"
	},
	headerSubject: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		minWidth: 0,
		flex: 1,
		color: "#c5cbc4",
		fontSize: 12
	},
	headerLabel: {
		flexShrink: 0,
		color: "#7e8881",
		fontSize: 9,
		letterSpacing: ".1em"
	},
	headerPath: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: "#7e8881",
		fontSize: 10
	},
	headerActions: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		flexShrink: 0
	},
	generateButton: {
		flexShrink: 0,
		border: "1px solid #899881",
		backgroundColor: { default: "transparent", ":hover": "#20271f" },
		color: "#d8ded7",
		padding: "8px 12px",
		fontSize: 9,
		fontWeight: 800,
		letterSpacing: ".11em",
		cursor: { default: "pointer", ":disabled": "wait" }
	},
	fpsControl: {
		display: "grid",
		gap: 4,
		alignItems: "center",
		minWidth: 140,
		color: "#9aa59a",
		fontSize: 8,
		fontWeight: 700,
		letterSpacing: ".1em"
	},
	authoringError: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "10px 12px",
		color: "#e9967b"
	},
	authoringBody: { padding: 10 },
	contactSheet: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 8
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
	diagnosticList: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		color: "#d3d9d2",
		lineHeight: 1.35
	},
	reframeNotice: { color: "#e4aa79", lineHeight: 1.35 },
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

import * as stylex from "@stylexjs/stylex";
import {
	defaultFramingParameters,
	FramingCandidateId,
	type FramingCandidateOverride,
	type FramingParameters
} from "@ue-shed/cameras";
import { createEffectAction, createEffectSubscription } from "@ue-shed/ui";
import { tokens } from "@ue-shed/ui-theme/tokens.stylex.js";
import { Cause, Effect, Schedule, Stream } from "effect";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type {
	MapReviewAuthoringCandidate,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringResult,
	MapReviewApprovalResult,
	MapReviewCandidatePreviewResult,
	MapReviewClientApi,
	MapReviewLiveFrame,
	MapReviewPose
} from "./map-review-client.js";
import type { ObservedActor } from "@ue-shed/observatory";
import { FramingSettings } from "./framing-settings.js";
import { ScrubbableNumberField } from "./scrubbable-number-field.js";

type AuthoringState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "saving"; readonly session: ReadyAuthoring }
	| { readonly status: "ready"; readonly session: ReadyAuthoring }
	| { readonly status: "map_mismatch"; readonly mismatch: MapMismatch }
	| { readonly status: "failed"; readonly message: string; readonly recovery: string }
	| {
			readonly status: "approved";
			readonly session: ReadyAuthoring;
			readonly candidateId: string;
			readonly keptCount: number;
	  };

type ReadyAuthoring = Extract<MapReviewAuthoringResult, { status: "ready" }>;
type MapMismatch = Extract<MapReviewAuthoringResult, { status: "map_mismatch" }>;
type CandidateId = MapReviewAuthoringCandidate["id"];
type AuthoringPatch = Parameters<MapReviewClientApi["authoringPatch"]>[0]["patch"];
type PreviewRefresh =
	| { readonly kind: "all" }
	| { readonly candidateId: CandidateId; readonly kind: "candidate" };

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
	readonly client: MapReviewClientApi;
	readonly destination?: MapReviewAuthorFromSelectionIntent["destination"];
	readonly focusRequest?:
		| {
				readonly actor: ObservedActor;
				readonly nonce: number;
		  }
		| undefined;
	readonly onApproved: () => void;
	readonly onChooseReviewSet?: (() => void) | undefined;
}) {
	const generateAction = createEffectAction();
	const previewSubscription = createEffectSubscription();
	const selectedPreviewAction = createEffectAction();
	const liveFrameSubscription = createEffectSubscription();
	const liveCapabilitySubscription = createEffectSubscription();
	const fpsAction = createEffectAction();
	const approveAction = createEffectAction();
	const resumeAction = createEffectAction();
	const reviewSetAction = createEffectAction();
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
	const pngFallback = createMemo(() =>
		candidates().some(
			(candidate) =>
				candidate.preview.status === "ready" && candidate.preview.pixelFormat !== "bgra8"
		)
	);
	const liveContextLabel = createMemo(() => {
		const livePreview = candidates().find(
			(candidate) =>
				candidate.preview.status === "ready" && candidate.preview.pixelFormat === "bgra8"
		)?.preview;
		if (livePreview?.status !== "ready") return "LIVE";
		return livePreview.previewContext === "editor_live"
			? "EDITOR LIVE"
			: livePreview.previewContext === "play_live"
				? "PLAY LIVE"
				: "LIVE";
	});
	const keepsContactSheet = createMemo(() => session()?.session?.pendingReviewSet !== undefined);
	const keepLabel = createMemo(() => {
		if (!keepsContactSheet()) return "KEEP VIEW";
		const count = candidates().length;
		return `KEEP ${count} ${count === 1 ? "VIEW" : "VIEWS"}`;
	});
	const keepSummary = createMemo(() => {
		if (!keepsContactSheet()) {
			return "Keeps this Review View only — does not spawn a map actor";
		}
		const count = candidates().length;
		return count === 1
			? "Keeps the remaining preview as a Review View for this actor"
			: `Keeps all ${count} remaining previews as Review Views for this actor`;
	});
	const authoringBlocked = createMemo(() => {
		const durable = session()?.session;
		return durable !== undefined && durable.lifecycle !== "active";
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
		options: { readonly refreshPreviews?: PreviewRefresh } = {}
	) => {
		const durable = session()?.session;
		if (!durable || durable.lifecycle !== "active") return;
		patchAction.run(props.client.authoringPatch({ patch, sessionId: durable.id }), {
			onFailure: () => undefined,
			onSuccess: (result) => {
				if (result.status !== "ready") return;
				const durableSession = result.session;
				setFramingParameters(
					durableSession?.framingParameters ?? defaultFramingParameters()
				);
				setCandidateOverrides(durableSession?.candidateOverrides ?? []);
				setDiscarded(new Set(durableSession?.discardedCandidateIds ?? []));
				const nextSelectedId =
					durableSession?.selectedCandidateId ?? result.candidates[0]?.id;
				const nextSelected = result.candidates.find(
					(candidate) => candidate.id === nextSelectedId
				);
				setSelectedId(nextSelectedId);
				setDraftPose(durableSession?.draftPose ?? structuredClone(nextSelected?.pose));
				setManualReason(durableSession?.manualReason ?? "");
				setState((current) => {
					if (
						current.status !== "ready" &&
						current.status !== "saving" &&
						current.status !== "approved"
					) {
						return { session: result, status: "ready" };
					}
					const previousCandidates = new Map(
						current.session.candidates.map((candidate) => [candidate.id, candidate])
					);
					return {
						session: {
							...result,
							candidates: result.candidates.map((candidate) => {
								const previous = previousCandidates.get(candidate.id);
								if (previous === undefined) return candidate;
								if (
									options.refreshPreviews === undefined ||
									(options.refreshPreviews.kind === "candidate" &&
										options.refreshPreviews.candidateId !== candidate.id)
								) {
									return previous;
								}
								return { ...candidate, preview: previous.preview };
							})
						},
						status: "ready"
					};
				});
				if (options.refreshPreviews?.kind === "all") {
					setLiveBindings(new Map());
					hydratePreviews(result);
				} else if (options.refreshPreviews?.kind === "candidate") {
					hydratePreview(result, options.refreshPreviews.candidateId);
				}
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
		const discardedCandidateIds = (overrides.discardedCandidateIds ?? [...discarded()]).map(
			(candidateId) => FramingCandidateId.make(candidateId)
		);
		const selectedCandidateId =
			nextSelectedId === undefined ? undefined : FramingCandidateId.make(nextSelectedId);
		return {
			discardedCandidateIds,
			manualReason: overrides.manualReason ?? manualReason(),
			...(nextDraftPose === undefined ? undefined : { draftPose: nextDraftPose }),
			...(selectedCandidateId === undefined ? undefined : { selectedCandidateId })
		};
	};
	const scheduleFramingPatch = (args: {
		readonly patch:
			| { readonly candidateOverrides: readonly FramingCandidateOverride[] }
			| { readonly framingParameters: FramingParameters };
		readonly refreshPreviews: PreviewRefresh;
	}) => {
		framingPatchAction.run(
			Effect.sleep("400 millis").pipe(
				Effect.tap(() =>
					Effect.sync(() =>
						persist(
							{
								...currentPatch(),
								...args.patch
							},
							{ refreshPreviews: args.refreshPreviews }
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
			const cameraIndex = result.cameraIndex;
			setLiveBindings((current) => {
				const next = new Map(current);
				next.set(candidateId, cameraIndex);
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
										: undefined),
									preview:
										result.status === "ready"
											? {
													bytes: result.bytes,
													height: result.height,
													...(result.cameraIndex === undefined
														? undefined
														: { cameraIndex: result.cameraIndex }),
													...(result.pixelFormat === undefined
														? undefined
														: { pixelFormat: result.pixelFormat }),
													...(result.previewContext === undefined
														? undefined
														: {
																previewContext:
																	result.previewContext
															}),
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
						...(candidate.preview.status === "ready" &&
						candidate.preview.previewContext !== undefined
							? { previewContext: candidate.preview.previewContext }
							: undefined),
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
					applyPreviewResult(FramingCandidateId.make(candidateId), result);
				}
			}
		);
	};
	const hydratePreview = (initial: ReadyAuthoring, candidateId: CandidateId) => {
		const candidate = initial.candidates.find((item) => item.id === candidateId);
		if (candidate === undefined) return;
		selectedPreviewAction.run(
			(initial.session
				? props.client.previewAuthoringCandidate({
						candidateId: candidate.id,
						sessionId: initial.session.id
					})
				: props.client.previewCandidate(candidate.id)
			).pipe(Effect.map((result) => ({ candidateId: candidate.id, result }))),
			{
				onFailure: () => undefined,
				onSuccess: ({ candidateId: refreshedId, result }) =>
					applyPreviewResult(FramingCandidateId.make(refreshedId), result)
			}
		);
	};
	createEffect(() => {
		const probe = props.client.livePreviewAvailable;
		const active = session();
		const shouldPromote = pngFallback() && !liveStreaming();
		liveCapabilitySubscription.cancel();
		if (probe === undefined || active === undefined || !shouldPromote) return;
		liveCapabilitySubscription.subscribe(
			Stream.fromEffectSchedule(probe(), Schedule.spaced("2 seconds")).pipe(
				Stream.filter((available) => available),
				Stream.take(1)
			),
			{
				onFailure: () => undefined,
				onValue: () => hydratePreviews(active)
			}
		);
		onCleanup(() => liveCapabilitySubscription.cancel());
	});
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
	const generate = (reviewSetMode?: MapReviewAuthorFromSelectionIntent["reviewSetMode"]) => {
		const durable = state().status === "approved" ? undefined : session()?.session;
		setState({ status: "loading" });
		generateAction.run(
			reviewSetMode === undefined &&
				durable &&
				durable.lifecycle !== "approved" &&
				durable.lifecycle !== "discarded"
				? props.client.authoringReframe({ sessionId: durable.id })
				: props.client.authorFromSelection({
						destination: props.destination ?? { kind: "append_view" },
						...(reviewSetMode === undefined ? undefined : { reviewSetMode })
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
					if (result.status === "map_mismatch") {
						setState({ mismatch: result, status: "map_mismatch" });
						return;
					}
					activate(result);
				}
			}
		);
	};
	const openMatchingReviewSet = (mismatch: MapMismatch) => {
		const matching = mismatch.matchingReviewSet;
		if (matching === undefined) return;
		setState({ status: "loading" });
		reviewSetAction.run(props.client.selectReviewSet({ reviewSetId: matching.id }), {
			onFailure: (cause) =>
				setState({
					message: Cause.pretty(cause),
					recovery: "Open the Review Set library and try again.",
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
				setState({ status: "idle" });
				props.onApproved();
			}
		});
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
		value: number,
		commit: boolean
	) => {
		const current = draftPose();
		if (!current) return;
		const next =
			section === "pose"
				? { ...current, fieldOfViewDegrees: value }
				: { ...current, [section]: { ...current[section], [field]: value } };
		setDraftPose(next);
		if (!commit) return;
		const candidateId = selected()?.id;
		persist(
			currentPatch({ draftPose: next }),
			candidateId === undefined ? {} : { refreshPreviews: { candidateId, kind: "candidate" } }
		);
	};
	const approve = () => {
		const activeSession = session();
		const candidate = selected();
		const pose = draftPose();
		if (!activeSession || !candidate || !pose) return;
		const keptCount = keepsContactSheet() ? candidates().length : 1;
		setState({ session: activeSession, status: "saving" });
		const adjusted = !samePose(candidate.pose, pose);
		const durable = activeSession.session;
		if (durable !== undefined) {
			framingPatchAction.cancel();
			patchAction.cancel();
		}
		approveAction.run(
			durable
				? props.client
						.authoringPatch({ patch: currentPatch(), sessionId: durable.id })
						.pipe(
							Effect.flatMap((result) =>
								result.status === "ready"
									? props.client.approveAuthoring({ sessionId: durable.id })
									: Effect.succeed<MapReviewApprovalResult>({
											error:
												result.status === "failed"
													? result.error
													: {
															message:
																"The Review Set changed before approval.",
															recovery: result.recovery
														},
											status: "failed"
										})
							)
						)
				: props.client.approveCandidate({
						candidateId: candidate.id,
						candidatePose: candidate.pose,
						...(adjusted ? { manualPose: pose } : undefined),
						...(adjusted
							? {
									manualReason:
										manualReason().trim() || "Adjusted in Map Review authoring"
								}
							: undefined),
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
						keptCount,
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
						{state().status === "loading"
							? "GENERATING…"
							: state().status !== "approved" &&
								  session()?.session?.lifecycle !== undefined &&
								  session()?.session?.lifecycle !== "approved" &&
								  session()?.session?.lifecycle !== "discarded"
								? "REFRAME SELECTED ACTOR"
								: props.destination?.kind === "revise_view"
									? "REVISE VIEW FROM SELECTED ACTOR"
									: "ADD SELECTED ACTOR AS VIEW"}
					</button>
					<Show when={liveStreaming()}>
						<label {...stylex.props(styles.fpsControl)}>
							<span>
								{liveContextLabel()} {liveFps()} FPS
							</span>
							<input
								type="range"
								min={1}
								max={10}
								step={1}
								value={liveFps()}
								aria-label="Live preview frame rate"
								onInput={(event) =>
									updateLiveFps(Number(event.currentTarget.value))
								}
							/>
						</label>
					</Show>
					<Show when={pngFallback() && !liveStreaming()}>
						<span
							title="These are slower PNG captures. Workbench will switch them to the live camera stream automatically when UEShedCameras connects."
							{...stylex.props(styles.fallbackMode)}
						>
							PNG FALLBACK
						</span>
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
			<Show when={state().status === "map_mismatch"}>
				{(() => {
					const current = state();
					if (current.status !== "map_mismatch") return null;
					const mismatch = current.mismatch;
					return (
						<div role="alert" {...stylex.props(styles.mapMismatch)}>
							<div {...stylex.props(styles.mapMismatchHeading)}>
								<strong>REVIEW SET IS FOR ANOTHER MAP</strong>
								<span>{mismatch.recovery}</span>
							</div>
							<div {...stylex.props(styles.mapMismatchComparison)}>
								<div {...stylex.props(styles.mapMismatchSide)}>
									<span {...stylex.props(styles.mapMismatchLabel)}>
										OPEN REVIEW SET
									</span>
									<strong {...stylex.props(styles.mapMismatchName)}>
										{mismatch.reviewSet.displayName}
									</strong>
									<code {...stylex.props(styles.mapMismatchPath)}>
										{mismatch.reviewSet.mapPath}
									</code>
								</div>
								<div {...stylex.props(styles.mapMismatchSide)}>
									<span {...stylex.props(styles.mapMismatchLabel)}>
										SELECTED ACTOR
									</span>
									<strong {...stylex.props(styles.mapMismatchName)}>
										{mismatch.selection.displayName}
									</strong>
									<code {...stylex.props(styles.mapMismatchPath)}>
										{mismatch.selection.mapPath}
									</code>
								</div>
							</div>
							<Show when={mismatch.matchingReviewSet}>
								{(matching) => (
									<span {...stylex.props(styles.matchingSetHint)}>
										{matching().displayName} already covers this map.
									</span>
								)}
							</Show>
							<div {...stylex.props(styles.mapMismatchActions)}>
								<Show when={mismatch.matchingReviewSet}>
									{(matching) => (
										<button
											type="button"
											onClick={() => void openMatchingReviewSet(mismatch)}
											{...stylex.props(styles.mapMismatchPrimaryButton)}
										>
											OPEN {matching().displayName.toUpperCase()}
										</button>
									)}
								</Show>
								<Show when={props.onChooseReviewSet !== undefined}>
									<button
										type="button"
										onClick={() => props.onChooseReviewSet?.()}
										{...stylex.props(styles.mapMismatchButton)}
									>
										CHOOSE REVIEW SET
									</button>
								</Show>
								<Show
									when={
										(props.destination?.kind ?? "append_view") === "append_view"
									}
								>
									<button
										type="button"
										onClick={() => void generate("selection_map")}
										{...stylex.props(styles.mapMismatchButton)}
									>
										START SET FOR SELECTED MAP
									</button>
								</Show>
							</div>
						</div>
					);
				})()}
			</Show>
			<Show when={session()}>
				<div {...stylex.props(styles.authoringBody)}>
					<div
						aria-label="Framing candidates"
						role="region"
						{...stylex.props(styles.contactSheet)}
					>
						<For each={candidates().map((candidate) => candidate.id)}>
							{(candidateId, index) => {
								const candidate = createMemo(() =>
									candidates().find((item) => item.id === candidateId)
								);
								return (
									<Show when={candidate()}>
										{(item) => (
											<article
												{...stylex.props(
													styles.candidateCard,
													selected()?.id === candidateId &&
														styles.candidateSelected
												)}
											>
												<button
													type="button"
													aria-label={`Select ${item().displayName}`}
													onClick={() => select(item())}
													{...stylex.props(styles.candidateSelect)}
												>
													<CandidateImage candidate={item()} />
													<div {...stylex.props(styles.candidateMeta)}>
														<span
															{...stylex.props(styles.candidateIndex)}
														>
															{String(index() + 1).padStart(2, "0")}
														</span>
														<div
															{...stylex.props(styles.candidateCopy)}
														>
															<strong>{item().displayName}</strong>
															<small>
																{item().preset.replaceAll("_", " ")}
															</small>
														</div>
													</div>
												</button>
												<button
													type="button"
													onClick={() => discard(candidateId)}
													{...stylex.props(styles.discardButton)}
												>
													DISCARD
												</button>
											</article>
										)}
									</Show>
								);
							}}
						</For>
					</div>
					<FramingSettings
						parameters={framingParameters()}
						candidateOverrides={candidateOverrides()}
						selectedCandidate={selected()}
						onParametersChange={(parameters) => {
							setFramingParameters(parameters);
							scheduleFramingPatch({
								patch: { framingParameters: parameters },
								refreshPreviews: { kind: "all" }
							});
						}}
						onCandidateOverridesChange={(overrides) => {
							setCandidateOverrides(overrides);
							const candidateId = selected()?.id;
							if (candidateId === undefined) return;
							scheduleFramingPatch({
								patch: { candidateOverrides: overrides },
								refreshPreviews: { candidateId, kind: "candidate" }
							});
						}}
					/>
					<Show when={selected()}>
						{(candidate) => (
							<div {...stylex.props(styles.approvalBench)}>
								<div>
									<div {...stylex.props(styles.poseHeading)}>
										<p>FINAL POSE / {candidate().displayName.toUpperCase()}</p>
										<span {...stylex.props(styles.poseScrubHint)}>
											↔ DRAG LABELS · SHIFT COARSE · ALT FINE
										</span>
									</div>
									<small {...stylex.props(styles.poseHint)}>
										Drag for visual tuning or type an exact value. Changes apply
										to this selected preview only.
									</small>
									<div {...stylex.props(styles.poseGrid)}>
										<section
											{...stylex.props(
												styles.poseGroup,
												styles.positionGroup
											)}
										>
											<header {...stylex.props(styles.poseGroupHeader)}>
												<strong>POSITION</strong>
												<span>WORLD UNITS</span>
											</header>
											<div {...stylex.props(styles.positionFields)}>
												<For each={["x", "y", "z"] as const}>
													{(field) => (
														<ScrubbableNumberField
															label={field.toUpperCase()}
															value={poseFieldValue(
																draftPose(),
																"location",
																field
															)}
															scrubStep={1}
															step={0.1}
															tone={field}
															unit="UU"
															onValueChange={(value) =>
																updateNumber(
																	"location",
																	field,
																	value,
																	false
																)
															}
															onValueCommit={(value) =>
																updateNumber(
																	"location",
																	field,
																	value,
																	true
																)
															}
														/>
													)}
												</For>
											</div>
										</section>
										<section {...stylex.props(styles.poseGroup)}>
											<header {...stylex.props(styles.poseGroupHeader)}>
												<strong>ORIENTATION</strong>
												<span>LOOK ANGLE</span>
											</header>
											<div {...stylex.props(styles.orientationFields)}>
												<For each={["pitch", "yaw"] as const}>
													{(field) => (
														<ScrubbableNumberField
															label={field.toUpperCase()}
															value={poseFieldValue(
																draftPose(),
																"rotation",
																field
															)}
															scrubStep={0.25}
															step={0.1}
															unit="DEG"
															onValueChange={(value) =>
																updateNumber(
																	"rotation",
																	field,
																	value,
																	false
																)
															}
															onValueCommit={(value) =>
																updateNumber(
																	"rotation",
																	field,
																	value,
																	true
																)
															}
														/>
													)}
												</For>
											</div>
										</section>
										<section
											{...stylex.props(styles.poseGroup, styles.lensGroup)}
										>
											<header {...stylex.props(styles.poseGroupHeader)}>
												<strong>LENS</strong>
												<span>PERSPECTIVE</span>
											</header>
											<ScrubbableNumberField
												label="FOV"
												value={poseFieldValue(
													draftPose(),
													"pose",
													"fieldOfViewDegrees"
												)}
												min={5}
												max={170}
												scrubStep={0.25}
												step={0.1}
												unit="DEG"
												onValueChange={(value) =>
													updateNumber(
														"pose",
														"fieldOfViewDegrees",
														value,
														false
													)
												}
												onValueCommit={(value) =>
													updateNumber(
														"pose",
														"fieldOfViewDegrees",
														value,
														true
													)
												}
											/>
										</section>
									</div>
									<label {...stylex.props(styles.reasonField)}>
										<span>MANUAL ADJUSTMENT NOTE</span>
										<input
											value={manualReason()}
											{...stylex.props(styles.poseInput)}
											onInput={(event) => {
												const next = event.currentTarget.value;
												setManualReason(next);
											}}
											onChange={(event) =>
												persist(
													currentPatch({
														manualReason: event.currentTarget.value
													})
												)
											}
											placeholder="Why did this framing need art direction?"
										/>
									</label>
								</div>
								<div {...stylex.props(styles.approveColumn)}>
									<span>{keepSummary()}</span>
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
											no longer matches the live actor.
										</small>
									</Show>
									<button
										type="button"
										disabled={state().status === "saving" || authoringBlocked()}
										onClick={() => void approve()}
										{...stylex.props(styles.keepButton)}
									>
										{state().status === "saving" ? "SAVING…" : keepLabel()}
									</button>
									<Show when={state().status === "approved"}>
										{(() => {
											const current = state();
											if (current.status !== "approved") return null;
											return (
												<strong {...stylex.props(styles.savedMark)}>
													{current.keptCount === 1
														? "VIEW SAVED"
														: `${current.keptCount} VIEWS SAVED`}
												</strong>
											);
										})()}
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
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurface
	},
	authoringHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: 16,
		padding: "8px 12px",
		borderBottom: `1px solid ${tokens.colorBorder}`
	},
	headerSubject: {
		display: "flex",
		alignItems: "center",
		gap: 10,
		minWidth: 0,
		flex: 1,
		color: tokens.colorText,
		fontSize: 12
	},
	headerLabel: {
		flexShrink: 0,
		color: tokens.colorTextSubtle,
		fontSize: 11,
		letterSpacing: ".04em"
	},
	headerPath: {
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextSubtle,
		fontSize: 11
	},
	headerActions: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		flexShrink: 0
	},
	generateButton: {
		flexShrink: 0,
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em",
		cursor: { default: "pointer", ":disabled": "wait" }
	},
	fpsControl: {
		display: "grid",
		gap: 4,
		alignItems: "center",
		minWidth: 140,
		color: tokens.colorTextMuted,
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	fallbackMode: {
		padding: "6px 8px",
		border: "1px solid rgba(242, 153, 74, 0.4)",
		backgroundColor: "rgba(242, 153, 74, 0.08)",
		color: tokens.colorWarning,
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	authoringError: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "10px 12px",
		color: tokens.colorDanger
	},
	mapMismatch: {
		display: "grid",
		gap: 12,
		padding: "14px 16px",
		borderTop: "1px solid rgba(235, 87, 87, 0.35)",
		borderBottom: "1px solid rgba(235, 87, 87, 0.35)",
		backgroundColor: "rgba(235, 87, 87, 0.06)",
		color: tokens.colorDanger
	},
	mapMismatchHeading: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		fontSize: 11
	},
	mapMismatchComparison: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: 10
	},
	mapMismatchSide: {
		display: "grid",
		gap: 4,
		minWidth: 0,
		padding: 10,
		border: "1px solid rgba(235, 87, 87, 0.25)",
		backgroundColor: tokens.colorSurfaceInset
	},
	mapMismatchLabel: { color: tokens.colorTextSubtle, fontSize: 11, letterSpacing: ".04em" },
	mapMismatchName: { color: tokens.colorTextStrong, fontSize: 11 },
	mapMismatchPath: {
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		color: tokens.colorTextMuted,
		fontSize: 11
	},
	matchingSetHint: { color: tokens.colorAccent, fontSize: 11 },
	mapMismatchActions: {
		display: "flex",
		gap: 8
	},
	mapMismatchButton: {
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: { default: "transparent", ":hover": "rgba(255, 255, 255, 0.04)" },
		color: tokens.colorText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em",
		cursor: "pointer"
	},
	mapMismatchPrimaryButton: {
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: { default: tokens.colorAccent, ":hover": tokens.colorAccentStrong },
		color: tokens.colorAccentText,
		padding: "5px 12px",
		fontSize: 12,
		fontWeight: 500,
		letterSpacing: ".04em",
		cursor: "pointer"
	},
	authoringBody: { padding: 10 },
	contactSheet: {
		display: "grid",
		gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
		gap: 8
	},
	candidateCard: {
		position: "relative",
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	candidateSelected: {
		borderColor: tokens.colorAccent,
		boxShadow: `0 0 0 1px ${tokens.colorAccent}`
	},
	candidateSelect: {
		width: "100%",
		border: 0,
		backgroundColor: "transparent",
		color: tokens.colorText,
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
		color: tokens.colorTextSubtle,
		backgroundImage:
			"repeating-linear-gradient(-45deg,#0c0d0e,#0c0d0e 8px,#161718 8px,#161718 9px)"
	},
	candidateIndex: {
		color: tokens.colorAccent,
		fontSize: 11
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
		border: `1px solid ${tokens.colorBorderStrong}`,
		backgroundColor: "rgba(12, 13, 14, 0.85)",
		color: tokens.colorTextMuted,
		fontSize: 11,
		padding: "5px 6px",
		cursor: "pointer"
	},
	approvalBench: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(0, 1fr) 190px",
			"@media (max-width: 900px)": "1fr"
		},
		gap: 18,
		marginTop: 10,
		padding: 16,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceRaised
	},
	poseHeading: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12
	},
	poseScrubHint: {
		color: tokens.colorTextSubtle,
		fontSize: 11,
		fontWeight: 500,
		letterSpacing: ".04em"
	},
	poseGrid: {
		display: "grid",
		gridTemplateColumns: {
			default: "minmax(250px, 1.2fr) minmax(210px, .8fr)",
			"@media (max-width: 700px)": "1fr"
		},
		gap: 8
	},
	poseHint: {
		display: "block",
		marginBottom: 10,
		color: tokens.colorTextMuted,
		lineHeight: 1.45
	},
	poseGroup: {
		display: "grid",
		alignContent: "start",
		gap: 7,
		padding: 9,
		border: `1px solid ${tokens.colorBorder}`,
		backgroundColor: tokens.colorSurfaceInset
	},
	positionGroup: {
		gridRow: { default: "1 / span 2", "@media (max-width: 700px)": "auto" }
	},
	lensGroup: { borderTopColor: tokens.colorAccent },
	poseGroupHeader: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 8,
		color: tokens.colorText,
		fontSize: 11,
		letterSpacing: ".04em"
	},
	positionFields: {
		display: "grid",
		gridTemplateColumns: "1fr",
		gap: 6
	},
	orientationFields: {
		display: "grid",
		gridTemplateColumns: "1fr",
		gap: 6
	},
	poseInput: {
		width: "100%",
		boxSizing: "border-box",
		border: {
			default: `1px solid ${tokens.colorBorderStrong}`,
			":focus": `1px solid ${tokens.colorTextSubtle}`
		},
		backgroundColor: tokens.colorSurfaceInset,
		color: tokens.colorTextStrong,
		padding: "7px 8px",
		fontFamily: "inherit",
		fontSize: 12,
		outline: { ":focus": "none" }
	},
	reasonField: { display: "grid", gap: 5, marginTop: 10 },
	diagnosticList: {
		display: "flex",
		flexDirection: "column",
		gap: 4,
		color: tokens.colorText,
		lineHeight: 1.35
	},
	reframeNotice: { color: tokens.colorWarning, lineHeight: 1.35 },
	approveColumn: {
		display: "flex",
		flexDirection: "column",
		justifyContent: "end",
		gap: 10,
		fontSize: 8
	},
	keepButton: {
		border: `1px solid ${tokens.colorAccent}`,
		backgroundColor: {
			default: tokens.colorAccent,
			":hover": tokens.colorAccentStrong,
			":disabled": "rgba(228, 242, 34, 0.5)"
		},
		color: tokens.colorAccentText,
		fontWeight: 500,
		padding: "5px 12px",
		cursor: { default: "pointer", ":disabled": "wait" }
	},
	savedMark: { color: tokens.colorAccent, letterSpacing: ".04em" }
});

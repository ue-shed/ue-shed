import { CameraVisibilityPreset } from "./camera-visibility.js";
import { legacyReviewRenderPolicy } from "./camera-render-schema.js";
import { Effect, Ref } from "effect";
import { ReviewViewId } from "./review-schema.js";
import {
	ArrangementCameraId,
	cameraIdsInScope,
	CameraArrangementError,
	arrangementFailure,
	effectiveCameraArrangementVisibility,
	exportCameraArrangementRecipe,
	importCameraArrangementRecipe,
	previewArrangementRegeneration,
	proposeCameraLayout,
	resolveArrangementCamera
} from "./camera-arrangement.js";
import {
	CameraPanelState,
	type CameraPanelProposal,
	type CameraPanelEvent
} from "./camera-authoring-panel-schema.js";
import {
	readyCameraBridge,
	synchronizeArrangementCamera,
	type CameraAuthoringBridge,
	type CameraBridgeSnapshot
} from "./camera-authoring-bridge.js";
import {
	readCameraArrangementRecipe,
	readCameraVisibilityPreset,
	writeCameraVisibilityPreset,
	writeCameraArrangementRecipe,
	type CameraAuthoringStore,
	type CameraAuthoringDocument
} from "./camera-authoring-store.js";

export function cameraAuthoringPanelState(
	document: CameraAuthoringDocument,
	activeCameraId: ArrangementCameraId,
	paths: { draftPath: string; approvalPath: string },
	notice = "",
	proposal?: CameraPanelProposal
): CameraPanelState {
	const arrangement = document.arrangement;
	return CameraPanelState.make({
		arrangement,
		renderPolicy:
			arrangement.renderPolicy ??
			document.reviewSet.captureProfiles.find(
				(profile) => profile.id === arrangement.captureProfileId
			)?.renderPolicy ??
			legacyReviewRenderPolicy,
		activeCameraId,
		...paths,
		notice,
		cameras: arrangement.cameras.map((camera) => ({
			id: camera.id,
			pose: resolveArrangementCamera(arrangement, camera.id),
			visibility: effectiveCameraArrangementVisibility(arrangement, camera),
			approved: document.reviewSet.views.some(
				(view) =>
					view.authoring?.arrangementId === arrangement.id &&
					view.authoring.cameraId === camera.id &&
					view.displayName === camera.displayName &&
					view.viewpoint.kind === "world_fixed" &&
					JSON.stringify(view.viewpoint.approvedPose) ===
						JSON.stringify(resolveArrangementCamera(arrangement, camera.id)) &&
					(arrangement.output === undefined ||
						JSON.stringify(view.authoredVisibility) ===
							JSON.stringify({
								version: 1,
								output: arrangement.output,
								actors: effectiveCameraArrangementVisibility(arrangement, camera)
							})) &&
					(arrangement.renderPolicy === undefined ||
						JSON.stringify(
							document.reviewSet.captureProfiles.find(
								(profile) => profile.id === view.captureProfileId
							)?.renderPolicy
						) === JSON.stringify(arrangement.renderPolicy))
			)
		})),
		retiredViews: document.reviewSet.views
			.filter(
				(view) =>
					view.authoring?.arrangementId === arrangement.id &&
					arrangement.retiredCameraIds.some((id) => id === view.authoring?.cameraId)
			)
			.map((view) => ({ id: view.id, name: view.displayName })),
		...(proposal ? { proposal } : undefined)
	});
}

/** Thin, replaceable menu coordinator. One event is acknowledged only after its durable outcome. */
export const makeCameraAuthoringPanelSession = Effect.fn("CameraAuthoringPanel.make")(
	function* (args: {
		store: CameraAuthoringStore;
		bridge: CameraAuthoringBridge;
		attachment: CameraBridgeSnapshot;
		draftPath: string;
		approvalPath: string;
	}) {
		interface PanelSessionState {
			attachment: CameraBridgeSnapshot;
			proposal: CameraPanelProposal | undefined;
			notice: string;
		}
		const initial: PanelSessionState = {
			attachment: args.attachment,
			proposal: undefined,
			notice: "Draft changes autosave. Save views publishes capture definitions."
		};
		const state = yield* Ref.make(initial);
		const attempt = <A>(operation: () => A) =>
			Effect.try({
				try: operation,
				catch: (cause) =>
					cause instanceof CameraArrangementError
						? cause
						: arrangementFailure("invalid", String(cause))
			});
		const processEvent = Effect.fn("CameraAuthoringPanel.event")(function* (
			event: CameraPanelEvent,
			document: CameraAuthoringDocument
		) {
			const previous = yield* Ref.get(state),
				action = event.action;
			const committed = document.outcomes.some((outcome) => outcome.operationId === event.id);
			if (!committed && event.expectedRevision !== document.arrangement.revision)
				return yield* Effect.fail(
					arrangementFailure(
						"stale",
						"This action was authored against an older arrangement. Review the current state and retry."
					)
				);
			const scope = {
				arrangementId: document.arrangement.id,
				expectedRevision: event.expectedRevision,
				operationId: event.id
			};
			const identities = (count: number) =>
				Array.from({ length: count }, (_, index) => ({
					id: ArrangementCameraId.make(`c-${event.id}-${index}`),
					viewId: ReviewViewId.make(`v-${event.id}-${index}`)
				}));
			let active = previous.attachment.cameraId,
				proposal = previous.proposal,
				notice = "Draft saved.";
			if (committed && action.kind !== "approve") {
				if (action.kind === "accept_proposal") proposal = undefined;
				if (action.kind === "add_viewport") active = identities(1)[0]!.id;
			} else if (action.kind === "remove") {
				const cameras = document.arrangement.cameras.filter(
					(camera) => !action.cameraIds.includes(camera.id)
				);
				if (
					!cameras.length ||
					action.cameraIds.some(
						(id) => !document.arrangement.cameras.some((camera) => camera.id === id)
					)
				)
					return yield* Effect.fail(
						arrangementFailure(
							"invalid",
							"Keep at least one camera and remove only cameras in this arrangement."
						)
					);
				proposal = {
					cameras,
					...previewArrangementRegeneration(document.arrangement, cameras),
					expectedRevision: document.arrangement.revision
				};
				notice = "Review removed cameras and customizations before accepting.";
			} else if (action.kind === "command") {
				if (
					action.command.arrangementId !== scope.arrangementId ||
					action.command.expectedRevision !== event.expectedRevision
				)
					return yield* Effect.fail(
						arrangementFailure(
							"scope_mismatch",
							"The menu command does not match its arrangement revision."
						)
					);
				document = yield* args.store.mutate({ ...action.command, operationId: event.id });
			} else if (action.kind === "activate") {
				yield* Effect.try({
					try: () => resolveArrangementCamera(document.arrangement, action.cameraId),
					catch: (cause) =>
						cause instanceof CameraArrangementError
							? cause
							: arrangementFailure("invalid", String(cause))
				});
				active = action.cameraId;
			} else if (action.kind === "approve") {
				if (
					!committed &&
					document.arrangement.output &&
					document.arrangement.output !== "natural_only"
				) {
					for (const id of action.cameraIds) {
						const camera = document.arrangement.cameras.find(
							(entry) => entry.id === id
						);
						if (!camera)
							return yield* Effect.fail(
								arrangementFailure(
									"scope_mismatch",
									"Selected camera is outside this arrangement."
								)
							);
						const response = yield* args.bridge.call({
							version: 1,
							operation: "resolve_visibility",
							sessionId: previous.attachment.sessionId,
							producerId: previous.attachment.producerId,
							actors: yield* attempt(() =>
								effectiveCameraArrangementVisibility(document.arrangement, camera)
							)
						});
						if (response.status !== "visibility" || !response.valid)
							return yield* Effect.fail(
								arrangementFailure(
									"invalid",
									response.message ||
										"Resolve authored actors before saving views."
								)
							);
					}
				}
				document = yield* args.store.approve({
					operationId: event.id,
					expectedRevision: event.expectedRevision,
					cameraIds: action.cameraIds,
					removeRetiredViewIds: action.removeRetiredViewIds,
					destination: args.approvalPath
				});
				notice = `Saved ${action.cameraIds.length} view(s) to ${args.approvalPath}.`;
			} else if (action.kind === "layout") {
				const count = action.layout.kind === "single" ? 1 : action.layout.count,
					fresh = identities(count);
				const selected = fresh.map((identity, index) =>
					action.retainExisting && document.arrangement.cameras[index]
						? {
								id: document.arrangement.cameras[index]!.id,
								viewId: document.arrangement.cameras[index]!.viewId
							}
						: identity
				);
				proposal = {
					...(yield* attempt(() =>
						proposeCameraLayout(document.arrangement, action.layout, selected)
					)),
					expectedRevision: document.arrangement.revision
				};
				notice =
					"Review the proposed camera changes before accepting. Retained cameras keep their exceptions.";
			} else if (action.kind === "add_viewport") {
				const identity = identities(1)[0]!;
				document = yield* args.store.mutate({
					...scope,
					kind: "add",
					camera: {
						...identity,
						displayName: "Current viewport",
						yawDegrees: action.pose.rotation.yaw - 180,
						manualPose: action.pose,
						overrides: { fieldOfViewDegrees: action.pose.fieldOfViewDegrees }
					}
				});
				active = identity.id;
			} else if (action.kind === "import_visibility") {
				const preset = yield* readCameraVisibilityPreset(action.path);
				if (
					preset.projectName !== document.arrangement.projectName ||
					preset.mapPath !== document.arrangement.mapPath
				)
					return yield* Effect.fail(
						arrangementFailure(
							"scope_mismatch",
							"The visibility preset belongs to another project or map."
						)
					);
				document = yield* args.store.mutate({
					...scope,
					kind: "visibility",
					scope: action.scope,
					visibility: preset.actors
				});
				notice = `Adopted visibility preset ${preset.name} (${preset.id}) in the chosen scope. Save views to publish this snapshot.`;
			} else if (action.kind === "export_visibility") {
				const selectedScope = action.scope;
				const ids = yield* attempt(() =>
					cameraIdsInScope(document.arrangement, selectedScope)
				);
				if (selectedScope.kind === "cameras" && ids.length !== 1)
					return yield* Effect.fail(
						arrangementFailure(
							"invalid",
							"Export one camera's local list, a group, or the arrangement defaults."
						)
					);
				const actors =
					selectedScope.kind === "arrangement"
						? document.arrangement.visibility
						: selectedScope.kind === "group"
							? document.arrangement.groups?.find(
									(group) => group.id === selectedScope.groupId
								)?.visibility
							: document.arrangement.cameras.find((camera) => camera.id === ids[0])
									?.visibility;
				yield* writeCameraVisibilityPreset(
					action.path,
					CameraVisibilityPreset.make({
						version: 1,
						id: event.id,
						name: action.name,
						projectName: document.arrangement.projectName,
						mapPath: document.arrangement.mapPath,
						actors: actors ?? { hide: [], protect: [] }
					})
				);
				notice = `Exported immutable map-scoped visibility preset to ${action.path}.`;
			} else if (action.kind === "export_recipe") {
				yield* writeCameraArrangementRecipe(
					action.path,
					yield* attempt(() =>
						exportCameraArrangementRecipe(document.arrangement, action.name)
					)
				);
				notice = `Exported portable recipe to ${action.path}. Actor exclusions and View identities are excluded.`;
			} else if (action.kind === "import_recipe") {
				const recipe = yield* readCameraArrangementRecipe(action.path);
				const imported = yield* attempt(() =>
					importCameraArrangementRecipe(
						document.arrangement,
						recipe,
						identities(recipe.cameras.length)
					)
				);
				proposal = {
					...previewArrangementRegeneration(document.arrangement, imported.cameras),
					cameras: imported.cameras,
					expectedRevision: document.arrangement.revision,
					recipe
				};
				notice = "Review the imported recipe before replacing this arrangement.";
			} else if (action.kind === "accept_proposal") {
				if (!proposal || proposal.expectedRevision !== document.arrangement.revision)
					return yield* Effect.fail(
						arrangementFailure(
							"stale",
							"Create a fresh layout proposal after changing the arrangement."
						)
					);
				document = yield* args.store.mutate({
					...scope,
					kind: "regenerate",
					cameras: proposal.cameras,
					discardCustomizedIds: proposal.customized,
					...(proposal.recipe
						? { settings: proposal.recipe.settings, groups: proposal.recipe.groups }
						: undefined)
				});
				proposal = undefined;
			} else {
				proposal = undefined;
				notice = "Proposal canceled; the draft is unchanged.";
			}
			if (!document.arrangement.cameras.some((camera) => camera.id === active))
				active = document.arrangement.cameras[0]!.id;
			yield* Ref.set(state, { ...previous, proposal, notice });
			return { document, active };
		});
		const tick = Effect.fn("CameraAuthoringPanel.tick")(function* () {
			let current = yield* Ref.get(state);
			let native = yield* args.bridge
				.call({
					version: 1,
					operation: "inspect",
					sessionId: current.attachment.sessionId,
					producerId: current.attachment.producerId
				})
				.pipe(Effect.flatMap(readyCameraBridge));
			let document = yield* args.store.load();
			// A pending panel event may already be durable when its reply was lost. Reconcile it
			// before resolving a camera that a committed regeneration has retired.
			const recovered =
				native.panelEvent &&
				document.outcomes.some((entry) => entry.operationId === native.panelEvent?.id);
			if (!recovered)
				native = yield* synchronizeArrangementCamera({
					store: args.store,
					bridge: args.bridge,
					attachment: { ...current.attachment, cameraId: native.cameraId },
					approvalDestination: args.approvalPath
				});
			document = yield* args.store.load();
			let active = native.cameraId;
			const event = native.panelEvent;
			let acknowledgeEvent: string | undefined;
			if (event) {
				acknowledgeEvent = event.id;
				const result = yield* processEvent(event, document).pipe(
					Effect.catch((error) =>
						Effect.gen(function* () {
							if (
								error.code === "storage" ||
								error.code === "busy" ||
								error.code === "disconnected"
							)
								acknowledgeEvent = undefined;
							yield* Ref.update(state, (value) => ({
								...value,
								notice: `${error.message} ${error.recovery}`
							}));
							return undefined;
						})
					)
				);
				if (result) {
					document = result.document;
					active = result.active;
				}
			}
			const scope = {
				version: 1 as const,
				sessionId: native.sessionId,
				producerId: native.producerId
			};
			if (document.arrangement.revision !== native.revision)
				native = yield* args.bridge
					.call({
						...scope,
						operation: "apply",
						expectedRevision: native.revision,
						revision: document.arrangement.revision,
						sequence: native.sequence,
						pose: resolveArrangementCamera(document.arrangement, active)
					})
					.pipe(Effect.flatMap(readyCameraBridge));
			if (active !== native.cameraId)
				native = yield* args.bridge
					.call({
						...scope,
						operation: "activate",
						expectedRevision: native.revision,
						sequence: native.sequence,
						cameraId: active,
						pose: resolveArrangementCamera(document.arrangement, active)
					})
					.pipe(Effect.flatMap(readyCameraBridge));
			current = yield* Ref.get(state);
			const panel = cameraAuthoringPanelState(
				document,
				active,
				args,
				current.notice,
				current.proposal
			);
			const result = yield* args.bridge
				.call({
					...scope,
					operation: "panel",
					state: panel,
					...(acknowledgeEvent ? { acknowledgeEvent } : undefined)
				})
				.pipe(Effect.flatMap(readyCameraBridge));
			yield* Ref.set(state, { ...current, attachment: result });
			return result;
		});
		return { tick };
	}
);

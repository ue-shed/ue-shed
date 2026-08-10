import type {
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewReplaceVisibilityPolicyIntent,
	MapReviewSetCreateIntent,
	MapReviewSetSelectIntent
} from "@ue-shed/cameras/review-contracts";
import type { ActorId, WorldScoutRefreshRate } from "@ue-shed/observatory";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts, type CandidateId } from "../ipc-contracts.js";
import { WorkbenchMapReview } from "../services/map-review.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const mapReview = yield* WorkbenchMapReview;

	yield* ipc.register(invokeContracts["map-review:load"], () => mapReview.load());
	yield* ipc.register(invokeContracts["map-review:review-sets"], () =>
		mapReview.reviewSetLibrary()
	);
	yield* ipc.register(invokeContracts["map-review:create-review-set"], (...args) => {
		const [intent] = args as [MapReviewSetCreateIntent];
		return mapReview.createReviewSet(intent);
	});
	yield* ipc.register(invokeContracts["map-review:select-review-set"], (...args) => {
		const [intent] = args as [MapReviewSetSelectIntent];
		return mapReview.selectReviewSet(intent);
	});
	yield* ipc.register(invokeContracts["map-review:capture"], (...args) => {
		const [intent] = args as [MapReviewCaptureIntent];
		return mapReview.capture(intent);
	});
	yield* ipc.register(invokeContracts["map-review:apply-visibility-policy"], (...args) => {
		const [intent] = args as [MapReviewApplyVisibilityPolicyIntent];
		return mapReview.applyVisibilityPolicy(intent);
	});
	yield* ipc.register(invokeContracts["map-review:replace-visibility-policy"], (...args) => {
		const [intent] = args as [MapReviewReplaceVisibilityPolicyIntent];
		return mapReview.replaceVisibilityPolicy(intent);
	});
	yield* ipc.register(invokeContracts["map-review:world-snapshot"], () =>
		mapReview.worldSnapshot()
	);
	yield* ipc.register(invokeContracts["map-review:saved-world"], (...args) => {
		const [mapPath] = args as [string];
		return mapReview.savedWorld(mapPath).pipe(Effect.orDie);
	});
	yield* ipc.register(invokeContracts["map-review:saved-world-maps"], () =>
		mapReview.savedWorldMaps().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["map-review:choose-project-and-maps"], () =>
		mapReview.chooseProjectAndMaps().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["map-review:focus-actor"], (...args) => {
		const [actorId, bringToFront] = args as [ActorId, boolean];
		return mapReview.focusActor(actorId, bringToFront);
	});
	yield* ipc.register(invokeContracts["map-review:author-from-selection"], (...args) => {
		const [intent] = args as [MapReviewAuthorFromSelectionIntent];
		return mapReview.authorFromSelection(intent);
	});
	yield* ipc.register(invokeContracts["map-review:authoring-resume"], () =>
		mapReview.authoringResume(undefined)
	);
	yield* ipc.register(invokeContracts["map-review:authoring-patch"], (...args) => {
		const [intent] = args as [MapReviewAuthoringPatchIntent];
		return mapReview.authoringPatch(intent);
	});
	yield* ipc.register(invokeContracts["map-review:authoring-reframe"], (...args) => {
		const [intent] = args as [MapReviewAuthoringSessionIntent];
		return mapReview.authoringReframe(intent);
	});
	yield* ipc.register(invokeContracts["map-review:authoring-discard"], (...args) => {
		const [intent] = args as [MapReviewAuthoringSessionIntent];
		return mapReview.discardAuthoring(intent);
	});
	yield* ipc.register(invokeContracts["map-review:preview-authoring-candidate"], (...args) => {
		const [intent] = args as [MapReviewAuthoringPreviewIntent];
		return mapReview.previewAuthoringCandidate(intent);
	});
	yield* ipc.register(invokeContracts["map-review:approve-authoring"], (...args) => {
		const [intent] = args as [MapReviewAuthoringSessionIntent];
		return mapReview.approveAuthoring(intent);
	});
	yield* ipc.register(invokeContracts["map-review:preview-candidate"], (...args) => {
		const [candidateId] = args as [CandidateId];
		return mapReview.previewCandidate(candidateId);
	});
	yield* ipc.register(invokeContracts["map-review:approve-candidate"], (...args) => {
		const [intent] = args as [MapReviewApproveCandidateIntent];
		return mapReview.approveCandidate(intent);
	});
	yield* ipc.register(invokeContracts["map-review:set-live-preview-fps"], (...args) => {
		const [fps] = args as [number];
		return mapReview.setLivePreviewFps(fps);
	});
	yield* ipc.register(invokeContracts["map-review:subscribe-world-observations"], (...args) => {
		const [cadenceHz] = args as [WorldScoutRefreshRate];
		return mapReview.subscribeWorldObservations(cadenceHz);
	});
	yield* ipc.register(invokeContracts["map-review:set-world-observation-rate"], (...args) => {
		const [cadenceHz] = args as [WorldScoutRefreshRate];
		return mapReview.setWorldObservationRate(cadenceHz);
	});
	yield* ipc.register(invokeContracts["map-review:unsubscribe-world-observations"], () =>
		mapReview.unsubscribeWorldObservations()
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerMapReview"));

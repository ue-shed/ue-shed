import type { MapReviewApproveCandidateIntent } from "@ue-shed/cameras/review-contracts";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts, type CandidateId } from "../ipc-contracts.js";
import { WorkbenchMapReview } from "../services/map-review.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const mapReview = yield* WorkbenchMapReview;

	yield* ipc.register(invokeContracts["map-review:load"], () => mapReview.load());
	yield* ipc.register(invokeContracts["map-review:capture"], () => mapReview.capture());
	yield* ipc.register(invokeContracts["map-review:author-from-selection"], () =>
		mapReview.authorFromSelection()
	);
	yield* ipc.register(invokeContracts["map-review:preview-candidate"], (...args) => {
		const [candidateId] = args as [CandidateId];
		return mapReview.previewCandidate(candidateId);
	});
	yield* ipc.register(invokeContracts["map-review:approve-candidate"], (...args) => {
		const [intent] = args as [MapReviewApproveCandidateIntent];
		return mapReview.approveCandidate(intent);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerMapReview"));

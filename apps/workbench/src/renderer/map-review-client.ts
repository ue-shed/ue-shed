import type { MapReviewClient } from "@ue-shed/extension-camera-review/client";

export const mapReviewClient: MapReviewClient = {
	approveCandidate: (intent) => window.ueShed.mapReview.approveCandidate(intent),
	authorFromSelection: async () => {
		const launch = await window.ueShed.fixture.launchReview();
		if (launch.status === "failed") {
			return {
				error: { message: launch.message, recovery: launch.recovery },
				status: "failed"
			};
		}
		return window.ueShed.mapReview.authorFromSelection();
	},
	capture: () => window.ueShed.mapReview.capture(),
	load: () => window.ueShed.mapReview.load(),
	previewCandidate: (candidateId) => window.ueShed.mapReview.previewCandidate(candidateId)
};

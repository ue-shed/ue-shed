export interface MapReviewRunView {
	readonly completedAt: string;
	readonly failedViews: number;
	readonly id: string;
	readonly preview?: {
		readonly bytes: Uint8Array;
		readonly height: number;
		readonly viewName: string;
		readonly width: number;
	};
	readonly status: "completed" | "completed_with_failures" | "failed";
	readonly successfulViews: number;
}

export type MapReviewResult =
	| { readonly status: "not_configured" }
	| {
			readonly status: "failed";
			readonly error: {
				readonly message: string;
				readonly recovery: string;
			};
	  }
	| {
			readonly status: "ready";
			readonly reviewSet: {
				readonly displayName: string;
				readonly mapPath: string;
				readonly viewCount: number;
			};
			readonly runs: readonly MapReviewRunView[];
	  };

export interface MapReviewClient {
	readonly approveCandidate: (
		intent: MapReviewApproveCandidateIntent
	) => Promise<MapReviewApprovalResult>;
	readonly authorFromSelection: () => Promise<MapReviewAuthoringResult>;
	readonly capture: () => Promise<MapReviewResult>;
	readonly load: () => Promise<MapReviewResult>;
	readonly previewCandidate: (candidateId: string) => Promise<MapReviewCandidatePreviewResult>;
}

export interface MapReviewPose {
	readonly aspectRatio: "16:9";
	readonly fieldOfViewDegrees: number;
	readonly location: { readonly x: number; readonly y: number; readonly z: number };
	readonly projection: "perspective";
	readonly rotation: { readonly pitch: number; readonly roll: number; readonly yaw: number };
}

export interface MapReviewAuthoringCandidate {
	readonly diagnostics: readonly {
		readonly code: string;
		readonly message: string;
		readonly severity: "info" | "warning";
	}[];
	readonly displayName: string;
	readonly id: string;
	readonly pose: MapReviewPose;
	readonly preset: string;
	readonly preview:
		| {
				readonly status: "ready";
				readonly bytes: Uint8Array;
				readonly height: number;
				readonly width: number;
		  }
		| { readonly status: "pending" }
		| { readonly status: "failed"; readonly message: string };
}

export type MapReviewCandidatePreviewResult =
	| {
			readonly status: "ready";
			readonly bytes: Uint8Array;
			readonly height: number;
			readonly width: number;
	  }
	| {
			readonly status: "failed";
			readonly error: { readonly message: string; readonly recovery: string };
	  };

export type MapReviewAuthoringResult =
	| {
			readonly status: "failed";
			readonly error: { readonly message: string; readonly recovery: string };
	  }
	| {
			readonly status: "ready";
			readonly candidates: readonly MapReviewAuthoringCandidate[];
			readonly selection: {
				readonly actorPath: string;
				readonly displayName: string;
				readonly mapPath: string;
			};
			readonly viewId: string;
	  };

export interface MapReviewApproveCandidateIntent {
	readonly candidateId: string;
	readonly candidatePose: MapReviewPose;
	readonly manualPose?: MapReviewPose;
	readonly manualReason?: string;
	readonly sourceActorPath: string;
	readonly viewId: string;
}

export type MapReviewApprovalResult =
	| { readonly status: "approved"; readonly candidateId: string }
	| {
			readonly status: "failed";
			readonly error: { readonly message: string; readonly recovery: string };
	  };

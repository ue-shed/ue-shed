import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import type { AuthoringSessionIntent } from "@ue-shed/authoring-sdk";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult
} from "@ue-shed/extension-camera-review/client";
import type {
	RendererCameraFrame,
	FixtureLaunchResult,
	ShowcaseContext,
	WorkbenchCameraMetrics
} from "../main/preload.js";

declare global {
	interface Window {
		readonly ueShed: {
			readonly showcase: {
				readonly context: () => Promise<ShowcaseContext>;
			};
			readonly assetAudits: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
				readonly preview: (objectPath: string) => Promise<unknown>;
			};
			readonly gameText: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
			};
			readonly authoring: {
				readonly beginSession: (objectPath: string) => Promise<unknown>;
				readonly listSessions: () => Promise<unknown>;
				readonly openSession: (sessionId: string) => Promise<unknown>;
				readonly discardSession: (sessionId: string) => Promise<unknown>;
				readonly editSession: (intent: AuthoringSessionIntent) => Promise<unknown>;
				readonly reviewSession: (sessionId: string) => Promise<unknown>;
				readonly applySession: (sessionId: string) => Promise<unknown>;
				readonly reconcileSession: (sessionId: string) => Promise<unknown>;
				readonly saveSession: (sessionId: string) => Promise<unknown>;
				readonly undoSession: (sessionId: string) => Promise<unknown>;
				readonly redoSession: (sessionId: string) => Promise<unknown>;
				readonly loadConfiguredCatalog: () => Promise<unknown>;
				readonly loadConfiguredTable: () => Promise<unknown>;
				readonly openCatalogTable: (objectPath: string) => Promise<unknown>;
				readonly chooseTable: () => Promise<unknown>;
			};
			readonly fixture: {
				readonly launch: () => Promise<FixtureLaunchResult>;
				readonly launchReview: () => Promise<FixtureLaunchResult>;
			};
			readonly mapReview: {
				readonly approveCandidate: (
					intent: MapReviewApproveCandidateIntent
				) => Promise<MapReviewApprovalResult>;
				readonly authorFromSelection: () => Promise<MapReviewAuthoringResult>;
				readonly previewCandidate: (
					candidateId: string
				) => Promise<MapReviewCandidatePreviewResult>;
				readonly capture: () => Promise<MapReviewResult>;
				readonly load: () => Promise<MapReviewResult>;
			};
			readonly configure: (config: CameraScheduleConfig) => Promise<CameraStatus>;
			readonly getMetrics: () => Promise<WorkbenchCameraMetrics>;
			readonly getStatus: () => Promise<CameraStatus>;
			readonly onFrame: (listener: (frame: RendererCameraFrame) => void) => () => void;
			readonly setPresentationBudget: (megabytesPerSecond: number) => Promise<number>;
		};
	}
}

export {};

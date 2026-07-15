import type { CameraFeedMetrics, CameraFrame } from "@ue-shed/cameras";
import type { AuthoringSetCellsIntent } from "@ue-shed/authoring-sdk";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult
} from "@ue-shed/extension-camera-review/client";
import type { CameraScheduleConfig, CameraStatus } from "@ue-shed/protocol";
import { contextBridge, ipcRenderer } from "electron";

export interface RendererCameraFrame extends Omit<CameraFrame, "pixels" | "sequence"> {
	readonly pixels: Uint8Array;
	readonly sequence: string;
}

export interface WorkbenchCameraMetrics extends CameraFeedMetrics {
	readonly electronPrivateMemoryMb: number;
	readonly gpuProcessPrivateMemoryMb: number;
	readonly presentationBudgetMbPerSecond: number;
	readonly presentationFramesSent: number;
	readonly presentationReplacements: number;
}

export interface ShowcaseContext {
	readonly fixtureConfigured: boolean;
	readonly projectRoot?: string;
	readonly reader: "configured" | "path";
	readonly ruleFile?: string;
}

export type FixtureLaunchResult =
	| { readonly status: "ready" }
	| {
			readonly status: "failed";
			readonly message: string;
			readonly recovery: string;
	  };

contextBridge.exposeInMainWorld("ueShed", {
	showcase: {
		context: (): Promise<ShowcaseContext> => ipcRenderer.invoke("showcase:context")
	},
	assetAudits: {
		loadConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:configured-scan"),
		chooseProjectAndScan: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:choose-and-scan"),
		preview: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:preview", objectPath)
	},
	gameText: {
		loadConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:configured-scan"),
		chooseProjectAndScan: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:choose-and-scan")
	},
	authoring: {
		beginSession: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:begin", objectPath),
		editSession: (intent: AuthoringSetCellsIntent): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:edit", intent),
		applySession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:apply", sessionId),
		reconcileSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:reconcile", sessionId),
		saveSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:save", sessionId),
		undoSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:undo", sessionId),
		redoSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:redo", sessionId),
		loadConfiguredCatalog: (): Promise<unknown> =>
			ipcRenderer.invoke("authoring:configured-catalog"),
		loadConfiguredTable: (): Promise<unknown> =>
			ipcRenderer.invoke("authoring:configured-table"),
		openCatalogTable: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:open-catalog-table", objectPath),
		chooseTable: (): Promise<unknown> => ipcRenderer.invoke("authoring:choose-table")
	},
	fixture: {
		launch: (): Promise<FixtureLaunchResult> => ipcRenderer.invoke("fixture:launch"),
		launchReview: (): Promise<FixtureLaunchResult> =>
			ipcRenderer.invoke("fixture:launch-review")
	},
	mapReview: {
		approveCandidate: (
			intent: MapReviewApproveCandidateIntent
		): Promise<MapReviewApprovalResult> =>
			ipcRenderer.invoke("map-review:approve-candidate", intent),
		authorFromSelection: (): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:author-from-selection"),
		previewCandidate: (candidateId: string): Promise<MapReviewCandidatePreviewResult> =>
			ipcRenderer.invoke("map-review:preview-candidate", candidateId),
		capture: (): Promise<MapReviewResult> => ipcRenderer.invoke("map-review:capture"),
		load: (): Promise<MapReviewResult> => ipcRenderer.invoke("map-review:load")
	},
	configure: (config: CameraScheduleConfig): Promise<CameraStatus> =>
		ipcRenderer.invoke("camera:configure", config),
	getMetrics: (): Promise<WorkbenchCameraMetrics> => ipcRenderer.invoke("camera:metrics"),
	getStatus: (): Promise<CameraStatus> => ipcRenderer.invoke("camera:status"),
	setPresentationBudget: (megabytesPerSecond: number): Promise<number> =>
		ipcRenderer.invoke("camera:presentation-budget", megabytesPerSecond),
	onFrame: (listener: (frame: RendererCameraFrame) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, frame: RendererCameraFrame) =>
			listener(frame);
		ipcRenderer.on("camera:frame", handler);
		return () => ipcRenderer.removeListener("camera:frame", handler);
	}
});

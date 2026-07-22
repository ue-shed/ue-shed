import type { AuthoringAuthority, AuthoringSessionIntent } from "@ue-shed/authoring-sdk";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewCandidatePreviewResult,
	MapReviewResult
} from "@ue-shed/extension-camera-review/client";
import type {
	CameraScheduleConfig,
	CameraStatus,
	EditorPlaySessionCommand,
	EditorPlaySessionCommandResponse,
	EditorPlaySessionStateResponse
} from "@ue-shed/protocol";
import type {
	WorldScoutFocusResult,
	WorldScoutRefreshRate,
	WorldScoutResult
} from "@ue-shed/observatory";
import { contextBridge, ipcRenderer } from "electron";
import type {
	FixtureLaunchResult,
	RendererCameraFrame,
	RendererWorldObservationEvent,
	ShowcaseContext,
	WorkbenchCameraMetrics
} from "./ipc-contracts.js";

export type {
	FixtureLaunchResult,
	RendererCameraFrame,
	RendererWorldObservationEvent,
	ShowcaseContext,
	WorkbenchCameraMetrics
} from "./ipc-contracts.js";

contextBridge.exposeInMainWorld("ueShed", {
	editorSession: {
		status: (): Promise<EditorPlaySessionStateResponse> =>
			ipcRenderer.invoke("editor-session:status"),
		execute: (command: EditorPlaySessionCommand): Promise<EditorPlaySessionCommandResponse> =>
			ipcRenderer.invoke("editor-session:execute", command)
	},
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
		listSessions: (): Promise<unknown> => ipcRenderer.invoke("authoring:session:list"),
		openSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:open", sessionId),
		discardSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:discard", sessionId),
		editSession: (intent: AuthoringSessionIntent): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:edit", intent),
		reviewSession: (sessionId: string): Promise<unknown> =>
			ipcRenderer.invoke("authoring:session:review", sessionId),
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
		openCatalogTable: (objectPath: string, authority: AuthoringAuthority): Promise<unknown> =>
			ipcRenderer.invoke("authoring:open-catalog-table", objectPath, authority),
		chooseTable: (): Promise<unknown> => ipcRenderer.invoke("authoring:choose-table")
	},
	fixture: {
		launch: (): Promise<FixtureLaunchResult> => ipcRenderer.invoke("fixture:launch"),
		launchReview: (): Promise<FixtureLaunchResult> =>
			ipcRenderer.invoke("fixture:launch-review")
	},
	mapReview: {
		worldSnapshot: (): Promise<WorldScoutResult> =>
			ipcRenderer.invoke("map-review:world-snapshot"),
		focusActor: (actorId: string, bringToFront: boolean): Promise<WorldScoutFocusResult> =>
			ipcRenderer.invoke("map-review:focus-actor", actorId, bringToFront),
		approveCandidate: (
			intent: MapReviewApproveCandidateIntent
		): Promise<MapReviewApprovalResult> =>
			ipcRenderer.invoke("map-review:approve-candidate", intent),
		authorFromSelection: (): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:author-from-selection"),
		authoringResume: (): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:authoring-resume"),
		authoringPatch: (
			intent: MapReviewAuthoringPatchIntent
		): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:authoring-patch", intent),
		authoringReframe: (
			intent: MapReviewAuthoringSessionIntent
		): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:authoring-reframe", intent),
		discardAuthoring: (
			intent: MapReviewAuthoringSessionIntent
		): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:authoring-discard", intent),
		previewAuthoringCandidate: (
			intent: MapReviewAuthoringPreviewIntent
		): Promise<MapReviewCandidatePreviewResult> =>
			ipcRenderer.invoke("map-review:preview-authoring-candidate", intent),
		approveAuthoring: (
			intent: MapReviewAuthoringSessionIntent
		): Promise<MapReviewApprovalResult> =>
			ipcRenderer.invoke("map-review:approve-authoring", intent),
		previewCandidate: (candidateId: string): Promise<MapReviewCandidatePreviewResult> =>
			ipcRenderer.invoke("map-review:preview-candidate", candidateId),
		capture: (intent: MapReviewCaptureIntent): Promise<MapReviewCaptureResult> =>
			ipcRenderer.invoke("map-review:capture", intent),
		load: (): Promise<MapReviewResult> => ipcRenderer.invoke("map-review:load"),
		setLivePreviewFps: (fps: number): Promise<number> =>
			ipcRenderer.invoke("map-review:set-live-preview-fps", fps),
		subscribeWorldObservations: (cadenceHz: WorldScoutRefreshRate): Promise<void> =>
			ipcRenderer.invoke("map-review:subscribe-world-observations", cadenceHz),
		setWorldObservationRate: (
			cadenceHz: WorldScoutRefreshRate
		): Promise<WorldScoutRefreshRate> =>
			ipcRenderer.invoke("map-review:set-world-observation-rate", cadenceHz),
		unsubscribeWorldObservations: (): Promise<void> =>
			ipcRenderer.invoke("map-review:unsubscribe-world-observations")
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
	},
	onWorldObservation: (listener: (event: RendererWorldObservationEvent) => void) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			observation: RendererWorldObservationEvent
		) => listener(observation);
		ipcRenderer.on("map-review:world-observation", handler);
		return () => ipcRenderer.removeListener("map-review:world-observation", handler);
	}
});

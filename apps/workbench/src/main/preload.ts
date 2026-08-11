import type { AuthoringAuthority, AuthoringSessionIntent } from "@ue-shed/authoring-sdk";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPatchIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewReplaceVisibilityPolicyIntent,
	MapReviewCandidatePreviewResult,
	MapReviewResult,
	MapReviewSetCreateIntent,
	MapReviewSetLibraryResult,
	MapReviewSetSelectIntent
} from "@ue-shed/extension-camera-review/client";
import type { ContentObservatoryHistoryRequestWire } from "@ue-shed/extension-content-observatory/client";
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
import type { SavedWorld } from "@ue-shed/protocol";
import { contextBridge, ipcRenderer } from "electron";
import type {
	CameraStatusResult,
	FixtureLaunchResult,
	RendererCameraFrame,
	RendererWorldObservationEvent,
	ShowcaseContext,
	UnrealConnectionSettings,
	WorkbenchCameraMetrics
} from "./ipc-contracts.js";
import type {
	ProjectLaunchMode,
	ProjectLaunchResult,
	WorkbenchProjectState,
	WorkbenchTaskProgress
} from "./project-workspace-contract.js";

export type {
	CameraStatusResult,
	FixtureLaunchResult,
	RendererCameraFrame,
	RendererWorldObservationEvent,
	ShowcaseContext,
	UnrealConnectionSettings,
	WorkbenchCameraMetrics
} from "./ipc-contracts.js";
export type {
	ProjectLaunchMode,
	ProjectLaunchResult,
	WorkbenchProjectState,
	WorkbenchTaskProgress
} from "./project-workspace-contract.js";

contextBridge.exposeInMainWorld("ueShed", {
	assetNavigation: {
		locate: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("asset-navigation:locate", objectPath)
	},
	editorSession: {
		settings: (): Promise<UnrealConnectionSettings> =>
			ipcRenderer.invoke("editor-session:settings"),
		setPort: (port: number): Promise<UnrealConnectionSettings> =>
			ipcRenderer.invoke("editor-session:set-port", port),
		status: (): Promise<EditorPlaySessionStateResponse> =>
			ipcRenderer.invoke("editor-session:status"),
		execute: (command: EditorPlaySessionCommand): Promise<EditorPlaySessionCommandResponse> =>
			ipcRenderer.invoke("editor-session:execute", command)
	},
	showcase: {
		context: (): Promise<ShowcaseContext> => ipcRenderer.invoke("showcase:context")
	},
	project: {
		choose: (): Promise<WorkbenchProjectState> => ipcRenderer.invoke("project:choose"),
		current: (): Promise<WorkbenchProjectState> => ipcRenderer.invoke("project:current"),
		launch: (mode: ProjectLaunchMode): Promise<ProjectLaunchResult> =>
			ipcRenderer.invoke("project:launch", mode),
		progress: (): Promise<WorkbenchTaskProgress> => ipcRenderer.invoke("project:progress")
	},
	assetAudits: {
		loadConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:configured-scan"),
		chooseProjectAndScan: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:choose-and-scan"),
		refreshConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:configured-refresh"),
		chooseProjectAndRefresh: (): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:choose-and-refresh"),
		progress: (): Promise<unknown> => ipcRenderer.invoke("asset-audits:textures:progress"),
		search: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:search", request),
		record: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:record", objectPath),
		preview: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:preview", objectPath),
		previewOffline: (objectPath: string): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:preview-offline", objectPath),
		previewOfflineBatch: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("asset-audits:textures:preview-offline-batch", request)
	},
	gameText: {
		loadConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:configured-scan"),
		chooseProjectAndScan: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:choose-and-scan"),
		refreshConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:configured-refresh"),
		chooseProjectAndRefresh: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:choose-and-refresh"),
		progress: (): Promise<unknown> => ipcRenderer.invoke("game-text:progress"),
		search: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("game-text:search", request),
		focus: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("game-text:focus", request),
		chooseQualityRules: (): Promise<unknown> =>
			ipcRenderer.invoke("game-text:quality:choose-rules"),
		qualitySearch: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("game-text:quality:search", request),
		qualityFocus: (request: unknown): Promise<unknown> =>
			ipcRenderer.invoke("game-text:quality:focus", request)
	},
	inputAtlas: {
		loadConfiguredProject: (): Promise<unknown> =>
			ipcRenderer.invoke("input-atlas:configured-scan"),
		chooseProjectAndScan: (): Promise<unknown> =>
			ipcRenderer.invoke("input-atlas:choose-and-scan")
	},
	contentObservatory: {
		status: (): Promise<unknown> => ipcRenderer.invoke("content-observatory:status"),
		targets: (mapPath: string): Promise<unknown> =>
			ipcRenderer.invoke("content-observatory:targets", mapPath),
		start: (request: ContentObservatoryHistoryRequestWire): Promise<unknown> =>
			ipcRenderer.invoke("content-observatory:start", request),
		cancel: (): Promise<unknown> => ipcRenderer.invoke("content-observatory:cancel")
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
		createReviewSet: (intent: MapReviewSetCreateIntent): Promise<MapReviewResult> =>
			ipcRenderer.invoke("map-review:create-review-set", intent),
		applyVisibilityPolicy: (
			intent: MapReviewApplyVisibilityPolicyIntent
		): Promise<MapReviewResult> =>
			ipcRenderer.invoke("map-review:apply-visibility-policy", intent),
		worldSnapshot: (): Promise<WorldScoutResult> =>
			ipcRenderer.invoke("map-review:world-snapshot"),
		savedWorld: (mapPath: string): Promise<SavedWorld> =>
			ipcRenderer.invoke("map-review:saved-world", mapPath),
		savedWorldMaps: (): Promise<
			readonly { readonly label: string; readonly mapPath: string }[]
		> => ipcRenderer.invoke("map-review:saved-world-maps"),
		chooseProjectAndMaps: (): Promise<unknown> =>
			ipcRenderer.invoke("map-review:choose-project-and-maps"),
		focusActor: (actorId: string, bringToFront: boolean): Promise<WorldScoutFocusResult> =>
			ipcRenderer.invoke("map-review:focus-actor", actorId, bringToFront),
		approveCandidate: (
			intent: MapReviewApproveCandidateIntent
		): Promise<MapReviewApprovalResult> =>
			ipcRenderer.invoke("map-review:approve-candidate", intent),
		authorFromSelection: (
			intent: MapReviewAuthorFromSelectionIntent
		): Promise<MapReviewAuthoringResult> =>
			ipcRenderer.invoke("map-review:author-from-selection", intent),
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
		reviewSets: (): Promise<MapReviewSetLibraryResult> =>
			ipcRenderer.invoke("map-review:review-sets"),
		replaceVisibilityPolicy: (
			intent: MapReviewReplaceVisibilityPolicyIntent
		): Promise<MapReviewResult> =>
			ipcRenderer.invoke("map-review:replace-visibility-policy", intent),
		setLivePreviewFps: (fps: number): Promise<number> =>
			ipcRenderer.invoke("map-review:set-live-preview-fps", fps),
		selectReviewSet: (intent: MapReviewSetSelectIntent): Promise<MapReviewResult> =>
			ipcRenderer.invoke("map-review:select-review-set", intent),
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
	getStatus: (): Promise<CameraStatusResult> => ipcRenderer.invoke("camera:status"),
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

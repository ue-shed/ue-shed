import type { AuthoringAuthority, AuthoringSessionIntent } from "@ue-shed/authoring-sdk";
import type {
	MapReviewApprovalResult,
	MapReviewApproveCandidateIntent,
	MapReviewAuthorFromSelectionIntent,
	MapReviewAuthoringPreviewIntent,
	MapReviewAuthoringResult,
	MapReviewAuthoringSessionIntent,
	MapReviewCaptureIntent,
	MapReviewCaptureResult,
	MapReviewApplyVisibilityPolicyIntent,
	MapReviewCandidatePreviewResult,
	MapReviewResult,
	MapReviewSetCreateIntent,
	MapReviewSetLibraryResult,
	MapReviewSetSelectIntent
} from "@ue-shed/extension-camera-review/client";
import type { MapCaptureProgressEvent } from "@ue-shed/extension-camera-review/map-capture-client";
import type { ContentObservatoryHistoryRequestWire } from "@ue-shed/extension-content-observatory/client";
import type {
	CameraScheduleConfig,
	CameraStatus,
	EditorPlaySessionCommand,
	EditorPlaySessionCommandResponse
} from "@ue-shed/protocol";
import type { WorldScoutFocusResult, WorldScoutResult } from "@ue-shed/observatory";
import type { SavedWorld } from "@ue-shed/protocol";
import type { ScenarioRun, ScenarioRunHandle, ScenarioRunnerStatus } from "@ue-shed/scenarios";
import { contextBridge, ipcRenderer } from "electron";
import type {
	CameraStatusResult,
	ConfigExplorerQuery,
	ConfigExplorerQueryResult,
	EditorSessionStatusResult,
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
import type { WorkbenchRendererApi } from "./preload-contract.js";

export type {
	CameraStatusResult,
	ConfigExplorerQuery,
	ConfigExplorerQueryResult,
	EditorSessionStatusResult,
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

const workbenchRendererApi = {
	assetNavigation: {
		locate: (objectPath: string) => ipcRenderer.invoke("asset-navigation:locate", objectPath)
	},
	editorSession: {
		settings: (): Promise<UnrealConnectionSettings> =>
			ipcRenderer.invoke("editor-session:settings"),
		setPort: (port: number): Promise<UnrealConnectionSettings> =>
			ipcRenderer.invoke("editor-session:set-port", port),
		status: (): Promise<EditorSessionStatusResult> =>
			ipcRenderer.invoke("editor-session:status"),
		execute: (command: EditorPlaySessionCommand): Promise<EditorPlaySessionCommandResponse> =>
			ipcRenderer.invoke("editor-session:execute", command)
	},
	scenarios: {
		cancel: (handle: ScenarioRunHandle): Promise<ScenarioRun> =>
			ipcRenderer.invoke("scenario:cancel", handle),
		start: (document, endpoint) => ipcRenderer.invoke("scenario:start", document, endpoint),
		status: (handle: ScenarioRunHandle): Promise<ScenarioRunnerStatus> =>
			ipcRenderer.invoke("scenario:status", handle)
	},
	showcase: {
		context: (): Promise<ShowcaseContext> => ipcRenderer.invoke("showcase:context")
	},
	configExplorer: {
		query: (request: ConfigExplorerQuery): Promise<ConfigExplorerQueryResult> =>
			ipcRenderer.invoke("config-explorer:query", request)
	},
	projectCustodian: {
		configuredScan: () => ipcRenderer.invoke("project-custodian:configured-scan"),
		chooseAndScan: () => ipcRenderer.invoke("project-custodian:choose-and-scan"),
		prepare: (intent) => ipcRenderer.invoke("project-custodian:prepare", intent),
		execute: (intent) => ipcRenderer.invoke("project-custodian:execute", intent),
		cancel: (proposalId: string) => ipcRenderer.invoke("project-custodian:cancel", proposalId)
	},
	project: {
		choose: (): Promise<WorkbenchProjectState> => ipcRenderer.invoke("project:choose"),
		current: (): Promise<WorkbenchProjectState> => ipcRenderer.invoke("project:current"),
		launch: (mode: ProjectLaunchMode): Promise<ProjectLaunchResult> =>
			ipcRenderer.invoke("project:launch", mode),
		progress: (): Promise<WorkbenchTaskProgress> => ipcRenderer.invoke("project:progress")
	},
	assetAudits: {
		loadConfiguredProject: () => ipcRenderer.invoke("asset-audits:textures:configured-scan"),
		chooseProjectAndScan: () => ipcRenderer.invoke("asset-audits:textures:choose-and-scan"),
		refreshConfiguredProject: () =>
			ipcRenderer.invoke("asset-audits:textures:configured-refresh"),
		chooseProjectAndRefresh: () =>
			ipcRenderer.invoke("asset-audits:textures:choose-and-refresh"),
		progress: () => ipcRenderer.invoke("asset-audits:textures:progress"),
		search: (request) => ipcRenderer.invoke("asset-audits:textures:search", request),
		record: (objectPath: string) =>
			ipcRenderer.invoke("asset-audits:textures:record", objectPath),
		preview: (objectPath: string) =>
			ipcRenderer.invoke("asset-audits:textures:preview", objectPath),
		previewOffline: (objectPath: string) =>
			ipcRenderer.invoke("asset-audits:textures:preview-offline", objectPath),
		previewOfflineBatch: (request) =>
			ipcRenderer.invoke("asset-audits:textures:preview-offline-batch", request)
	},
	gameText: {
		loadConfiguredProject: () => ipcRenderer.invoke("game-text:configured-scan"),
		chooseProjectAndScan: () => ipcRenderer.invoke("game-text:choose-and-scan"),
		refreshConfiguredProject: () => ipcRenderer.invoke("game-text:configured-refresh"),
		chooseProjectAndRefresh: () => ipcRenderer.invoke("game-text:choose-and-refresh"),
		progress: () => ipcRenderer.invoke("game-text:progress"),
		search: (request) => ipcRenderer.invoke("game-text:search", request),
		focus: (request) => ipcRenderer.invoke("game-text:focus", request),
		chooseQualityRules: () => ipcRenderer.invoke("game-text:quality:choose-rules"),
		previewQualityRules: (document) =>
			ipcRenderer.invoke("game-text:quality:preview-rules", document),
		saveQualityRules: (document) =>
			ipcRenderer.invoke("game-text:quality:save-rules", document),
		qualitySearch: (request) => ipcRenderer.invoke("game-text:quality:search", request),
		qualityFocus: (request) => ipcRenderer.invoke("game-text:quality:focus", request)
	},
	inputAtlas: {
		loadConfiguredProject: () => ipcRenderer.invoke("input-atlas:configured-scan"),
		chooseProjectAndScan: () => ipcRenderer.invoke("input-atlas:choose-and-scan")
	},
	contentObservatory: {
		status: () => ipcRenderer.invoke("content-observatory:status"),
		targets: (mapPath: string) => ipcRenderer.invoke("content-observatory:targets", mapPath),
		start: (request: ContentObservatoryHistoryRequestWire) =>
			ipcRenderer.invoke("content-observatory:start", request),
		cancel: () => ipcRenderer.invoke("content-observatory:cancel")
	},
	authoring: {
		beginSession: (objectPath: string) =>
			ipcRenderer.invoke("authoring:session:begin", objectPath),
		listSessions: () => ipcRenderer.invoke("authoring:session:list"),
		openSession: (sessionId: string) => ipcRenderer.invoke("authoring:session:open", sessionId),
		discardSession: (sessionId: string) =>
			ipcRenderer.invoke("authoring:session:discard", sessionId),
		editSession: (intent: AuthoringSessionIntent) =>
			ipcRenderer.invoke("authoring:session:edit", intent),
		reviewSession: (sessionId: string) =>
			ipcRenderer.invoke("authoring:session:review", sessionId),
		applySession: (sessionId: string) =>
			ipcRenderer.invoke("authoring:session:apply", sessionId),
		reconcileSession: (sessionId: string) =>
			ipcRenderer.invoke("authoring:session:reconcile", sessionId),
		saveSession: (sessionId: string) => ipcRenderer.invoke("authoring:session:save", sessionId),
		undoSession: (sessionId: string) => ipcRenderer.invoke("authoring:session:undo", sessionId),
		redoSession: (sessionId: string) => ipcRenderer.invoke("authoring:session:redo", sessionId),
		loadConfiguredCatalog: () => ipcRenderer.invoke("authoring:configured-catalog"),
		loadConfiguredTable: () => ipcRenderer.invoke("authoring:configured-table"),
		openCatalogTable: (objectPath: string, authority: AuthoringAuthority) =>
			ipcRenderer.invoke("authoring:open-catalog-table", objectPath, authority),
		chooseTable: () => ipcRenderer.invoke("authoring:choose-table")
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
		chooseProjectAndMaps: () => ipcRenderer.invoke("map-review:choose-project-and-maps"),
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
		authoringPatch: (intent) => ipcRenderer.invoke("map-review:authoring-patch", intent),
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
		replaceVisibilityPolicy: (intent) =>
			ipcRenderer.invoke("map-review:replace-visibility-policy", intent),
		setLivePreviewFps: (fps: number): Promise<number> =>
			ipcRenderer.invoke("map-review:set-live-preview-fps", fps),
		selectReviewSet: (intent: MapReviewSetSelectIntent): Promise<MapReviewResult> =>
			ipcRenderer.invoke("map-review:select-review-set", intent),
		subscribeWorldObservations: (cadenceHz) =>
			ipcRenderer.invoke("map-review:subscribe-world-observations", cadenceHz),
		setWorldObservationRate: (cadenceHz) =>
			ipcRenderer.invoke("map-review:set-world-observation-rate", cadenceHz),
		unsubscribeWorldObservations: (): Promise<undefined> =>
			ipcRenderer.invoke("map-review:unsubscribe-world-observations")
	},
	mapCapture: {
		actors: (mapPath: string) => ipcRenderer.invoke("map-capture:actors", mapPath),
		choosePlan: () => ipcRenderer.invoke("map-capture:choose-plan"),
		newPlan: () => ipcRenderer.invoke("map-capture:new-plan"),
		openMap: (plan) => ipcRenderer.invoke("map-capture:open-map", plan),
		preview: (plan) => ipcRenderer.invoke("map-capture:preview", plan),
		savePlan: (intent) => ipcRenderer.invoke("map-capture:save-plan", intent),
		capture: (intent) => ipcRenderer.invoke("map-capture:capture", intent),
		tile: (intent) => ipcRenderer.invoke("map-capture:tile", intent),
		onProgress: (listener: (progress: MapCaptureProgressEvent) => void) => {
			const handler = (
				_event: Electron.IpcRendererEvent,
				progress: MapCaptureProgressEvent
			) => listener(progress);
			ipcRenderer.on("map-capture:progress", handler);
			return () => ipcRenderer.removeListener("map-capture:progress", handler);
		}
	},
	niagaraPreview: {
		run: (intent) => ipcRenderer.invoke("niagara-preview:run", intent),
		frame: (intent) => ipcRenderer.invoke("niagara-preview:frame", intent)
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
} satisfies WorkbenchRendererApi;

contextBridge.exposeInMainWorld("ueShed", workbenchRendererApi);

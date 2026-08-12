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
	CameraStatusResult,
	ConfigExplorerQuery,
	ConfigExplorerQueryResult,
	RendererCameraFrame,
	RendererWorldObservationEvent,
	FixtureLaunchResult,
	ShowcaseContext,
	UnrealConnectionSettings,
	WorkbenchCameraMetrics
} from "../main/preload.js";
import type { WorkbenchProjectState } from "../main/project-workspace-contract.js";
import type { ProjectLaunchMode, ProjectLaunchResult } from "../main/project-workspace-contract.js";
import type {
	ScenarioDocument,
	ScenarioRun,
	ScenarioRunHandle,
	ScenarioRunnerStatus
} from "@ue-shed/scenarios";

declare global {
	interface Window {
		readonly ueShed: {
			readonly mapCapture: {
				readonly choosePlan: () => Promise<unknown>;
				readonly openMap: (plan: unknown) => Promise<unknown>;
				readonly capture: (intent: unknown) => Promise<unknown>;
			};
			readonly configExplorer: {
				readonly query: (
					request: ConfigExplorerQuery
				) => Promise<ConfigExplorerQueryResult>;
			};
			readonly assetNavigation: {
				readonly locate: (objectPath: string) => Promise<unknown>;
			};
			readonly editorSession: {
				readonly settings: () => Promise<UnrealConnectionSettings>;
				readonly setPort: (port: number) => Promise<UnrealConnectionSettings>;
				readonly status: () => Promise<EditorPlaySessionStateResponse>;
				readonly execute: (
					command: EditorPlaySessionCommand
				) => Promise<EditorPlaySessionCommandResponse>;
			};
			readonly scenarios: {
				readonly cancel: (handle: ScenarioRunHandle) => Promise<ScenarioRun>;
				readonly start: (
					document: ScenarioDocument,
					endpoint: string
				) => Promise<ScenarioRunHandle>;
				readonly status: (handle: ScenarioRunHandle) => Promise<ScenarioRunnerStatus>;
			};
			readonly showcase: {
				readonly context: () => Promise<ShowcaseContext>;
			};
			readonly project: {
				readonly choose: () => Promise<WorkbenchProjectState>;
				readonly current: () => Promise<WorkbenchProjectState>;
				readonly launch: (mode: ProjectLaunchMode) => Promise<ProjectLaunchResult>;
				readonly progress: () => Promise<unknown>;
			};
			readonly assetAudits: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
				readonly refreshConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndRefresh: () => Promise<unknown>;
				readonly progress: () => Promise<unknown>;
				readonly search: (request: unknown) => Promise<unknown>;
				readonly record: (objectPath: string) => Promise<unknown>;
				readonly preview: (objectPath: string) => Promise<unknown>;
				readonly previewOffline: (objectPath: string) => Promise<unknown>;
				readonly previewOfflineBatch: (request: unknown) => Promise<unknown>;
			};
			readonly gameText: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
				readonly refreshConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndRefresh: () => Promise<unknown>;
				readonly progress: () => Promise<unknown>;
				readonly search: (request: unknown) => Promise<unknown>;
				readonly focus: (request: unknown) => Promise<unknown>;
				readonly chooseQualityRules: () => Promise<unknown>;
				readonly previewQualityRules: (document: unknown) => Promise<unknown>;
				readonly saveQualityRules: (document: unknown) => Promise<unknown>;
				readonly qualitySearch: (request: unknown) => Promise<unknown>;
				readonly qualityFocus: (request: unknown) => Promise<unknown>;
			};
			readonly inputAtlas: {
				readonly loadConfiguredProject: () => Promise<unknown>;
				readonly chooseProjectAndScan: () => Promise<unknown>;
			};
			readonly contentObservatory: {
				readonly status: () => Promise<unknown>;
				readonly targets: (mapPath: string) => Promise<unknown>;
				readonly start: (request: ContentObservatoryHistoryRequestWire) => Promise<unknown>;
				readonly cancel: () => Promise<unknown>;
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
				readonly openCatalogTable: (
					objectPath: string,
					authority: AuthoringAuthority
				) => Promise<unknown>;
				readonly chooseTable: () => Promise<unknown>;
			};
			readonly fixture: {
				readonly launch: () => Promise<FixtureLaunchResult>;
				readonly launchReview: () => Promise<FixtureLaunchResult>;
			};
			readonly mapReview: {
				readonly createReviewSet: (
					intent: MapReviewSetCreateIntent
				) => Promise<MapReviewResult>;
				readonly applyVisibilityPolicy: (
					intent: MapReviewApplyVisibilityPolicyIntent
				) => Promise<MapReviewResult>;
				readonly worldSnapshot: () => Promise<WorldScoutResult>;
				readonly savedWorld: (mapPath: string) => Promise<SavedWorld>;
				readonly savedWorldMaps: () => Promise<
					readonly { readonly label: string; readonly mapPath: string }[]
				>;
				readonly chooseProjectAndMaps: () => Promise<unknown>;
				readonly focusActor: (
					actorId: string,
					bringToFront: boolean
				) => Promise<WorldScoutFocusResult>;
				readonly approveCandidate: (
					intent: MapReviewApproveCandidateIntent
				) => Promise<MapReviewApprovalResult>;
				readonly authorFromSelection: (
					intent: MapReviewAuthorFromSelectionIntent
				) => Promise<MapReviewAuthoringResult>;
				readonly authoringResume: () => Promise<MapReviewAuthoringResult>;
				readonly authoringPatch: (
					intent: MapReviewAuthoringPatchIntent
				) => Promise<MapReviewAuthoringResult>;
				readonly authoringReframe: (
					intent: MapReviewAuthoringSessionIntent
				) => Promise<MapReviewAuthoringResult>;
				readonly discardAuthoring: (
					intent: MapReviewAuthoringSessionIntent
				) => Promise<MapReviewAuthoringResult>;
				readonly previewAuthoringCandidate: (
					intent: MapReviewAuthoringPreviewIntent
				) => Promise<MapReviewCandidatePreviewResult>;
				readonly approveAuthoring: (
					intent: MapReviewAuthoringSessionIntent
				) => Promise<MapReviewApprovalResult>;
				readonly previewCandidate: (
					candidateId: string
				) => Promise<MapReviewCandidatePreviewResult>;
				readonly capture: (
					intent: MapReviewCaptureIntent
				) => Promise<MapReviewCaptureResult>;
				readonly load: () => Promise<MapReviewResult>;
				readonly reviewSets: () => Promise<MapReviewSetLibraryResult>;
				readonly replaceVisibilityPolicy: (
					intent: MapReviewReplaceVisibilityPolicyIntent
				) => Promise<MapReviewResult>;
				readonly setLivePreviewFps: (fps: number) => Promise<number>;
				readonly selectReviewSet: (
					intent: MapReviewSetSelectIntent
				) => Promise<MapReviewResult>;
				readonly subscribeWorldObservations: (
					cadenceHz: WorldScoutRefreshRate
				) => Promise<void>;
				readonly setWorldObservationRate: (
					cadenceHz: WorldScoutRefreshRate
				) => Promise<WorldScoutRefreshRate>;
				readonly unsubscribeWorldObservations: () => Promise<void>;
			};
			readonly configure: (config: CameraScheduleConfig) => Promise<CameraStatus>;
			readonly getMetrics: () => Promise<WorkbenchCameraMetrics>;
			readonly getStatus: () => Promise<CameraStatusResult>;
			readonly onFrame: (listener: (frame: RendererCameraFrame) => void) => () => void;
			readonly onWorldObservation: (
				listener: (event: RendererWorldObservationEvent) => void
			) => () => void;
			readonly setPresentationBudget: (megabytesPerSecond: number) => Promise<number>;
		};
	}
}

export {};

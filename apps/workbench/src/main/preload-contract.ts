import type {
	InvokeArguments,
	InvokeChannel,
	InvokeResult,
	RendererCameraFrame,
	RendererWorldObservationEvent
} from "./ipc-contracts.js";
import type { MapCaptureProgressEvent } from "@ue-shed/extension-camera-review/map-capture-client";

export const workbenchInvokeChannels = {
	assetNavigation: { locate: "asset-navigation:locate" },
	blueprintGraphs: {
		choose: "blueprint-graphs:choose",
		read: "blueprint-graphs:read"
	},
	editorSession: {
		settings: "editor-session:settings",
		setPort: "editor-session:set-port",
		status: "editor-session:status",
		execute: "editor-session:execute"
	},
	scenarios: {
		cancel: "scenario:cancel",
		start: "scenario:start",
		status: "scenario:status"
	},
	showcase: { context: "showcase:context" },
	configExplorer: { query: "config-explorer:query" },
	projectCustodian: {
		configuredScan: "project-custodian:configured-scan",
		chooseAndScan: "project-custodian:choose-and-scan",
		prepare: "project-custodian:prepare",
		execute: "project-custodian:execute",
		cancel: "project-custodian:cancel"
	},
	project: {
		choose: "project:choose",
		current: "project:current",
		launch: "project:launch",
		progress: "project:progress"
	},
	assetAudits: {
		loadConfiguredProject: "asset-audits:textures:configured-scan",
		chooseProjectAndScan: "asset-audits:textures:choose-and-scan",
		refreshConfiguredProject: "asset-audits:textures:configured-refresh",
		chooseProjectAndRefresh: "asset-audits:textures:choose-and-refresh",
		progress: "asset-audits:textures:progress",
		search: "asset-audits:textures:search",
		record: "asset-audits:textures:record",
		preview: "asset-audits:textures:preview",
		previewOffline: "asset-audits:textures:preview-offline",
		previewOfflineBatch: "asset-audits:textures:preview-offline-batch"
	},
	gameText: {
		loadConfiguredProject: "game-text:configured-scan",
		chooseProjectAndScan: "game-text:choose-and-scan",
		refreshConfiguredProject: "game-text:configured-refresh",
		chooseProjectAndRefresh: "game-text:choose-and-refresh",
		progress: "game-text:progress",
		search: "game-text:search",
		focus: "game-text:focus",
		chooseQualityRules: "game-text:quality:choose-rules",
		previewQualityRules: "game-text:quality:preview-rules",
		saveQualityRules: "game-text:quality:save-rules",
		qualitySearch: "game-text:quality:search",
		qualityFocus: "game-text:quality:focus"
	},
	inputAtlas: {
		loadConfiguredProject: "input-atlas:configured-scan",
		chooseProjectAndScan: "input-atlas:choose-and-scan"
	},
	contentObservatory: {
		status: "content-observatory:status",
		targets: "content-observatory:targets",
		start: "content-observatory:start",
		cancel: "content-observatory:cancel"
	},
	authoring: {
		beginSession: "authoring:session:begin",
		listSessions: "authoring:session:list",
		openSession: "authoring:session:open",
		discardSession: "authoring:session:discard",
		editSession: "authoring:session:edit",
		reviewSession: "authoring:session:review",
		applySession: "authoring:session:apply",
		reconcileSession: "authoring:session:reconcile",
		saveSession: "authoring:session:save",
		undoSession: "authoring:session:undo",
		redoSession: "authoring:session:redo",
		loadConfiguredCatalog: "authoring:configured-catalog",
		loadConfiguredTable: "authoring:configured-table",
		openCatalogTable: "authoring:open-catalog-table",
		chooseTable: "authoring:choose-table"
	},
	fixture: {
		launch: "fixture:launch",
		launchReview: "fixture:launch-review"
	},
	mapReview: {
		createReviewSet: "map-review:create-review-set",
		applyVisibilityPolicy: "map-review:apply-visibility-policy",
		worldSnapshot: "map-review:world-snapshot",
		savedWorld: "map-review:saved-world",
		savedWorldMaps: "map-review:saved-world-maps",
		chooseProjectAndMaps: "map-review:choose-project-and-maps",
		focusActor: "map-review:focus-actor",
		approveCandidate: "map-review:approve-candidate",
		authorFromSelection: "map-review:author-from-selection",
		authoringResume: "map-review:authoring-resume",
		authoringPatch: "map-review:authoring-patch",
		authoringReframe: "map-review:authoring-reframe",
		discardAuthoring: "map-review:authoring-discard",
		previewAuthoringCandidate: "map-review:preview-authoring-candidate",
		approveAuthoring: "map-review:approve-authoring",
		previewCandidate: "map-review:preview-candidate",
		capture: "map-review:capture",
		load: "map-review:load",
		reviewSets: "map-review:review-sets",
		replaceVisibilityPolicy: "map-review:replace-visibility-policy",
		setLivePreviewFps: "map-review:set-live-preview-fps",
		selectReviewSet: "map-review:select-review-set",
		subscribeWorldObservations: "map-review:subscribe-world-observations",
		setWorldObservationRate: "map-review:set-world-observation-rate",
		unsubscribeWorldObservations: "map-review:unsubscribe-world-observations"
	},
	mapCapture: {
		actors: "map-capture:actors",
		choosePlan: "map-capture:choose-plan",
		newPlan: "map-capture:new-plan",
		openMap: "map-capture:open-map",
		preview: "map-capture:preview",
		savePlan: "map-capture:save-plan",
		capture: "map-capture:capture",
		tile: "map-capture:tile"
	},
	niagaraPreview: {
		catalogue: "niagara-preview:catalogue",
		run: "niagara-preview:run",
		frame: "niagara-preview:frame"
	},
	configure: "camera:configure",
	getMetrics: "camera:metrics",
	getStatus: "camera:status",
	setPresentationBudget: "camera:presentation-budget"
} as const;

type InvokeMethod<Channel extends InvokeChannel> = (
	...args: InvokeArguments<Channel>
) => Promise<InvokeResult<Channel>>;

type InvokeMapping = {
	readonly [key: string]: InvokeChannel | InvokeMapping;
};

type RendererInvokeApi<Mapping extends InvokeMapping> = {
	readonly [Key in keyof Mapping]: Mapping[Key] extends InvokeChannel
		? InvokeMethod<Mapping[Key]>
		: Mapping[Key] extends InvokeMapping
			? RendererInvokeApi<Mapping[Key]>
			: never;
};

type Invokes = RendererInvokeApi<typeof workbenchInvokeChannels>;

export type WorkbenchRendererApi = Omit<Invokes, "mapCapture"> & {
	readonly mapCapture: Invokes["mapCapture"] & {
		readonly onProgress: (listener: (progress: MapCaptureProgressEvent) => void) => () => void;
	};
	readonly onFrame: (listener: (frame: RendererCameraFrame) => void) => () => void;
	readonly onWorldObservation: (
		listener: (event: RendererWorldObservationEvent) => void
	) => () => void;
};

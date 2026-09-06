import { AuthoringValue } from "@ue-shed/protocol";
import { CustodianExecutionMode, CustodianTargetId } from "@ue-shed/project-custodian";
import {
	GitCommit,
	PluginVariantIdentity,
	PluginVariantRequest,
	ReleaseVersion
} from "@ue-shed/plugin-distribution";
import { Schema } from "effect";

const Project = { projectRoot: Schema.String };
const Reader = { reader: Schema.optionalKey(Schema.String) };
const ProjectIndexTarget = {
	cacheRoot: Schema.String,
	projectRoot: Schema.String,
	...Reader
};
const SessionProject = { projectRoot: Schema.String, sessionId: Schema.String };
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const EditorPlayAction = Schema.Literals([
	"status",
	"start",
	"simulate",
	"pause",
	"resume",
	"stop"
]);

export const CliCommand = Schema.TaggedUnion({
	Version: {},
	InvestigationRun: {
		...Project,
		preset: Schema.String,
		format: Schema.Literals(["json", "csv"]),
		output: Schema.optionalKey(Schema.String),
		...Reader
	},
	Doctor: {},
	CustodianReport: { root: Schema.String },
	CustodianPlan: { root: Schema.String, ignorePressure: Schema.Boolean },
	CustodianPrepare: {
		root: Schema.String,
		ignorePressure: Schema.Boolean,
		mode: CustodianExecutionMode,
		outputDirectory: Schema.String,
		targetIds: Schema.Array(CustodianTargetId).check(Schema.isMinLength(1))
	},
	CustodianApply: { proposalPath: Schema.String, approvalPhrase: Schema.String },
	ConfigExplain: {
		project: Schema.String,
		section: Schema.String,
		key: Schema.String,
		platform: Schema.String,
		engineRoot: Schema.optionalKey(Schema.String),
		family: Schema.optionalKey(Schema.String)
	},
	ConfigCompare: {
		project: Schema.String,
		section: Schema.String,
		key: Schema.String,
		leftPlatform: Schema.String,
		rightPlatform: Schema.String,
		engineRoot: Schema.optionalKey(Schema.String),
		family: Schema.optionalKey(Schema.String)
	},
	EditorPlaySession: {
		action: EditorPlayAction,
		endpoint: Schema.String
	},
	EditorProjectLaunch: {
		engineRoot: Schema.optionalKey(Schema.String),
		projectDescriptor: Schema.String
	},
	EditorWorldOpen: {
		endpoint: Schema.String,
		mapPath: Schema.String,
		operationId: Schema.optionalKey(Schema.String)
	},
	ScenarioRun: {
		document: Schema.optionalKey(Schema.String),
		endpoint: Schema.String,
		evidenceLimit: Schema.optionalKey(PositiveInt)
	},
	AuditTextures: { ...Project, ruleFile: Schema.String, ...Reader },
	AuthoringTables: { ...Project, ...Reader },
	AuthoringRelationships: { ...Project, ...Reader },
	AuthoringJoin: {
		...Project,
		referenceFieldName: Schema.String,
		sourceTableObjectPath: Schema.String,
		...Reader
	},
	AuthoringAnalyze: {
		...Project,
		tableObjectPath: Schema.String,
		...Reader
	},
	AuthoringCatalog: { ...Project, endpoint: Schema.optionalKey(Schema.String), ...Reader },
	AuthoringParity: { ...Project, endpoint: Schema.String, ...Reader },
	AuthoringInspect: { assetPath: Schema.String, ...Reader },
	AuthoringLiveTables: { endpoint: Schema.String },
	AuthoringLiveInspect: { endpoint: Schema.String, tablePath: Schema.String },
	SessionsList: { ...Project },
	SessionsCreate: {
		...Project,
		assetPath: Schema.String,
		id: Schema.optionalKey(Schema.String),
		...Reader
	},
	SessionsShow: { ...SessionProject },
	SessionsResume: { ...SessionProject },
	SessionsClose: { ...SessionProject },
	SessionsDiscard: { ...SessionProject },
	SessionsUndo: { ...SessionProject },
	SessionsRedo: { ...SessionProject },
	SessionsSetCell: {
		...SessionProject,
		fieldName: Schema.String,
		rowId: Schema.String,
		tablePath: Schema.String,
		value: AuthoringValue
	},
	SessionsAddRow: {
		...SessionProject,
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		rowName: Schema.String,
		tablePath: Schema.String
	},
	SessionsDuplicateRow: {
		...SessionProject,
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		rowName: Schema.String,
		sourceRowId: Schema.String,
		tablePath: Schema.String
	},
	SessionsRemoveRow: { ...SessionProject, rowId: Schema.String, tablePath: Schema.String },
	SessionsRenameRow: {
		...SessionProject,
		rowId: Schema.String,
		rowName: Schema.String,
		tablePath: Schema.String
	},
	SessionsReorderRows: {
		...SessionProject,
		rowIds: Schema.Array(Schema.String),
		tablePath: Schema.String
	},
	SessionsApply: { ...SessionProject, endpoint: Schema.String },
	SessionsReconcile: { ...SessionProject, endpoint: Schema.String },
	SessionsSave: { ...SessionProject, endpoint: Schema.String },
	SessionsReview: { ...SessionProject },
	SessionsValidate: { ...SessionProject },
	SessionsDiff: { ...SessionProject },
	AssetsScan: {
		classPrefixes: Schema.optionalKey(Schema.Array(Schema.String)),
		classes: Schema.optionalKey(Schema.Array(Schema.String)),
		full: Schema.optionalKey(Schema.Boolean),
		maximumAssets: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
		names: Schema.optionalKey(Schema.Array(Schema.String)),
		path: Schema.String,
		...Reader
	},
	TextScan: { ...Project, ...Reader },
	TextSearch: { ...Project, query: Schema.String, ...Reader },
	TextReview: { ...Project, ruleFile: Schema.String, ...Reader },
	InputInspect: { path: Schema.String, ...Reader },
	ProjectIndexStatus: ProjectIndexTarget,
	ProjectIndexRefresh: ProjectIndexTarget,
	ProjectIndexRebuild: ProjectIndexTarget,
	ProjectIndexCount: {
		...ProjectIndexTarget,
		exactClasses: Schema.Array(Schema.NonEmptyString),
		classPrefixes: Schema.Array(Schema.NonEmptyString),
		classNameSuffixes: Schema.Array(Schema.NonEmptyString),
		serializedNames: Schema.Array(Schema.NonEmptyString)
	},
	ProjectIndexMaps: {
		...ProjectIndexTarget,
		cursor: Schema.optionalKey(Schema.String),
		limit: PositiveInt
	},
	ProjectIndexQuery: {
		...ProjectIndexTarget,
		cursor: Schema.optionalKey(Schema.String),
		kind: Schema.Literals([
			"exact-class",
			"class-prefix",
			"class-name-suffix",
			"serialized-name"
		]),
		limit: PositiveInt,
		values: Schema.Array(Schema.String).check(Schema.isMinLength(1))
	},
	MapHistory: {
		actorClass: Schema.optionalKey(Schema.String),
		actorGuid: Schema.optionalKey(Schema.String),
		actorPackage: Schema.optionalKey(Schema.String),
		actorPath: Schema.optionalKey(Schema.String),
		concurrency: Schema.optionalKey(PositiveInt),
		mapPath: Schema.String,
		maxChangelists: Schema.optionalKey(PositiveInt),
		maxDurationMs: Schema.optionalKey(PositiveInt),
		maxMaterializedFiles: Schema.optionalKey(PositiveInt),
		maxPackages: Schema.optionalKey(PositiveInt),
		mode: Schema.optionalKey(Schema.Literals(["deep", "fast"])),
		projectRoot: Schema.String,
		since: Schema.String,
		until: Schema.optionalKey(Schema.String)
	},
	ReviewSetValidate: { reviewSetPath: Schema.String },
	ReviewPoliciesList: { reviewSetPath: Schema.String },
	ReviewPoliciesReplace: {
		overridesPath: Schema.optionalKey(Schema.String),
		policyPath: Schema.String,
		reviewSetPath: Schema.String,
		viewId: Schema.String
	},
	ReviewPoliciesApply: {
		policyId: Schema.String,
		reviewSetPath: Schema.String,
		viewIds: Schema.Array(Schema.String).check(Schema.isMinLength(1))
	},
	ReviewViewPut: { reviewSetPath: Schema.String, viewPath: Schema.String },
	ReviewFramingCandidates: {
		endpoint: Schema.String,
		parametersPath: Schema.optionalKey(Schema.String)
	},
	ReviewFramingApprove: {
		candidateId: Schema.String,
		endpoint: Schema.String,
		parametersPath: Schema.optionalKey(Schema.String),
		reviewSetPath: Schema.String,
		viewId: Schema.String
	},
	ReviewAuthoringStart: {
		endpoint: Schema.String,
		projectRoot: Schema.String,
		reviewSetPath: Schema.String,
		viewId: Schema.String
	},
	ReviewAuthoringBootstrap: { endpoint: Schema.String, ...Project },
	ReviewAuthoringAppend: {
		endpoint: Schema.String,
		projectRoot: Schema.String,
		reviewSetPath: Schema.String
	},
	ReviewAuthoringShow: { ...SessionProject },
	ReviewAuthoringTune: { ...SessionProject, patchPath: Schema.String },
	ReviewAuthoringResume: { ...SessionProject, endpoint: Schema.String },
	ReviewAuthoringDiscard: { ...SessionProject },
	ReviewAuthoringReframe: { ...SessionProject, endpoint: Schema.String },
	ReviewAuthoringApprove: { ...SessionProject, endpoint: Schema.String },
	ReviewCapture: {
		cause: Schema.optionalKey(Schema.Literal("external_automation")),
		correlationId: Schema.optionalKey(Schema.String),
		endpoint: Schema.String,
		...Project,
		reviewSetPath: Schema.String
	},
	ReviewHistory: { ...Project },
	ReviewShow: { runPath: Schema.String },
	MapCapturePlanValidate: { planPath: Schema.String, ...Project },
	MapCaptureInspect: { planPath: Schema.String, ...Project },
	MapCaptureRun: {
		captureBackend: Schema.optionalKey(
			Schema.Literals(["lit_camera_tiles", "scene_capture_tiles", "viewport_high_resolution"])
		),
		correlationId: Schema.optionalKey(Schema.String),
		endpoint: Schema.String,
		openMap: Schema.optionalKey(Schema.Boolean),
		levels: Schema.optionalKey(
			Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
		),
		planPath: Schema.String,
		...Project,
		tilesPath: Schema.optionalKey(Schema.String)
	},
	MapCaptureRuns: { planId: Schema.String, ...Project },
	NiagaraPreview: {
		profile: Schema.optionalKey(
			Schema.Literals(["ground_impact", "projectile", "aura", "environment"])
		),
		renderMode: Schema.optionalKey(Schema.Literals(["transparent", "scene"])),
		background: Schema.optionalKey(Schema.Literals(["default", "dark", "light"])),
		cameraMode: Schema.optionalKey(Schema.Literals(["saved", "auto_fit"])),
		exposureCompensation: Schema.optionalKey(Schema.Number),
		cameraPadding: Schema.optionalKey(Schema.Number),
		captureMode: Schema.optionalKey(Schema.Literals(["component_only", "full_scene"])),
		durationSeconds: Schema.optionalKey(Schema.Number),
		engineRoot: Schema.optionalKey(Schema.String),
		frameCount: Schema.optionalKey(PositiveInt),
		height: Schema.optionalKey(PositiveInt),
		outputRoot: Schema.optionalKey(Schema.String),
		pluginDescriptor: Schema.optionalKey(Schema.String),
		projectDescriptor: Schema.String,
		runId: Schema.optionalKey(Schema.String),
		simulationFramesPerSecond: Schema.optionalKey(PositiveInt),
		startSeconds: Schema.optionalKey(Schema.Number),
		systemObjectPath: Schema.String,
		width: Schema.optionalKey(PositiveInt)
	},
	PluginsList: { manifestPath: Schema.String },
	PluginsVerify: { artifactPath: Schema.optionalKey(Schema.String), manifestPath: Schema.String },
	PluginsInstall: {
		artifactPath: Schema.optionalKey(Schema.String),
		manifestPath: Schema.String,
		...Project
	},
	PluginsBuild: {
		architecture: Schema.String,
		buildId: Schema.String,
		compiler: Schema.String,
		compilerVersion: Schema.String,
		engineRoot: Schema.String,
		engineSourceCommit: Schema.optionalKey(GitCommit),
		maximumBuildSeconds: PositiveInt,
		outputDirectory: Schema.String,
		platform: Schema.String,
		pluginIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
		sourceArtifactDigest: Schema.String,
		sourceArtifactPath: Schema.String,
		sourceManifestDigest: Schema.String,
		sourceManifestPath: Schema.String,
		toolchain: Schema.String,
		toolchainVersion: Schema.String,
		targetTriple: Schema.optionalKey(Schema.String),
		unrealVersion: Schema.String
	},
	PluginsCacheInstall: {
		artifact: PluginVariantRequest,
		artifactDigest: Schema.optionalKey(Schema.String),
		cacheOnly: Schema.Boolean,
		cacheRoot: Schema.String,
		manifestDigest: Schema.optionalKey(Schema.String),
		pluginIds: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
		releaseVersion: ReleaseVersion,
		source: Schema.String
	},
	PluginsCacheList: { cacheRoot: Schema.String },
	PluginsCacheVerify: {
		cacheRoot: Schema.String,
		releaseVersion: ReleaseVersion,
		variantIdentity: Schema.optionalKey(PluginVariantIdentity)
	},
	PluginsPrune: {
		cacheRoot: Schema.String,
		releaseVersion: ReleaseVersion,
		variantIdentity: Schema.optionalKey(PluginVariantIdentity)
	}
});

export type CliCommand = typeof CliCommand.Type;

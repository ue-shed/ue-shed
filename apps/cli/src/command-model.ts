import { AuthoringValue } from "@ue-shed/protocol";
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
	Doctor: {},
	EditorPlaySession: {
		action: EditorPlayAction,
		endpoint: Schema.String
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
	InputInspect: { path: Schema.String, ...Reader },
	ProjectIndexStatus: ProjectIndexTarget,
	ProjectIndexRefresh: ProjectIndexTarget,
	ProjectIndexRebuild: ProjectIndexTarget,
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
	PluginsList: { manifestPath: Schema.String },
	PluginsVerify: { artifactPath: Schema.optionalKey(Schema.String), manifestPath: Schema.String },
	PluginsInstall: {
		artifactPath: Schema.optionalKey(Schema.String),
		manifestPath: Schema.String,
		...Project
	}
});

export type CliCommand = typeof CliCommand.Type;

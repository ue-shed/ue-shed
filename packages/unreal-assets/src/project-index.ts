import { Context, Effect, Layer, Schema, Stream } from "effect";

export const PROJECT_INDEX_MAX_PAGE_SIZE = 256;
export const PROJECT_INDEX_MAX_DIAGNOSTICS = 64;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const BoundedIdentifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const BoundedPath = Schema.NonEmptyString.check(Schema.isMaxLength(32_767));
const BoundedMessage = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const QueryValue = Schema.NonEmptyString.check(Schema.isMaxLength(1_024));
const QueryValues = Schema.Array(QueryValue).check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const ProjectIdentity = BoundedIdentifier.pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

export const ProjectIndexGeneration = PositiveInt.pipe(Schema.brand("ProjectIndexGeneration"));
export type ProjectIndexGeneration = typeof ProjectIndexGeneration.Type;

export const ProjectIndexCursor = Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).pipe(
	Schema.brand("ProjectIndexCursor")
);
export type ProjectIndexCursor = typeof ProjectIndexCursor.Type;

export const ProjectIndexTarget = Schema.Struct({
	projectRoot: BoundedPath
});
export interface ProjectIndexTarget extends Schema.Schema.Type<typeof ProjectIndexTarget> {}

export const ProjectIndexDiagnostic = Schema.Struct({
	code: BoundedIdentifier,
	message: BoundedMessage,
	retrySafe: Schema.Boolean
});
export interface ProjectIndexDiagnostic extends Schema.Schema.Type<typeof ProjectIndexDiagnostic> {}

export const ProjectIndexSummary = Schema.Struct({
	changedPackages: NonNegativeInt,
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(ProjectIndexDiagnostic).check(
		Schema.isMaxLength(PROJECT_INDEX_MAX_DIAGNOSTICS)
	),
	generation: ProjectIndexGeneration,
	mapCount: NonNegativeInt,
	packageCount: NonNegativeInt,
	projectId: ProjectIdentity,
	removedPackages: NonNegativeInt
});
export interface ProjectIndexSummary extends Schema.Schema.Type<typeof ProjectIndexSummary> {}

export const ProjectIndexStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("absent") }),
	Schema.Struct({ status: Schema.Literal("ready"), summary: ProjectIndexSummary })
]);
export type ProjectIndexStatus = typeof ProjectIndexStatus.Type;

export const ProjectIndexRefreshEvent = Schema.TaggedUnion({
	Started: {
		operation: Schema.Literals(["refresh", "rebuild"])
	},
	Progress: {
		completedPackages: NonNegativeInt,
		phase: Schema.Literals(["enumerating", "comparing", "reading_headers", "committing"]),
		totalPackages: Schema.optionalKey(NonNegativeInt)
	},
	Completed: {
		summary: ProjectIndexSummary
	}
});
export type ProjectIndexRefreshEvent = typeof ProjectIndexRefreshEvent.Type;

const QueryBase = {
	cursor: Schema.optionalKey(ProjectIndexCursor),
	expectedGeneration: ProjectIndexGeneration,
	limit: Schema.Int.check(
		Schema.isGreaterThan(0),
		Schema.isLessThanOrEqualTo(PROJECT_INDEX_MAX_PAGE_SIZE)
	),
	projectId: ProjectIdentity
};

export const ProjectIndexQuery = Schema.TaggedUnion({
	Maps: QueryBase,
	ExactClasses: { ...QueryBase, values: QueryValues },
	ClassPrefixes: { ...QueryBase, values: QueryValues },
	ClassNameSuffixes: { ...QueryBase, values: QueryValues },
	SerializedNames: { ...QueryBase, values: QueryValues }
});
export type ProjectIndexQuery = typeof ProjectIndexQuery.Type;

export const ProjectIndexMap = Schema.Struct({
	kind: Schema.Literal("map"),
	mapPath: BoundedPath,
	packageName: BoundedPath
});
export interface ProjectIndexMap extends Schema.Schema.Type<typeof ProjectIndexMap> {}

export const ProjectIndexHeader = Schema.Struct({
	classes: Schema.Array(QueryValue).check(Schema.isMaxLength(64)),
	kind: Schema.Literal("header"),
	packageName: BoundedPath,
	packagePath: BoundedPath,
	serializedNames: Schema.Array(QueryValue).check(Schema.isMaxLength(64))
});
export interface ProjectIndexHeader extends Schema.Schema.Type<typeof ProjectIndexHeader> {}

export const ProjectIndexItem = Schema.Union([ProjectIndexMap, ProjectIndexHeader]);
export type ProjectIndexItem = typeof ProjectIndexItem.Type;

export const ProjectIndexPage = Schema.Struct({
	generation: ProjectIndexGeneration,
	items: Schema.Array(ProjectIndexItem).check(Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE)),
	nextCursor: Schema.optionalKey(ProjectIndexCursor),
	projectId: ProjectIdentity
});
export interface ProjectIndexPage extends Schema.Schema.Type<typeof ProjectIndexPage> {}

const ErrorFields = {
	message: BoundedMessage,
	recovery: BoundedMessage,
	retrySafe: Schema.Boolean
};

export class ProjectIndexUnavailable extends Schema.TaggedErrorClass<ProjectIndexUnavailable>()(
	"ProjectIndexUnavailable",
	ErrorFields
) {}

export class ProjectIndexInvalidRequest extends Schema.TaggedErrorClass<ProjectIndexInvalidRequest>()(
	"ProjectIndexInvalidRequest",
	ErrorFields
) {}

export class ProjectIndexStaleGeneration extends Schema.TaggedErrorClass<ProjectIndexStaleGeneration>()(
	"ProjectIndexStaleGeneration",
	{
		...ErrorFields,
		actualGeneration: ProjectIndexGeneration,
		expectedGeneration: ProjectIndexGeneration
	}
) {}

export class ProjectIndexIncompatibleWorker extends Schema.TaggedErrorClass<ProjectIndexIncompatibleWorker>()(
	"ProjectIndexIncompatibleWorker",
	ErrorFields
) {}

export class ProjectIndexCorruptCatalog extends Schema.TaggedErrorClass<ProjectIndexCorruptCatalog>()(
	"ProjectIndexCorruptCatalog",
	ErrorFields
) {}

export class ProjectIndexRefreshFailed extends Schema.TaggedErrorClass<ProjectIndexRefreshFailed>()(
	"ProjectIndexRefreshFailed",
	ErrorFields
) {}

export type ProjectIndexError =
	| ProjectIndexUnavailable
	| ProjectIndexInvalidRequest
	| ProjectIndexStaleGeneration
	| ProjectIndexIncompatibleWorker
	| ProjectIndexCorruptCatalog
	| ProjectIndexRefreshFailed;

export interface ProjectIndexShape {
	readonly rebuild: (
		target: ProjectIndexTarget
	) => Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError>;
	readonly refresh: (
		target: ProjectIndexTarget
	) => Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError>;
	readonly query: (
		request: ProjectIndexQuery
	) => Effect.Effect<ProjectIndexPage, ProjectIndexError>;
	readonly status: (
		target: ProjectIndexTarget
	) => Effect.Effect<ProjectIndexStatus, ProjectIndexError>;
}

export class ProjectIndex extends Context.Service<ProjectIndex, ProjectIndexShape>()(
	"@ue-shed/unreal-assets/ProjectIndex"
) {}

const acquireRefresh = Effect.fn("ProjectIndex.refresh")((target: ProjectIndexTarget) =>
	Effect.map(ProjectIndex, (index) => index.refresh(target))
);

const acquireRebuild = Effect.fn("ProjectIndex.rebuild")((target: ProjectIndexTarget) =>
	Effect.map(ProjectIndex, (index) => index.rebuild(target))
);

export function refreshProjectIndex(
	target: ProjectIndexTarget
): Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError, ProjectIndex> {
	return Stream.unwrap(acquireRefresh(target));
}

export function rebuildProjectIndex(
	target: ProjectIndexTarget
): Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError, ProjectIndex> {
	return Stream.unwrap(acquireRebuild(target));
}

export const queryProjectIndex = Effect.fn("ProjectIndex.query")((request: ProjectIndexQuery) =>
	Effect.flatMap(ProjectIndex, (index) => index.query(request))
);

export const getProjectIndexStatus = Effect.fn("ProjectIndex.status")(
	(target: ProjectIndexTarget) => Effect.flatMap(ProjectIndex, (index) => index.status(target))
);

export function makeProjectIndexTestLayer(service: ProjectIndexShape): Layer.Layer<ProjectIndex> {
	return Layer.succeed(ProjectIndex, ProjectIndex.of(service));
}

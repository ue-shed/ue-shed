import { Config, Context, Effect, Layer, Option, Schema, Stream } from "effect";

export const PROJECT_INDEX_MAX_PAGE_SIZE = 1024;
export const PROJECT_INDEX_MAX_DIAGNOSTICS = 64;
export const PROJECT_INDEX_CACHE_ROOT_ENV = "UE_SHED_PROJECT_INDEX_CACHE_ROOT";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const BoundedIdentifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const BoundedPath = Schema.NonEmptyString.check(Schema.isMaxLength(32_767));
const BoundedMessage = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const QueryValue = Schema.NonEmptyString.check(Schema.isMaxLength(1_024));
const QueryValues = Schema.Array(QueryValue).check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const ProjectIdentity = BoundedPath.pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

export const ProjectIndexGeneration = PositiveInt.pipe(Schema.brand("ProjectIndexGeneration"));
export type ProjectIndexGeneration = typeof ProjectIndexGeneration.Type;

export const ProjectIndexCursor = Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).pipe(
	Schema.brand("ProjectIndexCursor")
);
export type ProjectIndexCursor = typeof ProjectIndexCursor.Type;

export const ProjectIndexCacheRoot = BoundedPath.pipe(Schema.brand("ProjectIndexCacheRoot"));
export type ProjectIndexCacheRoot = typeof ProjectIndexCacheRoot.Type;

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
	Count: {
		...QueryBase,
		cursor: Schema.optionalKey(Schema.Never),
		limit: Schema.Literal(1),
		exactClasses: Schema.Array(QueryValue).check(Schema.isMaxLength(64)),
		classPrefixes: Schema.Array(QueryValue).check(Schema.isMaxLength(64)),
		classNameSuffixes: Schema.Array(QueryValue).check(Schema.isMaxLength(64)),
		serializedNames: Schema.Array(QueryValue).check(Schema.isMaxLength(64))
	},
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

export const ProjectIndexItem = Schema.Union([
	ProjectIndexMap,
	ProjectIndexHeader,
	Schema.Struct({ kind: Schema.Literal("count"), count: NonNegativeInt })
]);
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

export interface ProjectIndexConfiguration {
	readonly cacheRoot: ProjectIndexCacheRoot;
}

export interface ProjectIndexApi {
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

export class ProjectIndex extends Context.Service<ProjectIndex, ProjectIndexApi>()(
	"@ue-shed/unreal-assets/ProjectIndex"
) {}

export class ProjectIndexConfig extends Context.Service<
	ProjectIndexConfig,
	ProjectIndexConfiguration
>()("@ue-shed/unreal-assets/ProjectIndexConfig") {}

export const projectIndexCacheRootConfig = Config.schema(
	ProjectIndexCacheRoot,
	PROJECT_INDEX_CACHE_ROOT_ENV
);

export function projectIndexConfigLayer(
	configuration: ProjectIndexConfiguration
): Layer.Layer<ProjectIndexConfig> {
	return Layer.succeed(ProjectIndexConfig, ProjectIndexConfig.of(configuration));
}

export const ProjectIndexConfigLive = Layer.effect(
	ProjectIndexConfig,
	Effect.gen(function* () {
		const cacheRoot = yield* projectIndexCacheRootConfig;
		return ProjectIndexConfig.of({ cacheRoot });
	})
);

const invalidRequest = (message: string): ProjectIndexInvalidRequest =>
	new ProjectIndexInvalidRequest({
		message,
		recovery: "Correct the Project Index request and retry.",
		retrySafe: false
	});

export const decodeProjectIndexTarget = Effect.fn("ProjectIndex.decodeTarget")(
	<Input>(input: Input) =>
		Schema.decodeUnknownEffect(ProjectIndexTarget)(input).pipe(
			Effect.mapError(() =>
				invalidRequest("Project Index target must include a non-empty project root.")
			)
		)
);

export const decodeProjectIndexQuery = Effect.fn("ProjectIndex.decodeQuery")(
	<Input>(input: Input) =>
		Schema.decodeUnknownEffect(ProjectIndexQuery)(input).pipe(
			Effect.mapError(() =>
				invalidRequest(
					`Project Index queries must be bounded to at most ${PROJECT_INDEX_MAX_PAGE_SIZE} items.`
				)
			)
		)
);

export const decodeProjectIndexPage = Effect.fn("ProjectIndex.decodePage")(<Input>(input: Input) =>
	Schema.decodeUnknownEffect(ProjectIndexPage)(input).pipe(
		Effect.mapError(
			() =>
				new ProjectIndexUnavailable({
					message: "The Project Index adapter returned an unbounded or invalid page.",
					recovery: "Rebuild the Catalog, then retry with a bounded query.",
					retrySafe: true
				})
		)
	)
);

export function foldProjectIndexRefresh(
	events: Iterable<ProjectIndexRefreshEvent>
): Effect.Effect<ProjectIndexSummary, ProjectIndexRefreshFailed> {
	let summary: ProjectIndexSummary | undefined;
	for (const event of events) {
		if (event._tag === "Completed") summary = event.summary;
	}
	if (summary === undefined) {
		return Effect.fail(
			new ProjectIndexRefreshFailed({
				message: "Project Index refresh ended without a completed summary.",
				recovery: "Retry the refresh. If it keeps failing, rebuild the Catalog.",
				retrySafe: true
			})
		);
	}
	return Effect.succeed(summary);
}

const acquireRefresh = Effect.fn("ProjectIndex.refresh")((target: ProjectIndexTarget) =>
	Effect.gen(function* () {
		const decoded = yield* decodeProjectIndexTarget(target);
		const index = yield* ProjectIndex;
		return index.refresh(decoded);
	})
);

const acquireRebuild = Effect.fn("ProjectIndex.rebuild")((target: ProjectIndexTarget) =>
	Effect.gen(function* () {
		const decoded = yield* decodeProjectIndexTarget(target);
		const index = yield* ProjectIndex;
		return index.rebuild(decoded);
	})
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
	Effect.gen(function* () {
		const decoded = yield* decodeProjectIndexQuery(request);
		const index = yield* ProjectIndex;
		const page = yield* index.query(decoded);
		return yield* decodeProjectIndexPage(page);
	})
);

/** Count the union of matching packages without transferring their headers. */
export const countProjectIndex = Effect.fn("ProjectIndex.count")(
	(request: Omit<Extract<ProjectIndexQuery, { _tag: "Count" }>, "_tag" | "limit" | "cursor">) =>
		Effect.gen(function* () {
			const page = yield* queryProjectIndex({ ...request, _tag: "Count", limit: 1 });
			const item = page.items[0];
			if (
				page.projectId !== request.projectId ||
				page.generation !== request.expectedGeneration ||
				page.items.length !== 1 ||
				page.nextCursor !== undefined ||
				item?.kind !== "count"
			) {
				return yield* new ProjectIndexUnavailable({
					message: "The Project Index adapter returned an invalid count.",
					recovery: "Verify the paired worker version, then retry the count.",
					retrySafe: true
				});
			}
			return { count: item.count, generation: page.generation, projectId: page.projectId };
		})
);

export const getProjectIndexStatus = Effect.fn("ProjectIndex.status")(
	(target: ProjectIndexTarget) =>
		Effect.gen(function* () {
			const decoded = yield* decodeProjectIndexTarget(target);
			const index = yield* ProjectIndex;
			return yield* index.status(decoded);
		})
);

export const getProjectIndexCacheRoot = Effect.fn("ProjectIndex.cacheRoot")(() =>
	Effect.map(ProjectIndexConfig, (configuration) => configuration.cacheRoot)
);

export function makeProjectIndexTestLayer(service: ProjectIndexApi): Layer.Layer<ProjectIndex> {
	return Layer.succeed(ProjectIndex, ProjectIndex.of(service));
}

export function requireProjectIndexCacheRoot(
	cacheRoot: Option.Option<ProjectIndexCacheRoot> | ProjectIndexCacheRoot | undefined
): Effect.Effect<ProjectIndexCacheRoot, ProjectIndexInvalidRequest> {
	if (cacheRoot === undefined) {
		return Effect.fail(
			invalidRequest(
				`Project Index requires ${PROJECT_INDEX_CACHE_ROOT_ENV} or an explicit cache root.`
			)
		);
	}
	if (Option.isOption(cacheRoot)) {
		return Option.match(cacheRoot, {
			onNone: () =>
				Effect.fail(
					invalidRequest(
						`Project Index requires ${PROJECT_INDEX_CACHE_ROOT_ENV} or an explicit cache root.`
					)
				),
			onSome: (value) => Effect.succeed(value)
		});
	}
	return Effect.succeed(cacheRoot);
}

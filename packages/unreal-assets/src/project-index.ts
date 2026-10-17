import { Config, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { ErrorCauseFields, ErrorGuidanceFields, PackageHeaderData } from "@ue-shed/protocol";
import { findValidatedPage, retainValidatedPage } from "./project-index-page-validation.js";

/**
 * Maximum accepted Project Index page size: 1,024 items. Use the returned opaque cursor for
 * subsequent pages rather than requesting an unbounded inventory.
 */
export const PROJECT_INDEX_MAX_PAGE_SIZE = 1024;
/**
 * Maximum diagnostics retained in one Project Index summary: 64. Completeness remains
 * explicit even when diagnostic output is bounded.
 */
export const PROJECT_INDEX_MAX_DIAGNOSTICS = 64;
/**
 * Environment setting UE_SHED_PROJECT_INDEX_CACHE_ROOT used by ProjectIndexConfigLive. A host
 * may instead provide an explicit cache-root layer.
 */
export const PROJECT_INDEX_CACHE_ROOT_ENV = "UE_SHED_PROJECT_INDEX_CACHE_ROOT";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const BoundedIdentifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const BoundedPath = Schema.NonEmptyString.check(Schema.isMaxLength(32_767));
const BoundedMessage = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const QueryValue = Schema.NonEmptyString.check(Schema.isMaxLength(1_024));
const QueryValues = Schema.Array(QueryValue).check(Schema.isMinLength(1), Schema.isMaxLength(64));

/**
 * Bounded branded Project Index identity carried in summaries and queries. Use the identity
 * returned by the index; branding alone does not resolve physical paths or prove project
 * ownership.
 */
export const ProjectIdentity = BoundedPath.pipe(Schema.brand("ProjectIdentity"));
export type ProjectIdentity = typeof ProjectIdentity.Type;

/**
 * Positive committed catalog generation. Bind paginated queries and counts to this value so
 * concurrent refreshes fail as stale instead of mixing snapshots.
 */
export const ProjectIndexGeneration = PositiveInt.pipe(Schema.brand("ProjectIndexGeneration"));
export type ProjectIndexGeneration = typeof ProjectIndexGeneration.Type;

/**
 * Bounded opaque pagination token. Pass it back with the same query identity/generation; do
 * not parse it or reuse it after refreshing the catalog.
 */
export const ProjectIndexCursor = Schema.NonEmptyString.check(Schema.isMaxLength(4_096)).pipe(
	Schema.brand("ProjectIndexCursor")
);
export type ProjectIndexCursor = typeof ProjectIndexCursor.Type;

/**
 * Bounded explicit persistent catalog directory. Validation establishes a non-empty path
 * value; the IO implementation remains responsible for filesystem access and cache ownership.
 */
export const ProjectIndexCacheRoot = BoundedPath.pipe(Schema.brand("ProjectIndexCacheRoot"));
export type ProjectIndexCacheRoot = typeof ProjectIndexCacheRoot.Type;

/**
 * Explicit project root to refresh, rebuild or inspect. It does not select a project for a
 * host or infer one from ambient process state.
 */
export const ProjectIndexTarget = Schema.Struct({
	projectRoot: BoundedPath
});
/**
 * Explicit project root to refresh, rebuild or inspect. It does not select a project for a
 * host or infer one from ambient process state.
 */
export interface ProjectIndexTarget extends Schema.Schema.Type<typeof ProjectIndexTarget> {}

/**
 * Bounded catalog diagnostic with stable code, message and replay-safety hint. Summary
 * completeness still determines whether the inventory can be treated as complete.
 */
export const ProjectIndexDiagnostic = Schema.Struct({
	code: BoundedIdentifier,
	message: BoundedMessage,
	retrySafe: Schema.Boolean
});
/**
 * Bounded catalog diagnostic with stable code, message and replay-safety hint. Summary
 * completeness still determines whether the inventory can be treated as complete.
 */
export interface ProjectIndexDiagnostic extends Schema.Schema.Type<typeof ProjectIndexDiagnostic> {}

/**
 * Committed catalog identity/generation, package/map counts, changed/removed counts and
 * bounded diagnostics. Partial completeness must remain visible to callers.
 */
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
/**
 * Committed catalog identity/generation, package/map counts, changed/removed counts and
 * bounded diagnostics. Partial completeness must remain visible to callers.
 */
export interface ProjectIndexSummary extends Schema.Schema.Type<typeof ProjectIndexSummary> {}

/**
 * Absent catalog or ready catalog with its committed summary. A ready partial summary is
 * distinguishable from both absence and a complete inventory.
 */
export const ProjectIndexStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("absent") }),
	Schema.Struct({ status: Schema.Literal("ready"), summary: ProjectIndexSummary })
]);
export type ProjectIndexStatus = typeof ProjectIndexStatus.Type;

/**
 * Started, bounded progress and completed-summary events for refresh/rebuild. Only Completed
 * establishes the resulting committed generation.
 */
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

/**
 * Bounded generation-bound inventory, map, class or serialized-name page query. Requires the
 * committed project identity and generation; query cursors are opaque.
 */
export const ProjectIndexQuery = Schema.TaggedUnion({
	Inventory: QueryBase,
	Maps: QueryBase,
	ExactClasses: { ...QueryBase, values: QueryValues },
	ClassPrefixes: { ...QueryBase, values: QueryValues },
	ClassNameSuffixes: { ...QueryBase, values: QueryValues },
	SerializedNames: { ...QueryBase, values: QueryValues }
});
export type ProjectIndexQuery = typeof ProjectIndexQuery.Type;

/**
 * Map/class/serialized-name filter used by distinct-package counts. Values describe header
 * evidence, not a resolved Unreal inheritance graph.
 */
export const ProjectIndexFilter = Schema.TaggedUnion({
	Maps: {},
	ExactClasses: { values: QueryValues },
	ClassPrefixes: { values: QueryValues },
	ClassNameSuffixes: { values: QueryValues },
	SerializedNames: { values: QueryValues }
});
export type ProjectIndexFilter = typeof ProjectIndexFilter.Type;

/** Count distinct packages matching any filter in one generation. */
export const ProjectIndexCount = Schema.Struct({
	projectId: ProjectIdentity,
	expectedGeneration: ProjectIndexGeneration,
	filters: Schema.Array(ProjectIndexFilter).check(Schema.isMinLength(1), Schema.isMaxLength(16))
});
export interface ProjectIndexCount extends Schema.Schema.Type<typeof ProjectIndexCount> {}

/**
 * Distinct matching package count bound to one project identity and committed generation. It
 * counts packages rather than exports or matching filter occurrences.
 */
export const ProjectIndexCountResult = Schema.Struct({
	projectId: ProjectIdentity,
	generation: ProjectIndexGeneration,
	count: NonNegativeInt
});
/**
 * Distinct matching package count bound to one project identity and committed generation. It
 * counts packages rather than exports or matching filter occurrences.
 */
export interface ProjectIndexCountResult extends Schema.Schema.Type<
	typeof ProjectIndexCountResult
> {}

/**
 * Saved map entry with Unreal package name and indexed map path. It is catalog evidence, not
 * a live editor-world handle.
 */
export const ProjectIndexMap = Schema.Struct({
	kind: Schema.Literal("map"),
	mapPath: BoundedPath,
	packageName: BoundedPath
});
/**
 * Saved map entry with Unreal package name and indexed map path. It is catalog evidence, not
 * a live editor-world handle.
 */
export interface ProjectIndexMap extends Schema.Schema.Type<typeof ProjectIndexMap> {}

/**
 * Saved package header projection with bounded class/name evidence and optional package
 * summary data. It does not imply that full property streams were decoded.
 */
export const ProjectIndexHeader = Schema.Struct({
	headerData: Schema.optionalKey(PackageHeaderData),
	classes: Schema.Array(QueryValue).check(Schema.isMaxLength(64)),
	kind: Schema.Literal("header"),
	packageName: BoundedPath,
	packagePath: BoundedPath,
	serializedNames: Schema.Array(QueryValue).check(Schema.isMaxLength(64))
});
/**
 * Saved package header projection with bounded class/name evidence and optional package
 * summary data. It does not imply that full property streams were decoded.
 */
export interface ProjectIndexHeader extends Schema.Schema.Type<typeof ProjectIndexHeader> {}

/**
 * Package path/signature from enumeration, optionally carrying header evidence. The signature
 * supports refresh comparison; it is not a cryptographic content guarantee.
 */
export const ProjectIndexInventory = Schema.Struct({
	kind: Schema.Literal("inventory"),
	packagePath: BoundedPath,
	signature: Schema.String.check(Schema.isMaxLength(8192)),
	headerData: Schema.optionalKey(PackageHeaderData)
});
/**
 * Package path/signature from enumeration, optionally carrying header evidence. The signature
 * supports refresh comparison; it is not a cryptographic content guarantee.
 */
export interface ProjectIndexInventory extends Schema.Schema.Type<typeof ProjectIndexInventory> {}
/**
 * Discriminated map, header or inventory page item. Consumers must narrow by kind before
 * using fields specific to a projection.
 */
export const ProjectIndexItem = Schema.Union([
	ProjectIndexMap,
	ProjectIndexHeader,
	ProjectIndexInventory
]);
export type ProjectIndexItem = typeof ProjectIndexItem.Type;

/**
 * Bounded items from one catalog generation and optional next cursor. Keep project/generation
 * fixed for the full page sequence; refresh invalidates old cursors.
 */
export const ProjectIndexPage = Schema.Struct({
	generation: ProjectIndexGeneration,
	items: Schema.Array(ProjectIndexItem).check(Schema.isMaxLength(PROJECT_INDEX_MAX_PAGE_SIZE)),
	nextCursor: Schema.optionalKey(ProjectIndexCursor),
	projectId: ProjectIdentity
});
/**
 * Bounded items from one catalog generation and optional next cursor. Keep project/generation
 * fixed for the full page sequence; refresh invalidates old cursors.
 */
export interface ProjectIndexPage extends Schema.Schema.Type<typeof ProjectIndexPage> {}

const ErrorFields = {
	...ErrorGuidanceFields,
	...ErrorCauseFields,
	message: BoundedMessage,
	recovery: BoundedMessage
};

/**
 * The catalog service or returned evidence is unavailable. Recovery guidance identifies
 * whether refreshing/rebuilding or repairing the host is appropriate; the underlying cause is
 * retained when available.
 */
export class ProjectIndexUnavailable extends Schema.TaggedError<ProjectIndexUnavailable>()(
	"ProjectIndexUnavailable",
	ErrorFields
) {}

/**
 * Invalid catalog target, query, filter or configuration. Correct the request rather than
 * retrying unchanged input.
 */
export class ProjectIndexInvalidRequest extends Schema.TaggedError<ProjectIndexInvalidRequest>()(
	"ProjectIndexInvalidRequest",
	ErrorFields
) {}

/**
 * A query references an older committed generation. Read current status and restart
 * pagination/counting against the new generation instead of combining old and new pages.
 */
export class ProjectIndexStaleGeneration extends Schema.TaggedError<ProjectIndexStaleGeneration>()(
	"ProjectIndexStaleGeneration",
	{
		...ErrorFields,
		actualGeneration: ProjectIndexGeneration,
		expectedGeneration: ProjectIndexGeneration
	}
) {}

/**
 * The native worker cannot satisfy the requested catalog contract/encoding. Install a paired
 * worker rather than treating its response as an empty inventory.
 */
export class ProjectIndexIncompatibleWorker extends Schema.TaggedError<ProjectIndexIncompatibleWorker>()(
	"ProjectIndexIncompatibleWorker",
	ErrorFields
) {}

/**
 * Stored catalog evidence is invalid or incompatible. Follow rebuild/quarantine guidance; do
 * not continue serving partially trusted cached rows.
 */
export class ProjectIndexCorruptCatalog extends Schema.TaggedError<ProjectIndexCorruptCatalog>()(
	"ProjectIndexCorruptCatalog",
	ErrorFields
) {}

/**
 * Refresh/rebuild failed or ended without a completed summary. The previous committed
 * generation remains separate from uncommitted work; inspect guidance before retrying.
 */
export class ProjectIndexRefreshFailed extends Schema.TaggedError<ProjectIndexRefreshFailed>()(
	"ProjectIndexRefreshFailed",
	ErrorFields
) {}

/** Tag guard for every Project Index failure; match by tag, not `instanceof`. */
export const isProjectIndexError = Schema.is(
	Schema.Union([
		ProjectIndexUnavailable,
		ProjectIndexInvalidRequest,
		ProjectIndexStaleGeneration,
		ProjectIndexIncompatibleWorker,
		ProjectIndexCorruptCatalog,
		ProjectIndexRefreshFailed
	])
);

/**
 * Expected catalog failures distinguished by tag: availability, invalid request, stale
 * generation, incompatible worker, corruption and refresh failure. Match tags rather than
 * human-readable messages.
 */
export type ProjectIndexError =
	| ProjectIndexUnavailable
	| ProjectIndexInvalidRequest
	| ProjectIndexStaleGeneration
	| ProjectIndexIncompatibleWorker
	| ProjectIndexCorruptCatalog
	| ProjectIndexRefreshFailed;

/**
 * Explicit persistent cache root for a Project Index layer. Hosts own cache placement rather
 * than deriving it from the Workbench shell.
 */
export interface ProjectIndexConfiguration {
	readonly cacheRoot: ProjectIndexCacheRoot;
}

/**
 * Status, refresh/rebuild, bounded queries and distinct-package counts over committed
 * generations. Consumers must retain generation identity throughout pagination.
 */
export interface ProjectIndexApi {
	readonly count: (
		request: ProjectIndexCount
	) => Effect.Effect<ProjectIndexCountResult, ProjectIndexError>;
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

/**
 * Replaceable saved-project catalog port. The service supports headless library/CLI consumers
 * and does not require a Workbench-owned inventory.
 */
export class ProjectIndex extends Context.Service<ProjectIndex, ProjectIndexApi>()(
	"@ue-shed/unreal-assets/ProjectIndex"
) {}

/**
 * Persistent catalog configuration service. Provide an explicit host layer or
 * ProjectIndexConfigLive; absence is an input error rather than an implicit machine-specific
 * default.
 */
export class ProjectIndexConfig extends Context.Service<
	ProjectIndexConfig,
	ProjectIndexConfiguration
>()("@ue-shed/unreal-assets/ProjectIndexConfig") {}

/**
 * Effect Config decoder for UE_SHED_PROJECT_INDEX_CACHE_ROOT. Requires a bounded non-empty
 * path and does not create or access the directory during decoding.
 */
export const projectIndexCacheRootConfig = Config.schema(
	ProjectIndexCacheRoot,
	PROJECT_INDEX_CACHE_ROOT_ENV
);

/**
 * Provides an explicit catalog cache root. Suitable for host-owned project caches without
 * relying on environment variables.
 */
export function projectIndexConfigLayer(
	configuration: ProjectIndexConfiguration
): Layer.Layer<ProjectIndexConfig> {
	return Layer.succeed(ProjectIndexConfig, ProjectIndexConfig.of(configuration));
}

/**
 * Loads the catalog cache root through Effect Config. Missing/invalid configuration fails
 * layer construction rather than silently selecting an ambient directory.
 */
export const ProjectIndexConfigLive = Layer.effect(
	ProjectIndexConfig,
	Effect.gen(function* () {
		const cacheRoot = yield* projectIndexCacheRootConfig;
		return ProjectIndexConfig.of({ cacheRoot });
	})
);

const invalidRequest = (message: string, cause?: unknown): ProjectIndexInvalidRequest =>
	new ProjectIndexInvalidRequest({
		message,
		...(cause === undefined ? undefined : { cause }),
		recovery: "Correct the Project Index request and retry.",
		retrySafe: false,
		nextStep: "fix_input"
	});

/**
 * Validates a generation-bound distinct-package count request with one through sixteen
 * bounded filters. Invalid input retains the schema failure as cause.
 */
export const decodeProjectIndexCount = <Input>(input: Input) =>
	Schema.decodeUnknownEffect(ProjectIndexCount)(input).pipe(
		Effect.mapError((cause) =>
			invalidRequest("Project Index counts require between 1 and 16 bounded filters.", cause)
		)
	);

/**
 * Validates a count request and its returned identity/generation through ProjectIndex.
 * Rejects a result from another snapshot rather than presenting a misleading count.
 */
export const countProjectIndex = Effect.fn("ProjectIndex.count")(function* (
	request: ProjectIndexCount
) {
	const decoded = yield* decodeProjectIndexCount(request);
	const index = yield* ProjectIndex;
	const result = yield* index.count(decoded);
	return yield* Schema.decodeUnknownEffect(ProjectIndexCountResult)(result).pipe(
		Effect.filterOrFail(
			(value) =>
				value.projectId === decoded.projectId &&
				value.generation === decoded.expectedGeneration,
			() => invalidRequest("Project Index count returned a different identity or generation.")
		),
		Effect.mapError(
			(cause) =>
				new ProjectIndexUnavailable({
					cause,
					message: "Project Index returned an invalid count result.",
					recovery: "Refresh the Catalog, then retry the count.",
					retrySafe: true,
					nextStep: "retry"
				})
		)
	);
});

/** Portable fallback for adapters whose storage has no aggregate operation. */
export const countProjectIndexPages = Effect.fn("ProjectIndex.countPages")(function* (
	query: ProjectIndexApi["query"],
	request: ProjectIndexCount
) {
	const decoded = yield* decodeProjectIndexCount(request);
	const paths = new Set<string>();
	for (const filter of decoded.filters) {
		let cursor: ProjectIndexCursor | undefined;
		do {
			const page = yield* query({
				...filter,
				projectId: decoded.projectId,
				expectedGeneration: decoded.expectedGeneration,
				limit: PROJECT_INDEX_MAX_PAGE_SIZE,
				...(cursor === undefined ? undefined : { cursor })
			}).pipe(Effect.flatMap(decodeProjectIndexPage));
			if (
				page.projectId !== decoded.projectId ||
				page.generation !== decoded.expectedGeneration
			)
				return yield* invalidRequest(
					"Count page belongs to a different identity or generation."
				);
			for (const item of page.items)
				paths.add(item.kind === "map" ? item.mapPath : item.packagePath);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	}
	return {
		projectId: decoded.projectId,
		generation: decoded.expectedGeneration,
		count: paths.size
	};
});

/**
 * Validates an untrusted catalog target into the domain schema. Fails with
 * ProjectIndexInvalidRequest retaining the parser cause; it does not check filesystem
 * existence.
 */
export const decodeProjectIndexTarget = Effect.fn("ProjectIndex.decodeTarget")(
	<Input>(input: Input) =>
		Schema.decodeUnknownEffect(ProjectIndexTarget)(input).pipe(
			Effect.mapError((cause) =>
				invalidRequest("Project Index target must include a non-empty project root.", cause)
			)
		)
);

/**
 * Validates bounded filters, pagination, project identity and expected generation. Returns a
 * typed invalid-request failure before invoking the catalog service.
 */
export const decodeProjectIndexQuery = Effect.fn("ProjectIndex.decodeQuery")(
	<Input>(input: Input) =>
		Schema.decodeUnknownEffect(ProjectIndexQuery)(input).pipe(
			Effect.mapError((cause) =>
				invalidRequest(
					`Project Index queries must be bounded to at most ${PROJECT_INDEX_MAX_PAGE_SIZE} items.`,
					cause
				)
			)
		)
);

const decodePage = Schema.decodeUnknownEffect(ProjectIndexPage);

/**
 * Validates a returned domain page before consumption, including item/page bounds. Invalid
 * service output fails as unavailable rather than yielding partially trusted rows.
 */
export const decodeProjectIndexPage = Effect.fn("ProjectIndex.decodePage")(<Input>(input: Input) =>
	Effect.suspend(() => {
		// Only an already validated, deeply frozen result can cross another library boundary
		// without walking every name again. Untrusted or mutable pages always run the schema.
		const validated = findValidatedPage(input);
		if (validated !== undefined) return Effect.succeed(validated);
		return decodePage(input).pipe(
			Effect.map(retainValidatedPage),
			Effect.mapError(
				(cause) =>
					new ProjectIndexUnavailable({
						cause,
						message: "The Project Index adapter returned an unbounded or invalid page.",
						recovery: "Rebuild the Catalog, then retry with a bounded query.",
						retrySafe: true,
						nextStep: "retry"
					})
			)
		);
	})
);

/**
 * Extracts the last Completed summary from collected refresh events. Fails with
 * ProjectIndexRefreshFailed if the sequence never completed; progress alone is not success.
 */
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
				retrySafe: true,
				nextStep: "retry"
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

/**
 * Streams an incremental catalog refresh for an explicit project target. Await Completed
 * before using the new generation; query consumers must restart stale pagination.
 */
export function refreshProjectIndex(
	target: ProjectIndexTarget
): Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError, ProjectIndex> {
	return Stream.unwrap(acquireRefresh(target));
}

/**
 * Streams a full catalog rebuild rather than trusting prior header evidence. Completion
 * returns the new committed generation; it does not change the host's selected project.
 */
export function rebuildProjectIndex(
	target: ProjectIndexTarget
): Stream.Stream<ProjectIndexRefreshEvent, ProjectIndexError, ProjectIndex> {
	return Stream.unwrap(acquireRebuild(target));
}

/**
 * Validates a bounded page request, calls ProjectIndex and validates the result. Requires the
 * service in the Effect environment; it does not refresh automatically on stale generation.
 */
export const queryProjectIndex = Effect.fn("ProjectIndex.query")((request: ProjectIndexQuery) =>
	Effect.gen(function* () {
		const decoded = yield* decodeProjectIndexQuery(request);
		const index = yield* ProjectIndex;
		const page = yield* index.query(decoded);
		return yield* decodeProjectIndexPage(page);
	})
);

/**
 * Validates an explicit target and reads its committed catalog status through ProjectIndex.
 * Does not create or refresh an absent catalog.
 */
export const getProjectIndexStatus = Effect.fn("ProjectIndex.status")(
	(target: ProjectIndexTarget) =>
		Effect.gen(function* () {
			const decoded = yield* decodeProjectIndexTarget(target);
			const index = yield* ProjectIndex;
			return yield* index.status(decoded);
		})
);

/**
 * Reads the host-provided ProjectIndexConfig cache root. This does not validate directory
 * permissions, create storage or infer a project selection.
 */
export const getProjectIndexCacheRoot = Effect.fn("ProjectIndex.cacheRoot")(() =>
	Effect.map(ProjectIndexConfig, (configuration) => configuration.cacheRoot)
);

/**
 * Provides explicit test catalog operations. The optional count implementation defaults to
 * counting the supplied query pages; no operation falls back to a native worker.
 */
export function makeProjectIndexTestLayer(
	service: Omit<ProjectIndexApi, "count"> & Partial<Pick<ProjectIndexApi, "count">>
): Layer.Layer<ProjectIndex> {
	return Layer.succeed(
		ProjectIndex,
		ProjectIndex.of({
			...service,
			count: service.count ?? ((request) => countProjectIndexPages(service.query, request))
		})
	);
}

/**
 * Unwraps an explicit or optional cache root, failing with typed input guidance when absent.
 * Does not select a fallback machine directory.
 */
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

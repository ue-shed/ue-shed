import { contractParser } from "./contract-parser.js";
import { Schema } from "effect";
import type { GameTextContract } from "./game-text-contract.generated.js";
import {
	GameTextIndexBuildRequest,
	GameTextIndexBuildOutcome,
	GameTextIndexPreviousBuildRequest,
	GameTextIndexPackageReplacement,
	GameTextIndexPackageComparison,
	GameTextIndexPackagePlan,
	GameTextIndexCodeLayer,
	GameTextIndexReadPoint,
	GameTextIndexDiskChanges,
	PackageTextAudienceRule
} from "./game-text-index.js";
import { makeWireJsonSchemaDocument } from "./json-schema.js";
import { AuthoringTableSnapshot } from "./authoring.js";
import { BlueprintComparison } from "./blueprint-diff.js";
import { BlueprintGraphProjection } from "./blueprint-graph.js";
import { LevelSequenceProjection } from "./level-sequence.js";
import { SavedWorld } from "./saved-world.js";
import {
	PackageHeaderData,
	SavedAssetInspection,
	SavedAssetManifestEntry,
	SavedAssetScanEntry,
	SavedAssetScanSummary,
	SavedAssetTextExtractionEvent,
	SavedAssetPackageTextEvent,
	SavedAssetTextureExtractionEvent
} from "./uasset-inspection.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: "UAssetIoNonNegativeInt"
});
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
	identifier: "UAssetIoPositiveInt"
});
const NonEmptyString = Schema.Trim.check(Schema.isNonEmpty()).annotate({
	identifier: "UAssetIoNonEmptyString"
});

/**
 * Contract identity repeated on every request and event frame. Major is always 1; the minor
 * negotiates additive features, and a worker rejects an operation newer than the requested minor
 * before `accepted` and strips result fields introduced after it.
 */
export const UAssetIoContract = Schema.Struct({
	name: Schema.Literal("uasset-io"),
	version: Schema.Struct({
		major: Schema.Literal(1),
		minor: NonNegativeInt
	})
}).annotate({ identifier: "UAssetIoContract" });
export type UAssetIoContract = Schema.Schema.Type<typeof UAssetIoContract>;

/**
 * Optional per-request limits; an omitted key uses the worker's default. All but `maximumAssets`
 * must be positive. `maximumOutputBytes` caps all NDJSON frame bytes with newlines, `maximumAssets`
 * caps discovered packages (`resource_limit`), `timeoutMs` is in ms. `maximumInFlightPackageBytes`
 * bounds active input file sizes (default 256 MiB; a larger input runs alone), not heap or output.
 */
export const UAssetIoResourceLimits = Schema.Struct({
	concurrency: Schema.optionalKey(PositiveInt),
	maximumInFlightPackageBytes: Schema.optionalKey(PositiveInt),
	maximumAssets: Schema.optionalKey(NonNegativeInt),
	maximumOutputBytes: Schema.optionalKey(PositiveInt),
	timeoutMs: Schema.optionalKey(PositiveInt)
}).annotate({ identifier: "UAssetIoResourceLimits" });
export type UAssetIoResourceLimits = Schema.Schema.Type<typeof UAssetIoResourceLimits>;

const UAssetIoProjectSelection = Schema.Struct({
	paths: Schema.optionalKey(Schema.Array(NonEmptyString)),
	projectRoot: NonEmptyString
});

const UAssetIoScanFilters = Schema.Struct({
	classNameSuffixes: Schema.optionalKey(Schema.Array(NonEmptyString)),
	classPrefixes: Schema.optionalKey(Schema.Array(NonEmptyString)),
	classes: Schema.optionalKey(Schema.Array(NonEmptyString)),
	names: Schema.optionalKey(Schema.Array(NonEmptyString))
});

/** Enforced below every Project Index caller; mirrored in `@ue-shed/unreal-assets`. */
export const UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE = 1024;
/**
 * Most diagnostics a Project Index summary carries. The worker keeps the first 64 and drops the
 * rest, so a full list does not mean every problem was reported.
 */
export const UASSET_IO_PROJECT_INDEX_MAX_DIAGNOSTICS = 64;

const ProjectIndexPageLimit = Schema.Int.check(
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE)
);
const ProjectIndexQueryValues = Schema.Array(NonEmptyString).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(64)
);

const UAssetIoProjectIndexTarget = {
	cacheRoot: NonEmptyString,
	projectRoot: NonEmptyString
};

const UAssetIoProjectIndexQueryBase = {
	cursor: Schema.optionalKey(NonEmptyString),
	expectedGeneration: PositiveInt,
	limit: ProjectIndexPageLimit,
	projectId: NonEmptyString
};

/**
 * One page request against a single Project Index generation. A generation other than
 * `expectedGeneration` fails the request with a stale-generation failure. `limit` is 1 to 1,024
 * items, `cursor` is the previous page's opaque `nextCursor`, and filtering kinds take 1 to 64
 * non-empty values.
 */
export const UAssetIoProjectIndexQuery = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("inventory"), ...UAssetIoProjectIndexQueryBase }),
	Schema.Struct({
		kind: Schema.Literal("maps"),
		...UAssetIoProjectIndexQueryBase
	}),
	Schema.Struct({
		kind: Schema.Literal("exact_classes"),
		...UAssetIoProjectIndexQueryBase,
		values: ProjectIndexQueryValues
	}),
	Schema.Struct({
		kind: Schema.Literal("class_prefixes"),
		...UAssetIoProjectIndexQueryBase,
		values: ProjectIndexQueryValues
	}),
	Schema.Struct({
		kind: Schema.Literal("class_name_suffixes"),
		...UAssetIoProjectIndexQueryBase,
		values: ProjectIndexQueryValues
	}),
	Schema.Struct({
		kind: Schema.Literal("serialized_names"),
		...UAssetIoProjectIndexQueryBase,
		values: ProjectIndexQueryValues
	})
]).annotate({ identifier: "UAssetIoProjectIndexQuery" });
export type UAssetIoProjectIndexQuery = Schema.Schema.Type<typeof UAssetIoProjectIndexQuery>;

/** Package paths one v1.23 dependency or dependents query starts from. */
export const UASSET_IO_PROJECT_INDEX_MAX_DEPENDENCY_PATHS = 1024;

/**
 * v1.23: which dependencies a walk follows, by Unreal's `EDependencyProperty` bits. A present field
 * requires that value; an absent one accepts either. `{}` follows every dependency; `{ game: true }`
 * follows only what the game uses; `{ hard: true }` only import-map dependencies.
 */
export const UAssetIoProjectIndexEdges = Schema.Struct({
	hard: Schema.optionalKey(Schema.Boolean),
	game: Schema.optionalKey(Schema.Boolean),
	build: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "UAssetIoProjectIndexEdges" });
export type UAssetIoProjectIndexEdges = typeof UAssetIoProjectIndexEdges.Type;

const ProjectIndexDependencyFields = {
	...UAssetIoProjectIndexQueryBase,
	paths: Schema.Array(NonEmptyString).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(UASSET_IO_PROJECT_INDEX_MAX_DEPENDENCY_PATHS)
	),
	transitive: Schema.optionalKey(Schema.Boolean),
	edges: Schema.optionalKey(UAssetIoProjectIndexEdges)
};

/**
 * v1.23 dependency walks from 1 to 1,024 package paths, returning `package` items in path order.
 * `dependents` accepts deleted paths; its `classes` filter results without narrowing the walk.
 */
export const UAssetIoProjectIndexDependencyQuery = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("dependencies"), ...ProjectIndexDependencyFields }),
	Schema.Struct({
		kind: Schema.Literal("dependents"),
		...ProjectIndexDependencyFields,
		classes: Schema.optionalKey(ProjectIndexQueryValues)
	})
]).annotate({ identifier: "UAssetIoProjectIndexDependencyQuery" });
export type UAssetIoProjectIndexDependencyQuery = typeof UAssetIoProjectIndexDependencyQuery.Type;

/**
 * One `project_index_count` filter (v1.4): a query kind without pagination fields. Kinds other
 * than `maps` take 1 to 64 non-empty values.
 */
export const UAssetIoProjectIndexFilter = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("maps") }),
	Schema.Struct({ kind: Schema.Literal("exact_classes"), values: ProjectIndexQueryValues }),
	Schema.Struct({ kind: Schema.Literal("class_prefixes"), values: ProjectIndexQueryValues }),
	Schema.Struct({ kind: Schema.Literal("class_name_suffixes"), values: ProjectIndexQueryValues }),
	Schema.Struct({ kind: Schema.Literal("serialized_names"), values: ProjectIndexQueryValues })
]);
export type UAssetIoProjectIndexFilter = typeof UAssetIoProjectIndexFilter.Type;

/**
 * Body of a v1.4 `project_index_count` request: 1 to 16 filters evaluated against
 * `expectedGeneration`. A stale generation fails with the same typed error as a query.
 */
export const UAssetIoProjectIndexCount = Schema.Struct({
	projectId: UAssetIoProjectIndexQueryBase.projectId,
	expectedGeneration: UAssetIoProjectIndexQueryBase.expectedGeneration,
	filters: Schema.Array(UAssetIoProjectIndexFilter).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(16)
	)
}).annotate({ identifier: "UAssetIoProjectIndexCount" });

/**
 * `count` is the number of distinct package paths in `generation` matching any filter; a package
 * matching several filters counts once.
 */
export const UAssetIoProjectIndexCountResult = Schema.Struct({
	projectId: UAssetIoProjectIndexQueryBase.projectId,
	generation: PositiveInt,
	count: NonNegativeInt
}).annotate({ identifier: "UAssetIoProjectIndexCountResult" });

/**
 * A problem a Project Index refresh recorded without failing; any diagnostic makes the summary
 * `partial`. `retrySafe` says whether repeating the refresh may succeed.
 */
export const UAssetIoProjectIndexDiagnostic = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	retrySafe: Schema.Boolean
}).annotate({ identifier: "UAssetIoProjectIndexDiagnostic" });
export interface UAssetIoProjectIndexDiagnostic extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexDiagnostic
> {}

/**
 * v1.23: where Unreal mounts an indexed content root. Package names below `name` (`/Game/`) are
 * files below the project-relative `path` (`Content/`); a plugin mounts at `/<descriptor stem>/`.
 */
export const UAssetIoProjectIndexMount = Schema.Struct({
	name: NonEmptyString,
	path: NonEmptyString
}).annotate({ identifier: "UAssetIoProjectIndexMount" });
export interface UAssetIoProjectIndexMount extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexMount
> {}

/**
 * v1.23: what a refresh saw change on disk since `baseGeneration` (absent for a first or rebuilt
 * index): packages and sidecars that are new or whose size or modified time changed, and those
 * that are gone. Re-reading an entry for a newer index profile is not a change. When `complete` is
 * false there were more than 65,536 and both lists are empty.
 */
export const UAssetIoProjectIndexChanges = Schema.Struct({
	baseGeneration: Schema.optionalKey(PositiveInt),
	changed: Schema.Array(NonEmptyString),
	removed: Schema.Array(NonEmptyString),
	complete: Schema.Boolean
}).annotate({ identifier: "UAssetIoProjectIndexChanges" });
export interface UAssetIoProjectIndexChanges extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexChanges
> {}

/**
 * Outcome of the last committed refresh; queries name its `generation`. `completeness` is
 * `partial` when a diagnostic was recorded (at most 64 are kept). From v1.23 it lists `mounts`,
 * and `changes` when the refresh asked for them.
 */
export const UAssetIoProjectIndexSummary = Schema.Struct({
	changedPackages: NonNegativeInt,
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(UAssetIoProjectIndexDiagnostic).check(
		Schema.isMaxLength(UASSET_IO_PROJECT_INDEX_MAX_DIAGNOSTICS)
	),
	generation: PositiveInt,
	mapCount: NonNegativeInt,
	packageCount: NonNegativeInt,
	projectId: NonEmptyString,
	removedPackages: NonNegativeInt,
	mounts: Schema.optionalKey(Schema.Array(UAssetIoProjectIndexMount)),
	changes: Schema.optionalKey(UAssetIoProjectIndexChanges)
}).annotate({ identifier: "UAssetIoProjectIndexSummary" });
export interface UAssetIoProjectIndexSummary extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexSummary
> {}

/**
 * Result of `project_index_status`: `absent` when no index has been committed for the project
 * under the cache root, otherwise `ready` with the last refresh summary.
 */
export const UAssetIoProjectIndexStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("absent") }),
	Schema.Struct({ status: Schema.Literal("ready"), summary: UAssetIoProjectIndexSummary })
]).annotate({ identifier: "UAssetIoProjectIndexStatus" });
export type UAssetIoProjectIndexStatus = Schema.Schema.Type<typeof UAssetIoProjectIndexStatus>;

/**
 * A map package in a query page. `mapPath` is its project-relative path, which also orders the
 * page and forms the cursor.
 */
export const UAssetIoProjectIndexMap = Schema.Struct({
	kind: Schema.Literal("map"),
	mapPath: NonEmptyString,
	packageName: NonEmptyString
}).annotate({ identifier: "UAssetIoProjectIndexMap" });
export interface UAssetIoProjectIndexMap extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexMap
> {}

/**
 * Compact header evidence for a package in a query page, with at most 64 classes and 64
 * serialized names. `headerData` needs minor 9 or later; its absence is an upgrade requirement,
 * not evidence that the package holds no text.
 */
export const UAssetIoProjectIndexHeader = Schema.Struct({
	headerData: Schema.optionalKey(PackageHeaderData),
	classes: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
	kind: Schema.Literal("header"),
	packageName: NonEmptyString,
	packagePath: NonEmptyString,
	serializedNames: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64))
}).annotate({ identifier: "UAssetIoProjectIndexHeader" });
export interface UAssetIoProjectIndexHeader extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexHeader
> {}

const UAssetIoProjectIndexInventory = Schema.Struct({
	kind: Schema.Literal("inventory"),
	packagePath: NonEmptyString,
	signature: NonEmptyString,
	headerData: Schema.optionalKey(PackageHeaderData)
});

const DependencyProperties = {
	hard: Schema.Boolean,
	game: Schema.Boolean,
	build: Schema.Boolean
};

/**
 * v1.23: one dependency with Unreal's `EDependencyProperty` bits. `packagePath` is the indexed
 * package the name resolves to; it is absent for script, engine and unindexed packages.
 */
export const UAssetIoProjectIndexDependency = Schema.Struct({
	package: NonEmptyString,
	packagePath: Schema.optionalKey(NonEmptyString),
	...DependencyProperties
}).annotate({ identifier: "UAssetIoProjectIndexDependency" });
export interface UAssetIoProjectIndexDependency extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexDependency
> {}

/**
 * v1.23: a package from a `dependencies` or `dependents` query. `packageName` is the name Unreal
 * mounts the file as. `failure` is set when its header could not be read, so its dependencies are
 * unknown rather than empty.
 */
export const UAssetIoProjectIndexPackage = Schema.Struct({
	classes: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
	dependencies: Schema.Array(UAssetIoProjectIndexDependency),
	failure: Schema.optionalKey(NonEmptyString),
	kind: Schema.Literal("package"),
	packageName: NonEmptyString,
	packagePath: NonEmptyString
}).annotate({ identifier: "UAssetIoProjectIndexPackage" });
export interface UAssetIoProjectIndexPackage extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexPackage
> {}

/**
 * One query page item, discriminated by `kind`: `map`, `header`, `inventory`, or (v1.23 dependency
 * queries) `package`. An inventory item carries the package path, an opaque change signature, and
 * optional minor-9 `headerData`.
 */
export const UAssetIoProjectIndexItem = Schema.Union([
	UAssetIoProjectIndexMap,
	UAssetIoProjectIndexHeader,
	UAssetIoProjectIndexInventory,
	UAssetIoProjectIndexPackage
]).annotate({ identifier: "UAssetIoProjectIndexItem" });
export type UAssetIoProjectIndexItem = Schema.Schema.Type<typeof UAssetIoProjectIndexItem>;

/**
 * One page of query results from a single generation: at most 1,024 items in project-relative
 * path order. `nextCursor` is absent on the last page; pass it back unchanged with the same
 * `expectedGeneration` to continue.
 */
export const UAssetIoProjectIndexPage = Schema.Struct({
	generation: PositiveInt,
	items: Schema.Array(UAssetIoProjectIndexItem).check(
		Schema.isMaxLength(UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE)
	),
	nextCursor: Schema.optionalKey(NonEmptyString),
	projectId: NonEmptyString
}).annotate({ identifier: "UAssetIoProjectIndexPage" });
export interface UAssetIoProjectIndexPage extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexPage
> {}

const UAssetIoProjectIndexDictionaryHeader = Schema.Struct({
	...UAssetIoProjectIndexHeader.fields,
	classes: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(64)),
	serializedNames: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(64))
}).annotate({ identifier: "UAssetIoProjectIndexDictionaryHeader" });

const UAssetIoProjectIndexDictionaryPackage = Schema.Struct({
	...UAssetIoProjectIndexPackage.fields,
	classes: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(64)),
	dependencies: Schema.Array(
		Schema.Struct({
			package: NonNegativeInt,
			packagePath: Schema.optionalKey(NonNegativeInt),
			...DependencyProperties
		})
	)
}).annotate({ identifier: "UAssetIoProjectIndexDictionaryPackage" });

/** v1.3 page-local references; adapters additionally reject indices outside `strings`. */
export const UAssetIoProjectIndexDictionaryPage = Schema.Struct({
	...UAssetIoProjectIndexPage.fields,
	items: Schema.Array(
		Schema.Union([
			UAssetIoProjectIndexMap,
			UAssetIoProjectIndexDictionaryHeader,
			UAssetIoProjectIndexInventory,
			UAssetIoProjectIndexDictionaryPackage
		])
	).check(Schema.isMaxLength(UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE)),
	strings: Schema.Array(NonEmptyString).check(
		Schema.isMaxLength(UASSET_IO_PROJECT_INDEX_MAX_PAGE_SIZE * 128)
	)
}).annotate({ identifier: "UAssetIoProjectIndexDictionaryPage" });
/**
 * A decoded v1.3 dictionary page. Header `classes` and `serializedNames` are zero-based indices
 * into this page's `strings`; schema decoding does not check them against its length.
 */
export interface UAssetIoProjectIndexDictionaryPage extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexDictionaryPage
> {}

const PackageTextOperation = Schema.Struct({
	...UAssetIoProjectSelection.fields,
	kind: Schema.Literal("extract_text_packages"),
	/** Staging needs v1.19 and a request that satisfies `StagedPackageTextOperation`. */
	staging: Schema.optionalKey(Schema.Never)
});
/** Complete shard inventories for v1.20 native column preparation. The reader writes one raw
 * snapshot per group and rejects missing/duplicate packages or mismatched retained signatures.
 * Every shard must fit in one request; record files are bounded to 64 MiB per JSON record.
 */
export const UAssetIoPackageTextSnapshots: Schema.Codec<GameTextContract.PackageTextSnapshotRequest> =
	Schema.Struct({
		shards: Schema.Array(
			Schema.Struct({
				group: NonNegativeInt,
				expected: Schema.Array(
					Schema.Struct({
						path: Schema.String,
						signature: Schema.String,
						selected: Schema.Boolean
					})
				)
			})
		),
		rules: Schema.Array(PackageTextAudienceRule),
		recordFiles: Schema.optionalKey(Schema.Array(Schema.String)),
		records: Schema.optionalKey(Schema.Array(Schema.String)),
		/** A `plan_packages` plan file: the reader stages these shards' selected packages. */
		planFile: Schema.optionalKey(Schema.String),
		groups: Schema.optionalKey(Schema.Array(NonNegativeInt))
	});
export type UAssetIoPackageTextSnapshots = GameTextContract.PackageTextSnapshotRequest;
/**
 * v1.19 package-text staging: each requested package's record or error is one JSON line in
 * `<directory>/<group>.ndjson` (`groups[i]` is `paths[i]`'s group), streamed as a
 * `staged_text_package` result. The directory must exist; an existing group file fails. v1.20
 * `snapshots` takes complete shard inventories and writes uncompressed snapshots from the records.
 */
export const UAssetIoPackageTextStaging = Schema.Struct({
	directory: NonEmptyString,
	groups: Schema.Array(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(4096))
	),
	snapshots: Schema.optionalKey(UAssetIoPackageTextSnapshots)
}).annotate({ identifier: "UAssetIoPackageTextStaging" });
export type UAssetIoPackageTextStaging = typeof UAssetIoPackageTextStaging.Type;
const StagedPackageTextOperation = Schema.Struct({
	paths: Schema.Array(NonEmptyString),
	projectRoot: NonEmptyString,
	kind: Schema.Literal("extract_text_packages"),
	staging: Schema.Struct({
		...UAssetIoPackageTextStaging.fields,
		snapshots: Schema.optionalKey(Schema.Never)
	})
});
const SnapshotPackageTextOperation = Schema.Struct({
	...StagedPackageTextOperation.fields,
	staging: Schema.Struct({
		...UAssetIoPackageTextStaging.fields,
		snapshots: UAssetIoPackageTextSnapshots
	})
});
const ExistingOperation = Schema.Union([
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("inspect")
	}),
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("blueprint")
	}),
	Schema.Struct({ assetPath: NonEmptyString, kind: Schema.Literal("level_sequence") }),
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("authoring")
	}),
	Schema.Struct({
		cachePath: Schema.optionalKey(NonEmptyString),
		depth: Schema.Literals(["header", "full"]),
		...UAssetIoProjectSelection.fields,
		...UAssetIoScanFilters.fields,
		inventory: Schema.optionalKey(Schema.Boolean),
		kind: Schema.Literal("scan")
	}),
	Schema.Struct({
		...UAssetIoProjectSelection.fields,
		kind: Schema.Literal("extract_text")
	}),
	Schema.Struct({
		...UAssetIoProjectSelection.fields,
		kind: Schema.Literal("extract_texture")
	}),
	Schema.Struct({
		kind: Schema.Literal("saved_world"),
		mapPath: NonEmptyString,
		projectRoot: NonEmptyString
	}),
	// `plugins` and `changes` need v1.23 (`ProjectIndexDependencyOperation`).
	Schema.Struct({
		kind: Schema.Literal("project_index_status"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Never)
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_refresh"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Never),
		changes: Schema.optionalKey(Schema.Never)
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_rebuild"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Never),
		changes: Schema.optionalKey(Schema.Never)
	}),
	Schema.Struct({
		cacheRoot: NonEmptyString,
		kind: Schema.Literal("project_index_count"),
		request: UAssetIoProjectIndexCount
	}),
	Schema.Struct({
		cacheRoot: NonEmptyString,
		kind: Schema.Literal("project_index_query"),
		pageEncoding: Schema.optionalKey(Schema.Literal("dictionary")),
		query: UAssetIoProjectIndexQuery
	})
]);
/**
 * v1.21: two saved revisions of one Blueprint compared, and up to `limit` (at most 1,000) of the
 * diff's entries from `offset`. A side is absent for an asset the change adds or deletes; the
 * worker rejects a request that names neither.
 */
const CompareBlueprintsOperation = Schema.Struct({
	kind: Schema.Literal("compare_blueprints"),
	before: Schema.optionalKey(NonEmptyString),
	after: Schema.optionalKey(NonEmptyString),
	offset: NonNegativeInt,
	limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
});
const GameTextIndexOperation = Schema.Struct({
	kind: Schema.Literal("game_text_index"),
	request: GameTextIndexBuildRequest
});
/**
 * v1.23 Project Index operations. `plugins: true` selects the index that also holds the content of
 * every project plugin that can contain content; it is a separate index with its own `projectId`,
 * so callers that index only `Content` are unaffected. `changes: true` asks a refresh to report the
 * paths that changed on disk since the previous generation.
 */
const ProjectIndexDependencyOperation = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("project_index_status"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_refresh"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Boolean),
		changes: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_rebuild"),
		...UAssetIoProjectIndexTarget,
		plugins: Schema.optionalKey(Schema.Boolean),
		changes: Schema.optionalKey(Schema.Boolean)
	}),
	Schema.Struct({
		cacheRoot: NonEmptyString,
		kind: Schema.Literal("project_index_query"),
		pageEncoding: Schema.optionalKey(Schema.Literal("dictionary")),
		query: UAssetIoProjectIndexDependencyQuery
	})
]);
/**
 * Every operation a request can carry, discriminated by `kind`. String fields are trimmed and
 * must be non-empty; an explicit empty `paths` array selects zero work, not the project root.
 */
export const UAssetIoOperation = Schema.Union([
	GameTextIndexOperation,
	...ExistingOperation.members,
	...ProjectIndexDependencyOperation.members,
	CompareBlueprintsOperation,
	StagedPackageTextOperation,
	SnapshotPackageTextOperation,
	PackageTextOperation
]).annotate({ identifier: "UAssetIoOperation" });
export type UAssetIoOperation = Schema.Schema.Type<typeof UAssetIoOperation>;

const RequestFields = {
	limits: UAssetIoResourceLimits,
	requestId: NonEmptyString
};
/**
 * The single request a caller writes to the worker's stdin; `requestId` is echoed on every event.
 * `extract_text_packages` decodes only with contract minor 8 or later.
 */
export const UAssetIoRequest = Schema.Union([
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(13))
				})
			})
		).annotate({ identifier: "UAssetIoGameTextIndexContract" }),
		operation: Schema.Struct({
			...GameTextIndexOperation.fields,
			request: GameTextIndexPreviousBuildRequest
		})
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16))
				})
			})
		).annotate({ identifier: "UAssetIoPackageReplacementContract" }),
		operation: Schema.Struct({
			...GameTextIndexOperation.fields,
			request: Schema.Union([
				GameTextIndexPackageReplacement,
				GameTextIndexPackagePlan,
				GameTextIndexCodeLayer,
				GameTextIndexReadPoint,
				GameTextIndexDiskChanges
			])
		})
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(22))
				})
			})
		).annotate({ identifier: "UAssetIoPackageComparisonContract" }),
		operation: Schema.Struct({
			...GameTextIndexOperation.fields,
			request: GameTextIndexPackageComparison
		})
	}),
	Schema.Struct({ ...RequestFields, contract: UAssetIoContract, operation: ExistingOperation }),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(23))
				})
			})
		).annotate({ identifier: "UAssetIoProjectIndexDependencyContract" }),
		operation: ProjectIndexDependencyOperation
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(21))
				})
			})
		).annotate({ identifier: "UAssetIoBlueprintComparisonContract" }),
		operation: CompareBlueprintsOperation
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: Schema.Literal(1),
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(20))
				})
			})
		),
		operation: SnapshotPackageTextOperation
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: UAssetIoContract.fields.version.fields.major,
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(19))
				})
			})
		).annotate({ identifier: "UAssetIoPackageTextStagingContract" }),
		operation: StagedPackageTextOperation
	}),
	Schema.Struct({
		...RequestFields,
		contract: UAssetIoContract.pipe(
			Schema.fieldsAssign({
				version: Schema.Struct({
					major: UAssetIoContract.fields.version.fields.major,
					minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(8))
				})
			})
		).annotate({ identifier: "UAssetIoPackageTextContract" }),
		operation: PackageTextOperation
	})
]).annotate({ identifier: "UAssetIoRequest" });
export type UAssetIoRequest = Schema.Schema.Type<typeof UAssetIoRequest>;

const UAssetIoOperationKind = Schema.Literals([
	"game_text_index",
	"inspect",
	"blueprint",
	"compare_blueprints",
	"level_sequence",
	"authoring",
	"scan",
	"extract_text",
	"extract_text_packages",
	"extract_texture",
	"saved_world",
	"project_index_status",
	"project_index_refresh",
	"project_index_rebuild",
	"project_index_query",
	"project_index_count"
]);
/** Operation names the worker echoes in the `accepted` event. */
export type UAssetIoOperationKind = Schema.Schema.Type<typeof UAssetIoOperationKind>;

/** Typed result frames carried between the IO worker and its Effect consumer. */
export const UAssetIoResult = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("game_text_index"), outcome: GameTextIndexBuildOutcome }),
	Schema.Struct({
		kind: Schema.Literal("project_index_count"),
		result: UAssetIoProjectIndexCountResult
	}),
	Schema.Struct({ inspection: SavedAssetInspection, kind: Schema.Literal("inspect") }),
	Schema.Struct({ blueprint: BlueprintGraphProjection, kind: Schema.Literal("blueprint") }),
	/** v1.21: one page of a Blueprint comparison. */
	Schema.Struct({
		comparison: BlueprintComparison,
		kind: Schema.Literal("blueprint_comparison")
	}),
	Schema.Struct({ sequence: LevelSequenceProjection, kind: Schema.Literal("level_sequence") }),
	Schema.Struct({ kind: Schema.Literal("authoring"), snapshot: AuthoringTableSnapshot }),
	Schema.Struct({ entry: SavedAssetScanEntry, kind: Schema.Literal("scan_asset") }),
	Schema.Struct({ entry: SavedAssetManifestEntry, kind: Schema.Literal("scan_inventory") }),
	Schema.Struct({ kind: Schema.Literal("scan_summary"), summary: SavedAssetScanSummary }),
	Schema.Struct({ event: SavedAssetTextExtractionEvent, kind: Schema.Literal("extract_text") }),
	Schema.Struct({
		event: SavedAssetPackageTextEvent,
		kind: Schema.Literal("extract_text_packages")
	}),
	/** v1.19: one requested package's record was written to its staging group's file. */
	Schema.Struct({
		kind: Schema.Literal("staged_text_package"),
		path: NonEmptyString,
		group: NonNegativeInt,
		bytes: NonNegativeInt
	}),
	Schema.Struct({
		event: SavedAssetTextureExtractionEvent,
		kind: Schema.Literal("extract_texture")
	}),
	Schema.Struct({ kind: Schema.Literal("saved_world"), world: SavedWorld }),
	Schema.Struct({
		kind: Schema.Literal("project_index_status"),
		status: UAssetIoProjectIndexStatus
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_summary"),
		summary: UAssetIoProjectIndexSummary
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_page"),
		page: UAssetIoProjectIndexPage
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_dictionary_page"),
		page: UAssetIoProjectIndexDictionaryPage
	})
]).annotate({ identifier: "UAssetIoResult" });
export type UAssetIoResult = Schema.Schema.Type<typeof UAssetIoResult>;

const UAssetIoEventFields = {
	contract: UAssetIoContract,
	requestId: NonEmptyString,
	sequence: NonNegativeInt
};

/**
 * One NDJSON frame of the worker's stdout stream. Every frame repeats the contract and
 * `requestId`, and `sequence` counts from zero without gaps. A supported request starts with
 * `accepted` and ends with exactly one terminal `completed`, `failed`, or `rejected` frame.
 */
export const UAssetIoEvent = Schema.Union([
	Schema.Struct({
		...UAssetIoEventFields,
		kind: Schema.Literal("accepted"),
		operation: UAssetIoOperationKind
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		completedItems: NonNegativeInt,
		kind: Schema.Literal("progress"),
		phase: Schema.Literals([
			"starting",
			"discovering",
			"reading",
			"inspecting",
			"emitting",
			"enumerating",
			"comparing",
			"reading_headers",
			"committing"
		]),
		totalItems: Schema.optionalKey(NonNegativeInt)
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		code: NonEmptyString,
		kind: Schema.Literal("diagnostic"),
		message: NonEmptyString,
		severity: Schema.Literals(["info", "warning"])
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		kind: Schema.Literal("completed"),
		outcome: Schema.Literals(["complete", "partial"])
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		actualGeneration: Schema.optionalKey(PositiveInt),
		code: NonEmptyString,
		expectedGeneration: Schema.optionalKey(PositiveInt),
		kind: Schema.Literal("failed"),
		message: NonEmptyString,
		retrySafe: Schema.Boolean
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		kind: Schema.Literal("rejected"),
		problems: Schema.Array(NonEmptyString)
	}),
	Schema.Struct({
		...UAssetIoEventFields,
		kind: Schema.Literal("result"),
		result: UAssetIoResult
	})
]).annotate({ identifier: "UAssetIoEvent" });
export type UAssetIoEvent = Schema.Schema.Type<typeof UAssetIoEvent>;

/**
 * Decodes an untrusted request value. Fails with a `ContractParseError` when the shape, bounds, or
 * minor-version requirement is not met.
 */
export const decodeUAssetIoRequest = contractParser(UAssetIoRequest, "UAssetIoRequest");
/**
 * Decodes one parsed stdout frame. Fails with a `ContractParseError` when the frame does not match;
 * stream ordering and dictionary-page index bounds are left to the caller.
 */
export const decodeUAssetIoEvent = contractParser(UAssetIoEvent, "UAssetIoEvent");

/**
 * Builds the draft 2020-12 JSON Schema document for a uasset-io schema, in the form of the
 * checked-in contract files; shared integer and string definitions are rewritten to match them.
 */
export function makeUAssetIoJsonSchema(contract: Schema.Top) {
	const document = makeWireJsonSchemaDocument(contract, {
		referencePolicy: ({ identifier }) =>
			identifier === "UAssetIoNonEmptyStringEncoded" ? "UAssetIoNonEmptyString" : identifier
	});
	const definitions = { ...document.definitions };
	if ("UAssetIoNonNegativeInt" in definitions) {
		definitions.UAssetIoNonNegativeInt = {
			type: "integer",
			description: "an integer",
			title: "int",
			minimum: 0
		};
	}
	if ("UAssetIoPositiveInt" in definitions) {
		definitions.UAssetIoPositiveInt = {
			type: "integer",
			description: "an integer",
			title: "int",
			exclusiveMinimum: 0
		};
	}
	if ("UAssetIoNonEmptyString" in definitions) {
		definitions.UAssetIoNonEmptyString = {
			type: "string",
			description: "a string at least 1 character(s) long",
			title: "string",
			minLength: 1
		};
	}
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$defs: definitions,
		...document.schema
	};
}

import { Schema } from "effect";
import { AuthoringTableSnapshot } from "./authoring.js";
import { BlueprintGraphProjection } from "./blueprint-graph.js";
import { SavedWorld } from "./saved-world.js";
import {
	SavedAssetInspection,
	SavedAssetManifestEntry,
	SavedAssetScanEntry,
	SavedAssetScanSummary,
	SavedAssetTextExtractionEvent,
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

export const UAssetIoContract = Schema.Struct({
	name: Schema.Literal("uasset-io"),
	version: Schema.Struct({
		major: Schema.Literal(1),
		minor: NonNegativeInt
	})
}).annotate({ identifier: "UAssetIoContract" });
export type UAssetIoContract = Schema.Schema.Type<typeof UAssetIoContract>;

export const UAssetIoResourceLimits = Schema.Struct({
	concurrency: Schema.optionalKey(PositiveInt),
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

export const UAssetIoProjectIndexQuery = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("count"),
		...UAssetIoProjectIndexQueryBase,
		cursor: Schema.optionalKey(Schema.Never),
		limit: Schema.Literal(1),
		exactClasses: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
		classPrefixes: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
		classNameSuffixes: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
		serializedNames: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64))
	}),
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

export const UAssetIoProjectIndexDiagnostic = Schema.Struct({
	code: NonEmptyString,
	message: NonEmptyString,
	retrySafe: Schema.Boolean
}).annotate({ identifier: "UAssetIoProjectIndexDiagnostic" });
export interface UAssetIoProjectIndexDiagnostic extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexDiagnostic
> {}

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
	removedPackages: NonNegativeInt
}).annotate({ identifier: "UAssetIoProjectIndexSummary" });
export interface UAssetIoProjectIndexSummary extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexSummary
> {}

export const UAssetIoProjectIndexStatus = Schema.Union([
	Schema.Struct({ status: Schema.Literal("absent") }),
	Schema.Struct({ status: Schema.Literal("ready"), summary: UAssetIoProjectIndexSummary })
]).annotate({ identifier: "UAssetIoProjectIndexStatus" });
export type UAssetIoProjectIndexStatus = Schema.Schema.Type<typeof UAssetIoProjectIndexStatus>;

export const UAssetIoProjectIndexMap = Schema.Struct({
	kind: Schema.Literal("map"),
	mapPath: NonEmptyString,
	packageName: NonEmptyString
}).annotate({ identifier: "UAssetIoProjectIndexMap" });
export interface UAssetIoProjectIndexMap extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexMap
> {}

export const UAssetIoProjectIndexHeader = Schema.Struct({
	classes: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64)),
	kind: Schema.Literal("header"),
	packageName: NonEmptyString,
	packagePath: NonEmptyString,
	serializedNames: Schema.Array(NonEmptyString).check(Schema.isMaxLength(64))
}).annotate({ identifier: "UAssetIoProjectIndexHeader" });
export interface UAssetIoProjectIndexHeader extends Schema.Schema.Type<
	typeof UAssetIoProjectIndexHeader
> {}

export const UAssetIoProjectIndexItem = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("count"), count: NonNegativeInt }),
	UAssetIoProjectIndexMap,
	UAssetIoProjectIndexHeader
]).annotate({ identifier: "UAssetIoProjectIndexItem" });
export type UAssetIoProjectIndexItem = Schema.Schema.Type<typeof UAssetIoProjectIndexItem>;

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

export const UAssetIoOperation = Schema.Union([
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("inspect")
	}),
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("blueprint")
	}),
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
	Schema.Struct({
		kind: Schema.Literal("project_index_status"),
		...UAssetIoProjectIndexTarget
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_refresh"),
		...UAssetIoProjectIndexTarget
	}),
	Schema.Struct({
		kind: Schema.Literal("project_index_rebuild"),
		...UAssetIoProjectIndexTarget
	}),
	Schema.Struct({
		cacheRoot: NonEmptyString,
		kind: Schema.Literal("project_index_query"),
		query: UAssetIoProjectIndexQuery
	})
]).annotate({ identifier: "UAssetIoOperation" });
export type UAssetIoOperation = Schema.Schema.Type<typeof UAssetIoOperation>;

export const UAssetIoRequest = Schema.Struct({
	contract: UAssetIoContract,
	limits: UAssetIoResourceLimits,
	operation: UAssetIoOperation,
	requestId: NonEmptyString
}).annotate({ identifier: "UAssetIoRequest" });
export type UAssetIoRequest = Schema.Schema.Type<typeof UAssetIoRequest>;

const UAssetIoOperationKind = Schema.Literals([
	"inspect",
	"blueprint",
	"authoring",
	"scan",
	"extract_text",
	"extract_texture",
	"saved_world",
	"project_index_status",
	"project_index_refresh",
	"project_index_rebuild",
	"project_index_query"
]);
export type UAssetIoOperationKind = Schema.Schema.Type<typeof UAssetIoOperationKind>;

/** Typed result frames carried between the IO worker and its Effect consumer. */
export const UAssetIoResult = Schema.Union([
	Schema.Struct({ inspection: SavedAssetInspection, kind: Schema.Literal("inspect") }),
	Schema.Struct({ blueprint: BlueprintGraphProjection, kind: Schema.Literal("blueprint") }),
	Schema.Struct({ kind: Schema.Literal("authoring"), snapshot: AuthoringTableSnapshot }),
	Schema.Struct({ entry: SavedAssetScanEntry, kind: Schema.Literal("scan_asset") }),
	Schema.Struct({ entry: SavedAssetManifestEntry, kind: Schema.Literal("scan_inventory") }),
	Schema.Struct({ kind: Schema.Literal("scan_summary"), summary: SavedAssetScanSummary }),
	Schema.Struct({ event: SavedAssetTextExtractionEvent, kind: Schema.Literal("extract_text") }),
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
	})
]).annotate({ identifier: "UAssetIoResult" });
export type UAssetIoResult = Schema.Schema.Type<typeof UAssetIoResult>;

const UAssetIoEventFields = {
	contract: UAssetIoContract,
	requestId: NonEmptyString,
	sequence: NonNegativeInt
};

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

export const decodeUAssetIoRequest = Schema.decodeUnknownEffect(UAssetIoRequest);
export const decodeUAssetIoEvent = Schema.decodeUnknownEffect(UAssetIoEvent);

export function makeUAssetIoJsonSchema(contract: Schema.Top) {
	const document = Schema.toJsonSchemaDocument(contract);
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

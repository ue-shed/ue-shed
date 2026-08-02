import { Schema } from "effect";
import { AuthoringTableSnapshot } from "./authoring.js";
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

export const UAssetIoOperation = Schema.Union([
	Schema.Struct({
		assetPath: NonEmptyString,
		kind: Schema.Literal("inspect")
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
	"authoring",
	"scan",
	"extract_text",
	"extract_texture",
	"saved_world"
]);
export type UAssetIoOperationKind = Schema.Schema.Type<typeof UAssetIoOperationKind>;

/** Typed result frames carried between the IO worker and its Effect consumer. */
export const UAssetIoResult = Schema.Union([
	Schema.Struct({ inspection: SavedAssetInspection, kind: Schema.Literal("inspect") }),
	Schema.Struct({ kind: Schema.Literal("authoring"), snapshot: AuthoringTableSnapshot }),
	Schema.Struct({ entry: SavedAssetScanEntry, kind: Schema.Literal("scan_asset") }),
	Schema.Struct({ entry: SavedAssetManifestEntry, kind: Schema.Literal("scan_inventory") }),
	Schema.Struct({ kind: Schema.Literal("scan_summary"), summary: SavedAssetScanSummary }),
	Schema.Struct({ event: SavedAssetTextExtractionEvent, kind: Schema.Literal("extract_text") }),
	Schema.Struct({
		event: SavedAssetTextureExtractionEvent,
		kind: Schema.Literal("extract_texture")
	}),
	Schema.Struct({ kind: Schema.Literal("saved_world"), world: SavedWorld })
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
		phase: Schema.Literals(["starting", "discovering", "reading", "inspecting", "emitting"]),
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
		code: NonEmptyString,
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

export function makeUAssetIoJsonSchema(contract: Schema.Top): Readonly<Record<string, unknown>> {
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

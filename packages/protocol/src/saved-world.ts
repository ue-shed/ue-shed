import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SavedWorldVector = Schema.Struct({
	x: Schema.Number,
	y: Schema.Number,
	z: Schema.Number
});
export type SavedWorldVector = Schema.Schema.Type<typeof SavedWorldVector>;

export const SavedWorldPosition = Schema.Union([
	Schema.Struct({ status: Schema.Literal("missing_root_component") }),
	Schema.Struct({
		parentPath: Schema.String,
		status: Schema.Literal("missing_attachment_parent")
	}),
	Schema.Struct({ componentPath: Schema.String, status: Schema.Literal("attachment_cycle") }),
	Schema.Struct({
		componentPath: Schema.String,
		status: Schema.Literal("ambiguous_component_path")
	}),
	Schema.Struct({
		componentPath: Schema.String,
		status: Schema.Literal("unsupported_absolute_transform")
	}),
	Schema.Struct({ location: SavedWorldVector, status: Schema.Literal("resolved") })
]);
export type SavedWorldPosition = Schema.Schema.Type<typeof SavedWorldPosition>;

/** A configured map the offline viewer may load. Its path is always project-relative or absolute. */
export const SavedWorldMap = Schema.Struct({
	label: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString
});
export type SavedWorldMap = Schema.Schema.Type<typeof SavedWorldMap>;

/** A map projection from saved project files, independent of a running Unreal Editor. */
export const SavedWorld = Schema.Struct({
	authority: Schema.Struct({ kind: Schema.Literal("project_files"), mapPackage: Schema.String }),
	completeness: Schema.Literals(["complete", "partial"]),
	contract: Schema.Struct({
		name: Schema.Literal("unreal-saved-world"),
		version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Int })
	}),
	diagnostics: Schema.Array(
		Schema.Struct({ code: Schema.String, message: Schema.String, retrySafe: Schema.Boolean })
	),
	/** Present only when the map stores its actors as World Partition external packages. */
	externalActorRoot: Schema.optionalKey(Schema.String),
	mapPath: Schema.String,
	sourceKind: Schema.Literals(["level", "world_partition"]),
	actors: Schema.Array(
		Schema.Struct({
			actorGuid: Schema.optionalKey(Schema.String),
			actorPath: Schema.String,
			classPath: Schema.String,
			label: Schema.optionalKey(Schema.String),
			packageName: Schema.String,
			position: SavedWorldPosition
		})
	),
	summary: Schema.Struct({
		failedPackages: NonNegativeInt,
		partialPackages: NonNegativeInt,
		resolvedActors: NonNegativeInt,
		scannedPackages: NonNegativeInt
	})
}).annotate({ identifier: "SavedWorld" });
export type SavedWorld = Schema.Schema.Type<typeof SavedWorld>;

export const SavedWorldProgress = Schema.Struct({
	actorsFound: NonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "resolving", "ready", "failed"]),
	processedPackages: NonNegativeInt,
	totalPackages: NonNegativeInt
});
export type SavedWorldProgress = Schema.Schema.Type<typeof SavedWorldProgress>;

export const decodeSavedWorld = Schema.decodeUnknownEffect(SavedWorld);

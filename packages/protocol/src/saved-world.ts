import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SavedWorldVector = Schema.Struct({
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
export type SavedWorldVector = Schema.Schema.Type<typeof SavedWorldVector>;

export const SavedWorldQuaternion = Schema.Struct({
	w: Schema.Finite,
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
export type SavedWorldQuaternion = Schema.Schema.Type<typeof SavedWorldQuaternion>;

/** A direct saved root-component attachment. It deliberately does not infer parent actor ownership. */
export const SavedWorldAttachment = Schema.Struct({
	componentPath: Schema.NonEmptyString,
	parentComponentPath: Schema.NonEmptyString
});
export type SavedWorldAttachment = Schema.Schema.Type<typeof SavedWorldAttachment>;

export const SavedWorldTransform = Schema.Union([
	Schema.Struct({ status: Schema.Literal("missing_root_component") }),
	Schema.Struct({
		parentPath: Schema.NonEmptyString,
		status: Schema.Literal("missing_attachment_parent")
	}),
	Schema.Struct({
		componentPath: Schema.NonEmptyString,
		status: Schema.Literal("attachment_cycle")
	}),
	Schema.Struct({
		componentPath: Schema.NonEmptyString,
		status: Schema.Literal("ambiguous_component_path")
	}),
	Schema.Struct({
		componentPath: Schema.NonEmptyString,
		status: Schema.Literal("unsupported_absolute_transform")
	}),
	Schema.Struct({
		componentPath: Schema.NonEmptyString,
		status: Schema.Literal("non_finite_transform")
	}),
	Schema.Struct({
		location: SavedWorldVector,
		rotation: SavedWorldQuaternion,
		scale: SavedWorldVector,
		status: Schema.Literal("resolved")
	})
]);
export type SavedWorldTransform = Schema.Schema.Type<typeof SavedWorldTransform>;

/** A configured map the offline viewer may load. Its path is always project-relative or absolute. */
export const SavedWorldMap = Schema.Struct({
	label: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString
});
export type SavedWorldMap = Schema.Schema.Type<typeof SavedWorldMap>;

export const SavedWorldActor = Schema.Struct({
	actorGuid: Schema.optionalKey(Schema.String),
	actorPath: Schema.String,
	attachment: Schema.optionalKey(SavedWorldAttachment),
	classPath: Schema.String,
	/**
	 * Contract 2.1: `partial` when the actor's export or a subobject export failed to decode, or
	 * decoded with a property value kept raw (listed as a `skipped_property` package error).
	 * Absent in 2.0.
	 */
	decode: Schema.optionalKey(Schema.Literals(["complete", "partial"])),
	/**
	 * Contract 2.1: the actor holding this one through a child-actor component. Present only when
	 * that component's owner is a saved actor and its `ChildActor` names this actor.
	 */
	heldBy: Schema.optionalKey(Schema.NonEmptyString),
	label: Schema.optionalKey(Schema.String),
	packageName: Schema.String,
	/** Contract 2.1: the saved `AActor::ParentComponent` reference. */
	parentComponent: Schema.optionalKey(Schema.NonEmptyString),
	transform: SavedWorldTransform
});
export type SavedWorldActor = Schema.Schema.Type<typeof SavedWorldActor>;

/** Contract 2.1: a package, or one export in it, that the reader could not decode. */
export const SavedWorldPackageError = Schema.Struct({
	/** Long package name, or the package path implied by the file when its header is unreadable. */
	package: Schema.String,
	/** The failed export's object path; absent when the whole package could not be read. */
	export: Schema.optionalKey(Schema.String),
	/**
	 * `asset_io` or `asset_<kind>` for a package that could not be read, `export_<kind>` for an
	 * export that failed to decode, and `skipped_property` for an export that decoded with raw
	 * property values. Only failures make the package partial.
	 */
	category: Schema.String,
	detail: Schema.String,
	/**
	 * Whether an actor may have been lost: the failed export is an actor, or the whole package
	 * failed. Always false for `skipped_property`.
	 */
	actorDropped: Schema.Boolean
});
export type SavedWorldPackageError = Schema.Schema.Type<typeof SavedWorldPackageError>;

/** The outcome of choosing an in-app project and reading its discovered saved maps. */
export const SavedWorldChoice = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("configured"),
		projectRoot: Schema.String,
		projectName: Schema.String,
		maps: Schema.Array(SavedWorldMap)
	}),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type SavedWorldChoice = Schema.Schema.Type<typeof SavedWorldChoice>;
export const decodeSavedWorldChoice = Schema.decodeUnknownEffect(SavedWorldChoice);

/** A map projection from saved project files, independent of a running Unreal Editor. */
export const SavedWorld = Schema.Struct({
	authority: Schema.Struct({ kind: Schema.Literal("project_files"), mapPackage: Schema.String }),
	completeness: Schema.Literals(["complete", "partial"]),
	contract: Schema.Struct({
		name: Schema.Literal("unreal-saved-world"),
		/** 2.1 only adds optional fields, so 2.0 documents still decode. */
		version: Schema.Struct({ major: Schema.Literal(2), minor: Schema.Literals([0, 1]) })
	}),
	diagnostics: Schema.Array(
		Schema.Struct({ code: Schema.String, message: Schema.String, retrySafe: Schema.Boolean })
	),
	/** Present only when the map stores its actors as World Partition external packages. */
	externalActorRoot: Schema.optionalKey(Schema.String),
	mapPath: Schema.String,
	/** Contract 2.1: every package or export that could not be read. Absent in 2.0. */
	packageErrors: Schema.optionalKey(Schema.Array(SavedWorldPackageError)),
	sourceKind: Schema.Literals(["level", "world_partition"]),
	actors: Schema.Array(SavedWorldActor),
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
export const decodeSavedWorldProgress = Schema.decodeUnknownEffect(SavedWorldProgress);

export const decodeSavedWorld = Schema.decodeUnknownEffect(SavedWorld);

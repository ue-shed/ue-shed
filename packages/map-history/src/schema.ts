import { SavedWorldActor, SavedWorldTransform, SavedWorldVector } from "@ue-shed/protocol";
import { DateTime, Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProjectRoot = Schema.NonEmptyString.pipe(Schema.brand("MapHistoryProjectRoot"));
export type ProjectRoot = Schema.Schema.Type<typeof ProjectRoot>;

export const ProjectRelativeMapPath = Schema.NonEmptyString.pipe(
	Schema.brand("ProjectRelativeMapPath")
);
export type ProjectRelativeMapPath = Schema.Schema.Type<typeof ProjectRelativeMapPath>;

export const PerforceDepotPath = Schema.NonEmptyString.pipe(Schema.brand("PerforceDepotPath"));
export type PerforceDepotPath = Schema.Schema.Type<typeof PerforceDepotPath>;

export const PerforceChangeNumber = PositiveInt.pipe(Schema.brand("PerforceChangeNumber"));
export type PerforceChangeNumber = Schema.Schema.Type<typeof PerforceChangeNumber>;

export const UtcTimestamp = Schema.DateTimeUtcFromString.pipe(
	Schema.brand("MapHistoryUtcTimestamp")
);
export type UtcTimestamp = Schema.Schema.Type<typeof UtcTimestamp>;

export const MapHistoryRange = Schema.Struct({
	since: UtcTimestamp,
	until: UtcTimestamp
}).check(
	Schema.makeFilter((range) =>
		DateTime.toEpochMillis(range.since) <= DateTime.toEpochMillis(range.until)
			? undefined
			: "The history range must end at or after its start."
	)
);
export type MapHistoryRange = Schema.Schema.Type<typeof MapHistoryRange>;

export const MapHistoryLimits = Schema.Struct({
	maxChangelists: PositiveInt,
	maxPackages: PositiveInt,
	maxMaterializedFiles: PositiveInt,
	maxConcurrency: PositiveInt,
	maxDurationMs: PositiveInt
});
export type MapHistoryLimits = Schema.Schema.Type<typeof MapHistoryLimits>;

export const PerforceMapHistoryQuery = Schema.Struct({
	projectRoot: ProjectRoot,
	mapPath: ProjectRelativeMapPath,
	range: MapHistoryRange,
	limits: MapHistoryLimits
});
export type PerforceMapHistoryQuery = Schema.Schema.Type<typeof PerforceMapHistoryQuery>;

export const ActorIdentity = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("actor_guid"),
		actorGuid: Schema.NonEmptyString
	}),
	Schema.Struct({
		kind: Schema.Literal("object_path"),
		packageName: Schema.NonEmptyString,
		actorPath: Schema.NonEmptyString
	})
]);
export type ActorIdentity = Schema.Schema.Type<typeof ActorIdentity>;

/**
 * Deep History request with an explicit mode tag. The legacy {@link PerforceMapHistoryQuery}
 * remains the Deep History wire contract for existing CLI and Workbench callers.
 */
export const PerforceDeepMapHistoryQuery = Schema.Struct({
	mode: Schema.Literal("deep"),
	projectRoot: ProjectRoot,
	mapPath: ProjectRelativeMapPath,
	range: MapHistoryRange,
	limits: MapHistoryLimits
});
export type PerforceDeepMapHistoryQuery = Schema.Schema.Type<typeof PerforceDeepMapHistoryQuery>;

/** Pre-scan Investigation Target. Fast History stays anchored to the present-day projection. */
export const FastHistoryInvestigationTarget = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("actor"),
		identity: ActorIdentity
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_class"),
		classPath: Schema.NonEmptyString
	})
]);
export type FastHistoryInvestigationTarget = Schema.Schema.Type<
	typeof FastHistoryInvestigationTarget
>;

export const PerforceFastMapHistoryQuery = Schema.Struct({
	mode: Schema.Literal("fast"),
	projectRoot: ProjectRoot,
	mapPath: ProjectRelativeMapPath,
	range: MapHistoryRange,
	limits: MapHistoryLimits,
	target: FastHistoryInvestigationTarget
});
export type PerforceFastMapHistoryQuery = Schema.Schema.Type<typeof PerforceFastMapHistoryQuery>;

/** Discriminated Map History request. Prefer this when a caller must choose Deep vs Fast. */
export const MapHistoryQuery = Schema.Union([
	PerforceDeepMapHistoryQuery,
	PerforceFastMapHistoryQuery
]);
export type MapHistoryQuery = Schema.Schema.Type<typeof MapHistoryQuery>;

const ActorTransition = {
	identity: ActorIdentity,
	before: SavedWorldActor,
	after: SavedWorldActor
};

export const MapChange = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("actor_added"),
		identity: ActorIdentity,
		after: SavedWorldActor
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_removed"),
		identity: ActorIdentity,
		before: SavedWorldActor
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_moved"),
		...ActorTransition,
		beforeLocation: SavedWorldVector,
		afterLocation: SavedWorldVector
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_label_changed"),
		...ActorTransition
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_class_changed"),
		...ActorTransition
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_package_changed"),
		...ActorTransition
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_attachment_changed"),
		...ActorTransition
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_transform_changed"),
		...ActorTransition,
		beforeTransform: SavedWorldTransform,
		afterTransform: SavedWorldTransform
	}),
	Schema.Struct({
		kind: Schema.Literal("actor_transform_resolution_changed"),
		...ActorTransition,
		beforeTransform: SavedWorldTransform,
		afterTransform: SavedWorldTransform
	}),
	Schema.Struct({
		kind: Schema.Literal("snapshot_coverage_changed"),
		before: Schema.Struct({
			completeness: Schema.Literals(["complete", "partial"]),
			failedPackages: NonNegativeInt,
			partialPackages: NonNegativeInt
		}),
		after: Schema.Struct({
			completeness: Schema.Literals(["complete", "partial"]),
			failedPackages: NonNegativeInt,
			partialPackages: NonNegativeInt
		})
	})
]);
export type MapChange = Schema.Schema.Type<typeof MapChange>;

export const MapHistoryDiagnostic = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	retrySafe: Schema.Boolean
});
export type MapHistoryDiagnostic = Schema.Schema.Type<typeof MapHistoryDiagnostic>;

export const MapSnapshotDiff = Schema.Struct({
	changes: Schema.Array(MapChange),
	diagnostics: Schema.Array(MapHistoryDiagnostic)
});
export type MapSnapshotDiff = Schema.Schema.Type<typeof MapSnapshotDiff>;

export const PerforcePackageRevision = Schema.Struct({
	depotPath: PerforceDepotPath,
	revision: PositiveInt,
	action: Schema.NonEmptyString
});
export type PerforcePackageRevision = Schema.Schema.Type<typeof PerforcePackageRevision>;

export const SavedPackageChangeEvidence = Schema.Struct({
	depotPath: PerforceDepotPath,
	packageName: Schema.NonEmptyString,
	beforeRevision: Schema.NullOr(PositiveInt),
	afterRevision: Schema.NullOr(PositiveInt),
	action: Schema.NonEmptyString
});
export type SavedPackageChangeEvidence = Schema.Schema.Type<typeof SavedPackageChangeEvidence>;

export const UnclassifiedPackageChange = Schema.Struct({
	depotPath: PerforceDepotPath,
	packageName: Schema.NonEmptyString,
	beforeRevision: Schema.NullOr(PositiveInt),
	afterRevision: Schema.NullOr(PositiveInt),
	action: Schema.NonEmptyString,
	actorIdentities: Schema.Array(ActorIdentity),
	reason: Schema.Literals([
		"projection_unchanged",
		"snapshot_partial",
		"actor_identity_unavailable"
	])
});
export type UnclassifiedPackageChange = Schema.Schema.Type<typeof UnclassifiedPackageChange>;

export const PerforceMapRevision = Schema.Struct({
	change: PerforceChangeNumber,
	user: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.String),
	submittedAt: UtcTimestamp,
	files: Schema.Array(PerforcePackageRevision),
	changes: Schema.Array(MapChange),
	unclassifiedPackageChanges: Schema.Array(UnclassifiedPackageChange),
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(MapHistoryDiagnostic)
});
export type PerforceMapRevision = Schema.Schema.Type<typeof PerforceMapRevision>;

/**
 * Renderer-safe evidence for one reconstructed saved world. This deliberately excludes the
 * temporary reconstruction root: consumers can inspect saved actor facts without gaining a path
 * into the owned historical workspace, which is removed after the operation.
 */
export const MapHistorySnapshot = Schema.Struct({
	actors: Schema.Array(SavedWorldActor),
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(MapHistoryDiagnostic),
	mapPackage: Schema.String,
	mapPath: ProjectRelativeMapPath,
	sourceKind: Schema.Literals(["level", "world_partition"]),
	summary: Schema.Struct({
		failedPackages: NonNegativeInt,
		partialPackages: NonNegativeInt,
		resolvedActors: NonNegativeInt,
		scannedPackages: NonNegativeInt
	})
});
export type MapHistorySnapshot = Schema.Schema.Type<typeof MapHistorySnapshot>;

/** Saved actor state immediately before the requested range. */
export const MapHistoryRangeStartSnapshot = MapHistorySnapshot;
export type MapHistoryRangeStartSnapshot = MapHistorySnapshot;

/** Saved actor state at the requested range end. */
export const MapHistoryRangeEndSnapshot = MapHistorySnapshot;
export type MapHistoryRangeEndSnapshot = MapHistorySnapshot;

export const PerforceMapHistory = Schema.Struct({
	schemaVersion: Schema.Literal(2),
	query: PerforceMapHistoryQuery,
	mapDepotPath: PerforceDepotPath,
	externalActorDepotRoot: Schema.optionalKey(PerforceDepotPath),
	/** Absent only when the selected map did not exist immediately before the requested range. */
	rangeStartSnapshot: Schema.optionalKey(MapHistoryRangeStartSnapshot),
	/** Absent only when the selected map did not exist by the requested range end. */
	rangeEndSnapshot: Schema.optionalKey(MapHistoryRangeEndSnapshot),
	baseline: Schema.Union([
		Schema.Struct({ status: Schema.Literal("available"), change: PerforceChangeNumber }),
		Schema.Struct({ status: Schema.Literal("map_not_yet_created") })
	]),
	revisions: Schema.Array(PerforceMapRevision),
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(MapHistoryDiagnostic)
});
export type PerforceMapHistory = Schema.Schema.Type<typeof PerforceMapHistory>;

export const FastHistoryAcquiredPackage = Schema.Struct({
	depotFileSpec: PerforceDepotPath,
	packageName: Schema.NonEmptyString,
	role: Schema.Literals([
		"selected_map",
		"investigation_target_actor",
		"investigation_target_class"
	])
});
export type FastHistoryAcquiredPackage = Schema.Schema.Type<typeof FastHistoryAcquiredPackage>;

/**
 * Explicit Fast History coverage. Targeted acquisition must never claim a complete map corpus or
 * historical class discovery.
 */
export const FastHistoryTargetedCoverage = Schema.Struct({
	kind: Schema.Literal("targeted"),
	claimsCompleteMapCoverage: Schema.Literal(false),
	claimsHistoricalClassCoverage: Schema.Literal(false),
	investigationTarget: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("actor"),
			identity: ActorIdentity,
			actorGuid: Schema.optionalKey(Schema.NonEmptyString),
			actorPath: Schema.NonEmptyString,
			classPath: Schema.NonEmptyString,
			packageName: Schema.NonEmptyString
		}),
		Schema.Struct({
			kind: Schema.Literal("actor_class"),
			classPath: Schema.NonEmptyString,
			currentActorCount: NonNegativeInt
		})
	]),
	acquiredPackages: Schema.Array(FastHistoryAcquiredPackage)
});
export type FastHistoryTargetedCoverage = Schema.Schema.Type<typeof FastHistoryTargetedCoverage>;

export const PerforceFastMapHistory = Schema.Struct({
	schemaVersion: Schema.Literal(2),
	mode: Schema.Literal("fast"),
	query: PerforceFastMapHistoryQuery,
	coverage: FastHistoryTargetedCoverage,
	mapDepotPath: PerforceDepotPath,
	externalActorDepotRoot: Schema.optionalKey(PerforceDepotPath),
	rangeStartSnapshot: Schema.optionalKey(MapHistoryRangeStartSnapshot),
	rangeEndSnapshot: Schema.optionalKey(MapHistoryRangeEndSnapshot),
	baseline: Schema.Union([
		Schema.Struct({ status: Schema.Literal("available"), change: PerforceChangeNumber }),
		Schema.Struct({ status: Schema.Literal("map_not_yet_created") })
	]),
	revisions: Schema.Array(PerforceMapRevision),
	completeness: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(MapHistoryDiagnostic)
});
export type PerforceFastMapHistory = Schema.Schema.Type<typeof PerforceFastMapHistory>;

/** A renderer-facing history document from either the complete or targeted acquisition path. */
export type PerforceMapHistoryDocument = PerforceMapHistory | PerforceFastMapHistory;

export const MapHistoryDeepResult = Schema.Struct({
	mode: Schema.Literal("deep"),
	history: PerforceMapHistory
});
export type MapHistoryDeepResult = Schema.Schema.Type<typeof MapHistoryDeepResult>;

/** Discriminated Map History result. Deep History documents remain nestable without altering their wire shape. */
export const MapHistoryResult = Schema.Union([MapHistoryDeepResult, PerforceFastMapHistory]);
export type MapHistoryResult = Schema.Schema.Type<typeof MapHistoryResult>;

export const MapHistoryProgress = Schema.Struct({
	phase: Schema.Literals([
		"idle",
		"resolving_scope",
		"listing_changes",
		"materializing_baseline",
		"applying_revision",
		"parsing",
		"diffing",
		"ready",
		"failed"
	]),
	processedChangelists: NonNegativeInt,
	totalChangelists: NonNegativeInt
});
export type MapHistoryProgress = Schema.Schema.Type<typeof MapHistoryProgress>;

export const decodePerforceMapHistoryQuery = Schema.decodeUnknownEffect(PerforceMapHistoryQuery);
export const decodePerforceMapHistory = Schema.decodeUnknownEffect(PerforceMapHistory);
export const decodePerforceFastMapHistoryQuery = Schema.decodeUnknownEffect(
	PerforceFastMapHistoryQuery
);
export const decodePerforceFastMapHistory = Schema.decodeUnknownEffect(PerforceFastMapHistory);
export const decodeMapHistoryQuery = Schema.decodeUnknownEffect(MapHistoryQuery);
export const decodeMapHistoryResult = Schema.decodeUnknownEffect(MapHistoryResult);

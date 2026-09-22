import { Schema } from "effect";

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const integer = (minimum: number, maximum: number) =>
	Schema.Int.check(Schema.isBetween({ minimum, maximum }));
export const WorldLeaseId = id.pipe(Schema.brand("WorldLeaseId"));
export type WorldLeaseId = typeof WorldLeaseId.Type;
export const WorldId = id.pipe(Schema.brand("WorldId"));
export type WorldId = typeof WorldId.Type;
export const WorldVector = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, z: Schema.Finite });
export const WorldExtent = Schema.Struct({
	x: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
	y: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 })),
	z: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 }))
});
export const WorldRegion = Schema.Struct({ center: WorldVector, extent: WorldExtent });
export type WorldRegion = typeof WorldRegion.Type;
export const WorldActorIdentity = Schema.Struct({
	actorGuid: Schema.String.check(
		Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	),
	containerId: text
});
export type WorldActorIdentity = typeof WorldActorIdentity.Type;
export const WorldTarget = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("region"), region: WorldRegion }),
	Schema.Struct({
		kind: Schema.Literal("actor"),
		actor: WorldActorIdentity,
		contextExtent: WorldExtent
	})
]);
export type WorldTarget = typeof WorldTarget.Type;
export const WorldLayerRequirement = Schema.Struct({
	assetPath: text,
	loaded: Schema.Boolean,
	visible: Schema.Boolean
});
export const WorldIdentity = Schema.Struct({
	worldId: WorldId,
	mapPath: text,
	projectName: text,
	partitioned: Schema.Boolean,
	streamingEnabled: Schema.Boolean
});
export type WorldIdentity = typeof WorldIdentity.Type;
export const WorldRequirements = Schema.Struct({
	world: WorldIdentity,
	targets: Schema.Array(WorldTarget).check(Schema.isMaxLength(64)),
	dataLayers: Schema.Array(WorldLayerRequirement).check(Schema.isMaxLength(64)),
	maximumActors: integer(1, 100000)
});
export type WorldRequirements = typeof WorldRequirements.Type;
export const WorldActorEvidence = Schema.Struct({
	...WorldActorIdentity.fields,
	label: Schema.String,
	classPath: text,
	region: Schema.NullOr(
		Schema.Struct({
			center: WorldVector,
			extent: Schema.Struct({
				x: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
				y: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
				z: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
			})
		})
	),
	spatiallyLoaded: Schema.Boolean,
	loaded: Schema.Boolean,
	registered: Schema.Boolean,
	visible: Schema.Boolean,
	dependency: Schema.Boolean
});
export type WorldActorEvidence = typeof WorldActorEvidence.Type;
export const WorldIssue = Schema.Struct({ code: text, subject: text, message: text });
export type WorldIssue = typeof WorldIssue.Type;
export const WorldSnapshot = Schema.Struct({
	status: Schema.Literals(["planned", "ready", "blocked", "released"]),
	world: WorldIdentity,
	leaseId: WorldLeaseId,
	revision: integer(0, 1000000),
	regions: Schema.Array(WorldRegion).check(Schema.isMaxLength(64)),
	actors: Schema.Array(WorldActorEvidence).check(Schema.isMaxLength(100000)),
	issues: Schema.Array(WorldIssue).check(Schema.isMaxLength(128)),
	renderReadiness: Schema.Literal("not_assessed")
});
export type WorldSnapshot = typeof WorldSnapshot.Type;
export const WorldFailure = Schema.Struct({
	status: Schema.Literal("failed"),
	code: text,
	message: text,
	recovery: text
});
export type WorldFailure = typeof WorldFailure.Type;
export const WorldContract = Schema.Struct({
	name: Schema.Literal("ue-shed-world-preparation"),
	version: Schema.Struct({ major: Schema.Literal(1), minor: Schema.Literal(0) })
});
export const worldPreparationContract = {
	name: "ue-shed-world-preparation",
	version: { major: 1, minor: 0 }
} as const;
const base = { contract: WorldContract };
const owned = { ...base, leaseId: WorldLeaseId, worldId: WorldId };
export const WorldRequest = Schema.Union([
	Schema.Struct({ ...base, action: Schema.Literal("describe") }),
	Schema.Struct({ ...base, action: Schema.Literal("plan"), requirements: WorldRequirements }),
	Schema.Struct({
		...base,
		action: Schema.Literal("acquire"),
		leaseId: WorldLeaseId,
		leaseMs: integer(1000, 120000),
		requirements: WorldRequirements
	}),
	Schema.Struct({
		...owned,
		action: Schema.Literal("replace"),
		revision: integer(1, 1000000),
		targets: WorldRequirements.fields.targets
	}),
	Schema.Struct({ ...owned, action: Schema.Literals(["poll", "release"]) })
]);
export type WorldRequest = typeof WorldRequest.Type;
export const WorldResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("described"), world: WorldIdentity }),
	WorldSnapshot,
	WorldFailure
]);
export type WorldResponse = typeof WorldResponse.Type;

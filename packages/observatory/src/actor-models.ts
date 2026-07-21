import { Schema } from "effect";

export const ActorId = Schema.NonEmptyString.pipe(Schema.brand("ActorId"));
export type ActorId = Schema.Schema.Type<typeof ActorId>;

export const WorldVector = Schema.Struct({
	x: Schema.Finite,
	y: Schema.Finite,
	z: Schema.Finite
});
export interface WorldVector extends Schema.Schema.Type<typeof WorldVector> {}

export const ObservedActor = Schema.Struct({
	bounds: Schema.Struct({
		center: WorldVector,
		extent: WorldVector
	}),
	className: Schema.NonEmptyString,
	displayName: Schema.NonEmptyString,
	id: ActorId,
	location: WorldVector,
	path: Schema.NonEmptyString,
	rotation: WorldVector
});
export interface ObservedActor extends Schema.Schema.Type<typeof ObservedActor> {}

export const WorldActorSnapshot = Schema.Struct({
	actors: Schema.Array(ObservedActor),
	capturedAt: Schema.String,
	mapPath: Schema.NonEmptyString,
	sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	worldKind: Schema.Literals(["editor", "pie"]),
	worldSeconds: Schema.Finite
});
export interface WorldActorSnapshot extends Schema.Schema.Type<typeof WorldActorSnapshot> {}

import { Schema } from "effect";
import { ActorId, WorldActorSnapshot } from "./actor-models.js";
export const WorldScoutRefreshRate = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(60)
).pipe(Schema.brand("WorldScoutRefreshRate"));
export type WorldScoutRefreshRate = Schema.Schema.Type<typeof WorldScoutRefreshRate>;

export const SnapshotResponse = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		snapshot: WorldActorSnapshot
	}),
	Schema.Struct({
		status: Schema.Literal("failed"),
		message: Schema.String,
		recovery: Schema.String
	})
]);

export const FocusResponse = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("focused"),
		actorId: ActorId,
		authoringSubject: Schema.Literals(["selected", "runtime_only"])
	}),
	Schema.Struct({ status: Schema.Literal("not_found"), actorId: ActorId }),
	Schema.Struct({ status: Schema.Literal("not_supported"), actorId: ActorId }),
	Schema.Struct({
		status: Schema.Literal("failed"),
		actorId: ActorId,
		message: Schema.String,
		recovery: Schema.String
	})
]);

export const WorldScoutResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), snapshot: WorldActorSnapshot }),
	Schema.Struct({
		status: Schema.Literal("unavailable"),
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type WorldScoutResult = Schema.Schema.Type<typeof WorldScoutResult>;

export const WorldScoutFocusResult = FocusResponse;
export type WorldScoutFocusResult = Schema.Schema.Type<typeof WorldScoutFocusResult>;

import { RemoteControlClient, RemoteControlClientError } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";

export const ActorId = Schema.NonEmptyString.pipe(Schema.brand("ActorId"));
export type ActorId = Schema.Schema.Type<typeof ActorId>;

export const WorldScoutRefreshRate = Schema.Int.check(
	Schema.isGreaterThanOrEqualTo(1),
	Schema.isLessThanOrEqualTo(30)
).pipe(Schema.brand("WorldScoutRefreshRate"));
export type WorldScoutRefreshRate = Schema.Schema.Type<typeof WorldScoutRefreshRate>;

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

const SnapshotResponse = Schema.Union([
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

const FocusResponse = Schema.Union([
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

export class ObservatoryConnectionError extends Schema.TaggedErrorClass<ObservatoryConnectionError>()(
	"ObservatoryConnectionError",
	{
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}
) {}

export interface ObservatoryShape {
	readonly focus: (
		endpoint: string,
		actorId: ActorId,
		bringToFront: boolean
	) => Effect.Effect<WorldScoutFocusResult, ObservatoryConnectionError>;
	readonly snapshot: (
		endpoint: string
	) => Effect.Effect<WorldActorSnapshot, ObservatoryConnectionError>;
}

export class Observatory extends Context.Service<Observatory, ObservatoryShape>()(
	"@ue-shed/observatory/Observatory"
) {}

const objectPath = "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary";

function connectionError(
	operation: string,
	cause: RemoteControlClientError | unknown
): ObservatoryConnectionError {
	return new ObservatoryConnectionError({
		message: cause instanceof RemoteControlClientError ? cause.message : String(cause),
		operation,
		recovery:
			"Open an editor world with UEShedObservatory enabled, then retry the live world scan.",
		retrySafe: cause instanceof RemoteControlClientError ? cause.retrySafe : false
	});
}

export const ObservatoryLive = Layer.effect(
	Observatory,
	Effect.gen(function* () {
		const remote = yield* RemoteControlClient;

		const snapshot = Effect.fn("Observatory.snapshot")(function* (endpoint: string) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "GetActorSnapshot",
					objectPath,
					operation: "observatory.actor_snapshot",
					parameters: {}
				})
				.pipe(Effect.mapError((cause) => connectionError("actor_snapshot", cause)));
			const response = yield* Schema.decodeUnknownEffect(SnapshotResponse)(value).pipe(
				Effect.mapError((cause) => connectionError("actor_snapshot.decode", cause))
			);
			if (response.status === "failed") {
				return yield* Effect.fail(
					new ObservatoryConnectionError({
						message: response.message,
						operation: "actor_snapshot",
						recovery: response.recovery,
						retrySafe: true
					})
				);
			}
			return response.snapshot;
		});

		const focus = Effect.fn("Observatory.focus")(function* (
			endpoint: string,
			actorId: ActorId,
			bringToFront: boolean
		) {
			const value = yield* remote
				.request({
					endpoint,
					functionName: "FocusActor",
					objectPath,
					operation: "observatory.focus_actor",
					parameters: { ActorId: actorId, BringToFront: bringToFront }
				})
				.pipe(Effect.mapError((cause) => connectionError("focus_actor", cause)));
			return yield* Schema.decodeUnknownEffect(FocusResponse)(value).pipe(
				Effect.mapError((cause) => connectionError("focus_actor.decode", cause))
			);
		});

		return Observatory.of({ focus, snapshot });
	})
);

export const decodeWorldScoutResult = Schema.decodeUnknownEffect(WorldScoutResult);
export const decodeWorldScoutFocusResult = Schema.decodeUnknownEffect(WorldScoutFocusResult);

export interface SpatialPoint {
	readonly actor: ObservedActor;
	readonly xPercent: number;
	readonly yPercent: number;
}

export interface SpatialProjection {
	readonly center: { readonly x: number; readonly y: number };
	readonly height: number;
	readonly points: ReadonlyArray<SpatialPoint>;
	readonly width: number;
}

export function projectActors(
	actors: ReadonlyArray<ObservedActor>,
	paddingRatio = 0.08
): SpatialProjection {
	if (actors.length === 0) {
		return { center: { x: 0, y: 0 }, height: 1, points: [], width: 1 };
	}
	const minX = Math.min(...actors.map((actor) => actor.location.x - actor.bounds.extent.x));
	const maxX = Math.max(...actors.map((actor) => actor.location.x + actor.bounds.extent.x));
	const minY = Math.min(...actors.map((actor) => actor.location.y - actor.bounds.extent.y));
	const maxY = Math.max(...actors.map((actor) => actor.location.y + actor.bounds.extent.y));
	const rawWidth = Math.max(1, maxX - minX);
	const rawHeight = Math.max(1, maxY - minY);
	const padX = rawWidth * paddingRatio;
	const padY = rawHeight * paddingRatio;
	const width = rawWidth + padX * 2;
	const height = rawHeight + padY * 2;
	const size = Math.max(width, height);
	const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
	const left = center.x - size / 2;
	const top = center.y + size / 2;
	return {
		center,
		height,
		points: actors.map((actor) => ({
			actor,
			xPercent: ((actor.location.x - left) / size) * 100,
			yPercent: ((top - actor.location.y) / size) * 100
		})),
		width
	};
}

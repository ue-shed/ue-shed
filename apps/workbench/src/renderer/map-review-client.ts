import {
	decodeMapReviewApprovalResult,
	decodeMapReviewAuthoringResult,
	decodeMapReviewCandidatePreviewResult,
	decodeMapReviewResult,
	type MapReviewApprovalResult,
	type MapReviewAuthoringResult,
	type MapReviewCandidatePreviewResult,
	type MapReviewResult
} from "@ue-shed/cameras/review-contracts";
import {
	MapReviewClient,
	MapReviewClientError,
	type MapReviewClientShape
} from "@ue-shed/extension-camera-review/client";
import {
	decodeWorldScoutFocusResult,
	decodeWorldScoutResult,
	type ActorId,
	type WorldScoutRefreshRate,
	type WorldScoutResult
} from "@ue-shed/observatory";
import { Effect, Schedule, Schema, Stream } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";
const FixtureLaunchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.String,
		recovery: Schema.String,
		status: Schema.Literal("failed")
	})
]);
const decodeFixtureLaunchResult = Schema.decodeUnknownEffect(FixtureLaunchResult);

const loadWorldSnapshot = (): Effect.Effect<WorldScoutResult, MapReviewClientError> =>
	request({
		decode: decodeWorldScoutResult,
		invoke: () => window.ueShed.mapReview.worldSnapshot(),
		operation: "mapReview.worldSnapshot"
	});

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
	readonly operation: string;
}): Effect.Effect<A, MapReviewClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) => new MapReviewClientError({ cause, operation: args.operation, recovery })
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) => new MapReviewClientError({ cause, operation: args.operation, recovery })
		)
	);
}

export const mapReviewClient: MapReviewClientShape = MapReviewClient.of({
	connectWorld: Effect.fn("MapReviewClient.connectWorld")(function* () {
		const launch = yield* request({
			decode: decodeFixtureLaunchResult,
			invoke: () => window.ueShed.fixture.launchReview(),
			operation: "fixture.launchReview"
		});
		if (launch.status === "failed") {
			return {
				message: launch.message,
				recovery: launch.recovery,
				status: "unavailable" as const
			};
		}
		return yield* loadWorldSnapshot();
	}),
	focusActor: Effect.fn("MapReviewClient.focusActor")((actorId: ActorId, bringToFront: boolean) =>
		request({
			decode: decodeWorldScoutFocusResult,
			invoke: () => window.ueShed.mapReview.focusActor(actorId, bringToFront),
			operation: "mapReview.focusActor"
		})
	),
	worldSnapshots: (refreshRate: WorldScoutRefreshRate) =>
		Stream.fromEffectSchedule(
			Effect.catch(loadWorldSnapshot(), (cause) =>
				Effect.succeed({
					message: cause.message,
					recovery: cause.recovery,
					status: "unavailable" as const
				})
			),
			Schedule.spaced(`${1_000 / refreshRate} millis`)
		),
	approveCandidate: Effect.fn("MapReviewClient.approveCandidate")(
		(intent): Effect.Effect<MapReviewApprovalResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewApprovalResult,
				invoke: () => window.ueShed.mapReview.approveCandidate(intent),
				operation: "mapReview.approveCandidate"
			})
	),
	authorFromSelection: Effect.fn("MapReviewClient.authorFromSelection")(function* () {
		const launch = yield* request({
			decode: decodeFixtureLaunchResult,
			invoke: () => window.ueShed.fixture.launchReview(),
			operation: "fixture.launchReview"
		});
		if (launch.status === "failed") {
			return {
				error: { message: launch.message, recovery: launch.recovery },
				status: "failed"
			} satisfies MapReviewAuthoringResult;
		}
		return yield* request({
			decode: decodeMapReviewAuthoringResult,
			invoke: () => window.ueShed.mapReview.authorFromSelection(),
			operation: "mapReview.authorFromSelection"
		});
	}),
	capture: Effect.fn("MapReviewClient.capture")(
		(): Effect.Effect<MapReviewResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewResult,
				invoke: () => window.ueShed.mapReview.capture(),
				operation: "mapReview.capture"
			})
	),
	load: Effect.fn("MapReviewClient.load")(
		(): Effect.Effect<MapReviewResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewResult,
				invoke: () => window.ueShed.mapReview.load(),
				operation: "mapReview.load"
			})
	),
	previewCandidate: Effect.fn("MapReviewClient.previewCandidate")(
		(candidateId): Effect.Effect<MapReviewCandidatePreviewResult, MapReviewClientError> =>
			request({
				decode: decodeMapReviewCandidatePreviewResult,
				invoke: () => window.ueShed.mapReview.previewCandidate(candidateId),
				operation: "mapReview.previewCandidate"
			})
	)
});

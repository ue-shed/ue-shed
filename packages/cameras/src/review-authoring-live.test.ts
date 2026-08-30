import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ReviewAuthoring, ReviewAuthoringLive } from "./review-authoring-live.js";
import { ReviewSubjectActorGuid } from "./review-schema.js";

describe("ReviewAuthoring live subject inspection", () => {
	it("resolves a durable actor GUID without imposing an adapter-local timeout", async () => {
		const requests: Array<{
			readonly functionName: string;
			readonly parameters: unknown;
			readonly timeout: unknown;
		}> = [];
		const remote = makeRemoteControlClientTestLayer((request) => {
			requests.push({
				functionName: request.functionName,
				parameters: request.parameters,
				timeout: request.timeout
			});
			return Effect.succeed({
				actorGuid: "00000001-00000002-00000003-00000004",
				actorPath:
					"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.Actor_UAID_1",
				bounds: {
					center: { x: 0, y: 0, z: 100 },
					extent: { x: 50, y: 50, z: 100 },
					rotation: { pitch: 0, roll: 0, yaw: 0 }
				},
				contract: {
					name: "ue-shed-review-selection",
					version: { major: 1, minor: 1 }
				},
				displayName: "ReviewSubject",
				mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
				status: "selected"
			});
		});

		const result = await Effect.runPromise(
			Effect.flatMap(ReviewAuthoring, (authoring) =>
				authoring.inspectSubject({
					endpoint: "http://127.0.0.1:30001",
					subject: {
						actorGuid: ReviewSubjectActorGuid.make(
							"00000001-00000002-00000003-00000004"
						),
						kind: "actor_guid"
					}
				})
			).pipe(Effect.provide(ReviewAuthoringLive), Effect.provide(remote))
		);

		expect(result).toMatchObject({ actorGuid: "00000001-00000002-00000003-00000004" });
		expect(requests).toEqual([
			{
				functionName: "InspectReviewSubjectByGuid",
				parameters: { ActorGuid: "00000001-00000002-00000003-00000004" },
				timeout: undefined
			}
		]);
	});
});

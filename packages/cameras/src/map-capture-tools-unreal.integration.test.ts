import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	inspectUnrealProducer,
	RemoteControlClient,
	RemoteControlClientLive
} from "@ue-shed/unreal-connection";
import { inspectMapCaptureReadiness, inspectMapCaptureSelection } from "./map-capture-tools.js";
const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const mapPath = "/Game/Fixture/Cameras/L_CameraLoad";
describe.skipIf(!endpoint)("capture inspection against the fixture editor", () => {
	it("reports producer identity and actionable map mismatch without acquiring capture", async () => {
		const producer = await Effect.runPromise(
			inspectUnrealProducer(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
		);
		expect(producer.identity?.processId).toBeGreaterThan(0);
		expect(producer.identity?.plugins.some((p) => p.name === "UEShedCameras")).toBe(true);
		const mismatch = await Effect.runPromise(
			inspectMapCaptureReadiness(endpoint!, "/Game/Fixture/Missing").pipe(
				Effect.provide(RemoteControlClientLive)
			)
		);
		expect(mismatch.ready).toBe(false);
		expect(mismatch.blockers.some((b) => b.code === "map_mismatch")).toBe(true);
		const ready = await Effect.runPromise(
			inspectMapCaptureReadiness(endpoint!, mapPath).pipe(
				Effect.provide(RemoteControlClientLive)
			)
		);
		expect(ready.actualMapPath).toBe(mapPath);
		expect(ready.ready).toBe(true);
	});
	it("combines two selected actors and restores the previous editor selection", async () => {
		const stock = async (functionName: string, parameters: Schema.JsonObject) => {
			const response = await fetch(`${endpoint}/remote/object/call`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
					functionName,
					parameters,
					generateTransaction: false
				})
			});
			expect(response.ok).toBe(true);
			return response.json();
		};
		const original = Schema.decodeUnknownSync(
			Schema.Struct({ ReturnValue: Schema.Array(Schema.String) })
		)(await stock("GetSelectedLevelActors", {})).ReturnValue;
		const snapshot = await Effect.runPromise(
			Effect.gen(function* () {
				const client = yield* RemoteControlClient;
				return yield* client.request({
					endpoint: endpoint!,
					functionName: "GetActorSnapshot",
					objectPath: "/Script/UEShedObservatoryEditor.Default__UEShedObservatoryLibrary",
					parameters: {}
				});
			}).pipe(Effect.provide(RemoteControlClientLive))
		);
		const decoded = Schema.decodeUnknownSync(
			Schema.Struct({
				snapshot: Schema.Struct({
					mapPath: Schema.String,
					actors: Schema.Array(
						Schema.Struct({
							path: Schema.String,
							className: Schema.String,
							classPath: Schema.String,
							tags: Schema.Array(Schema.String),
							levelPackage: Schema.String
						})
					)
				})
			})
		)(snapshot);
		expect(decoded.snapshot.mapPath).toBe(mapPath);
		const actors = decoded.snapshot.actors
			.filter((a) => a.className === "StaticMeshActor")
			.slice(0, 2);
		expect(actors).toHaveLength(2);
		try {
			await stock("SetSelectedLevelActors", { ActorsToSelect: actors.map((a) => a.path) });
			const selection = await Effect.runPromise(
				inspectMapCaptureSelection(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(selection.status).toBe("ready");
			if (selection.status !== "ready") throw new Error(selection.message);
			expect(selection.actors.map((a) => a.path).sort()).toEqual(
				actors.map((a) => a.path).sort()
			);
			expect(selection.bounds.maxX).toBeGreaterThan(selection.bounds.minX);
			expect(selection.actors.every((a) => a.actorGuid !== undefined)).toBe(true);
		} finally {
			await stock("SetSelectedLevelActors", { ActorsToSelect: original });
		}
	});
});

import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { ActorId, Observatory, ObservatoryLive } from "./index.js";

it("reports actor selection separately when window activation is unavailable", async () => {
	const calls: string[] = [];
	const result = await Effect.runPromise(
		Effect.flatMap(Observatory, (service) =>
			service.focus("http://127.0.0.1:30010", ActorId.make("/Game/Fixture.Actor"), true)
		).pipe(
			Effect.provide(
				ObservatoryLive.pipe(
					Layer.provide(
						makeRemoteControlClientTestLayer((request) => {
							calls.push(request.functionName);
							if (request.functionName === "FocusActor") {
								expect(request.parameters.BringToFront).toBe(false);
								return Effect.succeed({
									status: "focused",
									actorId: "/Game/Fixture.Actor",
									authoringSubject: "selected"
								});
							}
							return Effect.succeed({
								schemaVersion: 1,
								producerKind: "unreal_editor",
								capabilities: []
							});
						})
					)
				)
			)
		)
	);
	expect(calls).toEqual(["FocusActor", "GetCapabilityManifest"]);
	expect(result.status).toBe("focused");
	if (result.status === "focused") expect(result.windowActivation?.status).toBe("unavailable");
});

it("does not request window activation for background follow updates", async () => {
	const calls: string[] = [];
	await Effect.runPromise(
		Effect.flatMap(Observatory, (service) =>
			service.focus("http://127.0.0.1:30010", ActorId.make("/Game/Fixture.Actor"), false)
		).pipe(
			Effect.provide(
				ObservatoryLive.pipe(
					Layer.provide(
						makeRemoteControlClientTestLayer((request) => {
							calls.push(request.functionName);
							return Effect.succeed({
								status: "focused",
								actorId: "/Game/Fixture.Actor",
								authoringSubject: "selected"
							});
						})
					)
				)
			)
		)
	);
	expect(calls).toEqual(["FocusActor"]);
});

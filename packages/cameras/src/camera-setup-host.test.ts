import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
	CameraBridgeError,
	CameraBridgeRequest,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import { CameraSetupIntent } from "./camera-setup-schema.js";
import { makeCameraSetupHost } from "./camera-setup-host.js";

const intent = Schema.decodeUnknownSync(CameraSetupIntent)({
	id: "setup-1",
	actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject",
	mapPath: "/Game/Fixture",
	name: "Four sides",
	layout: { kind: "orbit", count: 4, startDegrees: 0, spanDegrees: 360, orientation: "world" }
});

it.effect("does not recreate cameras after a lost setup acknowledgement", () =>
	Effect.gen(function* () {
		let creations = 0;
		let acknowledgements = 0;
		const host = yield* makeCameraSetupHost({
			create: (received) =>
				Effect.sync(() => {
					expect(received).toEqual(intent);
					creations++;
				})
		});
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.gen(function* () {
					if (request.operation !== "setup_poll")
						return yield* Effect.die("Unexpected operation");
					if (request.outcome && ++acknowledgements === 1)
						return yield* Effect.fail(
							new CameraBridgeError({
								code: "disconnected",
								message: "Reply lost",
								recovery: "Poll again"
							})
						);
					return {
						version: 1 as const,
						status: "setup" as const,
						connected: true,
						message: "",
						request: intent
					};
				})
		};
		yield* host.poll(bridge, "Fixture").pipe(Effect.flip);
		yield* host.poll(bridge, "Fixture");
		expect(creations).toBe(1);
		expect(acknowledgements).toBe(2);
	})
);

it.effect("reports creation failures to the native UI without replaying the mutation", () =>
	Effect.gen(function* () {
		let creations = 0;
		let error: string | null | undefined;
		const host = yield* makeCameraSetupHost({
			create: () =>
				Effect.gen(function* () {
					creations++;
					return yield* Effect.fail(new Error("The draft directory is read-only."));
				})
		});
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.sync(() => {
					if (request.operation === "setup_poll") error = request.outcome?.error;
					return {
						version: 1 as const,
						status: "setup" as const,
						connected: true,
						message: "",
						request: intent
					};
				})
		};
		yield* host.poll(bridge, "Fixture");
		yield* host.poll(bridge, "Fixture");
		expect(creations).toBe(1);
		expect(error).toBe("The draft directory is read-only.");
	})
);

it.effect("validates setup input before it crosses the bridge", () =>
	Effect.gen(function* () {
		const result = yield* Schema.decodeUnknownEffect(CameraBridgeRequest)({
			version: 1,
			operation: "setup_create",
			intent: { ...intent, layout: { ...intent.layout, count: 0 } }
		}).pipe(Effect.result);
		expect(result._tag).toBe("Failure");
	})
);

it.effect("releases only its own connection on graceful shutdown", () =>
	Effect.gen(function* () {
		const requests: CameraBridgeRequest[] = [];
		const host = yield* makeCameraSetupHost({ create: () => Effect.void });
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.sync(() => {
					requests.push(request);
					return {
						version: 1 as const,
						status: "setup" as const,
						connected: true,
						message: ""
					};
				})
		};
		yield* host.close();
		expect(requests).toHaveLength(0);
		yield* host.poll(bridge, "Fixture");
		yield* host.close();
		yield* host.close();
		expect(requests).toHaveLength(2);
		const poll = requests[0]!;
		expect(poll.operation).toBe("setup_poll");
		if (poll.operation !== "setup_poll") return;
		expect(requests[1]).toEqual({
			version: 1,
			operation: "setup_release",
			hostId: poll.hostId
		});
	})
);

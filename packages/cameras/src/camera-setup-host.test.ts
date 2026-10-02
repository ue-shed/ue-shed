import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
	CameraBridgeError,
	CameraBridgeRequest,
	CameraBridgeResponse,
	type CameraAuthoringBridge
} from "./camera-authoring-bridge.js";
import { fixtureArrangement } from "./camera-arrangement.test-support.js";
import {
	CameraSetupIntent,
	CameraSetupOpenIntent,
	CameraSetupSavedSet,
	CameraSetupState,
	cameraSetupSavedSet
} from "./camera-setup-schema.js";
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

const savedSet = Schema.decodeUnknownSync(CameraSetupSavedSet)({
	id: "arrangement-a",
	name: "Four sides",
	mapPath: "/Game/Fixture",
	subject: { kind: "actor_path", actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject" },
	cameras: 4
});
const openIntent = Schema.decodeUnknownSync(CameraSetupOpenIntent)({
	id: "open-1",
	arrangementId: "arrangement-a"
});
const setupState = (extra: Partial<typeof CameraSetupState.Type> = {}) => ({
	version: 1 as const,
	status: "setup" as const,
	connected: true,
	message: "",
	...extra
});

it.effect("reopens a listed set once, even after a lost acknowledgement", () =>
	Effect.gen(function* () {
		const opened: CameraSetupOpenIntent[] = [];
		const polls: CameraBridgeRequest[] = [];
		const host = yield* makeCameraSetupHost({
			create: () => Effect.die("A reopen request must not create a set"),
			open: (received) => Effect.sync(() => void opened.push(received)),
			sets: () => Effect.succeed([savedSet])
		});
		let acknowledgements = 0;
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.gen(function* () {
					polls.push(request);
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
					return setupState({ canOpen: true, sets: [savedSet], open: openIntent });
				})
		};
		yield* host.poll(bridge, "Fixture").pipe(Effect.flip);
		yield* host.poll(bridge, "Fixture");
		expect(opened).toEqual([openIntent]);
		expect(polls[0]).toMatchObject({ operation: "setup_poll", reopen: true, sets: [savedSet] });
		expect(polls.at(-1)).toMatchObject({ outcome: { id: "open-1", error: null } });
	})
);

it.effect("reports a failed reopen to the native panel without retrying it", () =>
	Effect.gen(function* () {
		let attempts = 0;
		let error: string | null | undefined;
		const host = yield* makeCameraSetupHost({
			create: () => Effect.void,
			open: () =>
				Effect.gen(function* () {
					attempts++;
					return yield* Effect.fail(new Error("The saved set belongs to another map."));
				}),
			sets: () => Effect.succeed([savedSet])
		});
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.sync(() => {
					if (request.operation === "setup_poll" && request.outcome)
						error = request.outcome.error;
					return setupState({ canOpen: true, open: openIntent });
				})
		};
		yield* host.poll(bridge, "Fixture");
		yield* host.poll(bridge, "Fixture");
		expect(attempts).toBe(1);
		expect(error).toBe("The saved set belongs to another map.");
	})
);

it.effect("lists saved sets at most every five seconds, and again after an outcome", () =>
	Effect.gen(function* () {
		let listings = 0;
		let pending: CameraSetupIntent | undefined;
		const host = yield* makeCameraSetupHost({
			create: () => Effect.void,
			open: () => Effect.void,
			sets: () =>
				Effect.sync(() => {
					listings++;
					return [savedSet];
				})
		});
		const bridge: CameraAuthoringBridge = {
			call: () => Effect.succeed(setupState(pending ? { request: pending } : {}))
		};
		yield* host.poll(bridge, "Fixture");
		yield* host.poll(bridge, "Fixture");
		expect(listings).toBe(1);
		yield* TestClock.adjust("5 seconds");
		yield* host.poll(bridge, "Fixture");
		expect(listings).toBe(2);
		pending = intent;
		yield* host.poll(bridge, "Fixture");
		expect(listings).toBe(3);
	})
);

it.effect("keeps polling with the previous listing when listing fails", () =>
	Effect.gen(function* () {
		let fail = false;
		const sent: unknown[] = [];
		const host = yield* makeCameraSetupHost({
			create: () => Effect.void,
			open: () => Effect.void,
			sets: () =>
				fail ? Effect.fail(new Error("Disk unavailable")) : Effect.succeed([savedSet])
		});
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.sync(() => {
					if (request.operation === "setup_poll") sent.push(request.sets);
					return setupState();
				})
		};
		yield* host.poll(bridge, "Fixture");
		fail = true;
		yield* TestClock.adjust("5 seconds");
		yield* host.poll(bridge, "Fixture");
		expect(sent).toEqual([[savedSet], [savedSet]]);
	})
);

it.effect("hosts without reopening keep the original poll and ignore open requests", () =>
	Effect.gen(function* () {
		const polls: CameraBridgeRequest[] = [];
		const host = yield* makeCameraSetupHost({ create: () => Effect.die("Nothing to create") });
		const bridge: CameraAuthoringBridge = {
			call: (request) =>
				Effect.sync(() => {
					polls.push(request);
					return setupState({ open: openIntent });
				})
		};
		yield* host.poll(bridge, "Fixture");
		expect(polls).toHaveLength(1);
		expect(polls[0]).not.toHaveProperty("reopen");
		expect(polls[0]).not.toHaveProperty("sets");
	})
);

it.effect("keeps the setup wire contract backward compatible", () =>
	Effect.gen(function* () {
		const strict = { onExcessProperty: "error" } as const;
		// Older plugins reply without reopen fields, and older hosts poll without them.
		yield* Schema.decodeUnknownEffect(CameraBridgeResponse)(setupState(), strict);
		yield* Schema.decodeUnknownEffect(CameraBridgeRequest)(
			{ version: 1, operation: "setup_poll", hostId: "host-1", projectName: "Fixture" },
			strict
		);
		yield* Schema.decodeUnknownEffect(CameraBridgeResponse)(
			setupState({
				canOpen: true,
				sets: [savedSet],
				open: openIntent,
				selection: {
					actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject",
					actorGuid: "0123456789ABCDEF0123456789ABCDEF",
					displayName: "Subject",
					mapPath: "/Game/Fixture"
				}
			}),
			strict
		);
		yield* Schema.decodeUnknownEffect(CameraBridgeRequest)(
			{ version: 1, operation: "setup_open", intent: openIntent },
			strict
		);
		const tooMany = yield* Schema.decodeUnknownEffect(CameraBridgeRequest)({
			version: 1,
			operation: "setup_poll",
			hostId: "host-1",
			projectName: "Fixture",
			reopen: true,
			sets: Array.from({ length: 257 }, () => savedSet)
		}).pipe(Effect.result);
		expect(tooMany._tag).toBe("Failure");
	})
);

it("lists a saved arrangement by its subject, map and camera count", () => {
	const arrangement = fixtureArrangement();
	expect(cameraSetupSavedSet(arrangement)).toEqual({
		id: arrangement.id,
		name: "Camera set",
		mapPath: "/Game/Fixture",
		subject: arrangement.subject,
		cameras: 6
	});
	expect(cameraSetupSavedSet({ ...arrangement, displayName: "Gate views" }).name).toBe(
		"Gate views"
	);
});

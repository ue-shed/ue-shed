import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import {
	RemoteControlClientError,
	makeRemoteControlClientTestLayer,
	type RemoteControlClientApi
} from "@ue-shed/unreal-connection";
import { EditorWorldControl, EditorWorldControlLive } from "./editor-world-control.js";

const endpoint = "http://localhost:30010";
const request = { endpoint, operationId: "open-map", targetMapPath: "/Game/Fixture/Target" };
const wire = {
	contract: { name: "unreal-editor-world-control", version: { major: 1, minor: 0 } },
	operationId: request.operationId,
	targetMapPath: request.targetMapPath
};
const snapshot = {
	dirtyWorldPackages: [],
	playSessionActive: false,
	mapPath: request.targetMapPath
};
const result = { ...wire, outcome: "opened", before: snapshot, after: snapshot };
const manifest = {
	capabilities: [
		"editor.world-control.v1",
		"editor.world-control.async.v1",
		"editor.world-state.v1"
	],
	producerKind: "unreal_editor",
	schemaVersion: 1,
	worldControlObjectPath: "/Script/Fixture.WorldControl"
};
const transportFailure = (functionName: string) =>
	new RemoteControlClientError({
		endpoint,
		functionName,
		operation: "test",
		message: "Editor game thread is loading",
		retrySafe: true
	});
const layer = (handler: RemoteControlClientApi["request"]) =>
	EditorWorldControlLive.pipe(Layer.provide(makeRemoteControlClientTestLayer(handler)));

it.effect(
	"recovers a lost begin acknowledgement and long loading without replaying the mutation",
	() =>
		Effect.gen(function* () {
			const polled = yield* Deferred.make<void>();
			const loaded = yield* Ref.make(false);
			const calls: string[] = [];
			const testLayer = layer((call) =>
				Effect.gen(function* () {
					calls.push(call.functionName);
					if (call.functionName === "GetCapabilityManifest") return manifest;
					if (call.functionName === "BeginOpenMap")
						return yield* transportFailure(call.functionName);
					yield* Deferred.succeed(polled, undefined);
					if (!(yield* Ref.get(loaded)))
						return yield* transportFailure(call.functionName);
					return { ...wire, status: "completed", result };
				})
			);
			const fiber = yield* Effect.flatMap(EditorWorldControl, (control) =>
				control.open(request)
			).pipe(Effect.provide(testLayer), Effect.forkChild);
			yield* Deferred.await(polled);
			yield* TestClock.adjust("1 minute");
			yield* Ref.set(loaded, true);
			yield* TestClock.adjust("2 seconds");
			expect((yield* Fiber.join(fiber)).outcome).toBe("opened");
			expect(calls.filter((call) => call === "BeginOpenMap")).toHaveLength(1);
			expect(calls.filter((call) => call === "GetOpenMapStatus").length).toBeGreaterThan(1);
			expect(calls).not.toContain("OpenMap");
		})
);

it.effect("a wait deadline is indeterminate, not cancellation or permission to replay", () =>
	Effect.gen(function* () {
		const polled = yield* Deferred.make<void>();
		const testLayer = layer((call) =>
			call.functionName === "GetCapabilityManifest"
				? Effect.succeed(manifest)
				: Deferred.succeed(polled, undefined).pipe(
						Effect.as({ ...wire, status: "pending" })
					)
		);
		const fiber = yield* Effect.flatMap(EditorWorldControl, (control) =>
			control.open({ ...request, waitTimeout: "12 seconds" })
		).pipe(Effect.flip, Effect.provide(testLayer), Effect.forkChild);
		yield* Deferred.await(polled);
		yield* TestClock.adjust("13 seconds");
		const error = yield* Fiber.join(fiber);
		expect(error.code).toBe("operation_indeterminate");
		expect(error.retrySafe).toBe(false);
		expect(error.message).toContain("may still be running");
	})
);

it.effect("an unknown operation after an editor restart stops safely", () =>
	Effect.gen(function* () {
		let begins = 0;
		const testLayer = layer((call) => {
			if (call.functionName === "GetCapabilityManifest") return Effect.succeed(manifest);
			if (call.functionName === "BeginOpenMap") {
				begins++;
				return Effect.fail(transportFailure(call.functionName));
			}
			return Effect.succeed({
				...wire,
				status: "unavailable",
				code: "unknown_operation",
				message: "Editor restarted",
				recovery: "Check the current map."
			});
		});
		const error = yield* Effect.flatMap(EditorWorldControl, (control) =>
			control.open(request)
		).pipe(Effect.flip, Effect.provide(testLayer));
		expect(error.retrySafe).toBe(false);
		expect(begins).toBe(1);
	})
);

it.effect("interruption stops polling without issuing editor cancellation or another open", () =>
	Effect.gen(function* () {
		const polled = yield* Deferred.make<void>();
		const calls: string[] = [];
		const testLayer = layer((call) => {
			calls.push(call.functionName);
			return call.functionName === "GetCapabilityManifest"
				? Effect.succeed(manifest)
				: Deferred.succeed(polled, undefined).pipe(
						Effect.as({ ...wire, status: "pending" })
					);
		});
		const fiber = yield* Effect.flatMap(EditorWorldControl, (control) =>
			control.open(request)
		).pipe(Effect.provide(testLayer), Effect.forkChild);
		yield* Deferred.await(polled);
		yield* Fiber.interrupt(fiber);
		const count = calls.length;
		yield* TestClock.adjust("1 minute");
		expect(calls).toHaveLength(count);
		expect(calls.filter((call) => call === "BeginOpenMap")).toHaveLength(1);
	})
);

it.effect("reads current editor state and rejects unrelated completion identities", () =>
	Effect.gen(function* () {
		const testLayer = layer((call) =>
			Effect.succeed(
				call.functionName === "GetCapabilityManifest"
					? manifest
					: call.functionName === "GetWorldState"
						? { contract: wire.contract, projectName: "Fixture", snapshot }
						: {
								...wire,
								status: "completed",
								result: { ...result, operationId: "another-operation" }
							}
			)
		);
		yield* Effect.gen(function* () {
			const control = yield* EditorWorldControl;
			expect((yield* control.snapshot(endpoint)).snapshot.mapPath).toBe(
				request.targetMapPath
			);
			expect((yield* control.open(request).pipe(Effect.flip)).code).toBe(
				"operation_indeterminate"
			);
		}).pipe(Effect.provide(testLayer));
	})
);

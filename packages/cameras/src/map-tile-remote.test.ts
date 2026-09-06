import { readFileSync } from "node:fs";
import { it } from "@effect/vitest";
import type { RemoteControlClientApi, RemoteControlRequest } from "@ue-shed/unreal-connection";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeMapTileCaptureRemotePort } from "./map-tile-capture.js";
import { MapTileCaptureRequest } from "./map-tile-schema.js";

const fixture = Schema.decodeUnknownSync(MapTileCaptureRequest)(
	JSON.parse(
		readFileSync(
			new URL(
				"../../protocol/contracts/cameras/map-tile/v1/fixtures/capture-request-valid.json",
				import.meta.url
			),
			"utf8"
		)
	)
);
const request = MapTileCaptureRequest.make({ ...fixture, captureBackend: "lit_camera_tiles" });
const json = Schema.decodeUnknownSync(Schema.Json);
const terminal = json({
	state: "finished",
	response: {
		actualMapPath: request.expectedMapPath,
		contract: request.contract,
		correlationId: request.correlationId,
		operationId: request.operationId,
		dirtyState: { before: false, after: false },
		durationMs: 1,
		results: [],
		status: "completed",
		tileCounts: { requested: 0, succeeded: 0, failed: 0 }
	}
});

it.effect("starts once, polls with a bounded cadence, and decodes terminal output", () =>
	Effect.gen(function* () {
		const firstPoll = yield* Deferred.make<void>();
		const calls: RemoteControlRequest[] = [];
		let polls = 0;
		const client: RemoteControlClientApi = {
			request: (call) =>
				Effect.gen(function* () {
					calls.push(call);
					if (call.functionName === "EndMapTileCapture") return json({ released: true });
					if (call.functionName === "PollMapTileCapture") {
						if (++polls === 2) return terminal;
						yield* Deferred.succeed(firstPoll, undefined);
					}
					return json({
						state: "running",
						operationId: request.operationId,
						completedTiles: 0
					});
				})
		};
		const port = makeMapTileCaptureRemotePort(client, "http://editor");
		const fiber = yield* port.capture(request).pipe(Effect.forkScoped);
		yield* Deferred.await(firstPoll);
		yield* TestClock.adjust("200 millis");
		expect((yield* Fiber.join(fiber)).status).toBe("completed");
		yield* port.release?.(request.runId) ?? Effect.void;
		expect(calls.map((call) => call.functionName)).toEqual([
			"BeginMapTileCapture",
			"PollMapTileCapture",
			"PollMapTileCapture",
			"EndMapTileCapture"
		]);
		expect(calls[1]?.parameters).toEqual({
			RunId: request.runId,
			OperationId: request.operationId
		});
	})
);

it.effect("rejects another operation's running status without polling it", () =>
	Effect.gen(function* () {
		let calls = 0;
		const client: RemoteControlClientApi = {
			request: () =>
				Effect.sync(() => {
					calls++;
					return json({
						state: "running",
						operationId: "another-operation",
						completedTiles: 0
					});
				})
		};
		const error = yield* makeMapTileCaptureRemotePort(client, "http://editor")
			.capture(request)
			.pipe(Effect.flip);
		expect(String(error)).toContain("different operation");
		expect(calls).toBe(1);
	})
);

it.effect("keeps the explicitly selected legacy backend synchronous", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const response = Schema.decodeUnknownSync(Schema.Struct({ response: Schema.Json }))(
			terminal
		).response;
		const client: RemoteControlClientApi = {
			request: (call) =>
				Effect.sync(() => {
					calls.push(call.functionName);
					return response;
				})
		};
		yield* makeMapTileCaptureRemotePort(client, "http://editor").capture(fixture);
		expect(calls).toEqual(["CaptureMapTiles"]);
	})
);

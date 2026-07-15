import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	connectUnrealAuthoring,
	RemoteControlClientLive,
	UnrealCapabilityError,
	UnrealConnectionError
} from "./index.js";

const runRemoteControl = <A, E>(
	effect: Effect.Effect<A, E, import("./index.js").RemoteControlClient>
) => Effect.runPromise(effect.pipe(Effect.provide(RemoteControlClientLive)));

let server: Server | undefined;

afterEach(async () => {
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	server = undefined;
});

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

function resultJson(value: unknown): string {
	return JSON.stringify({ ResultJson: JSON.stringify(value) });
}

describe("Remote Control authoring adapter", () => {
	it("negotiates the companion and validates a live snapshot over HTTP", async () => {
		const endpoint = await listen((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => (body += chunk));
			request.on("end", () => {
				const call = JSON.parse(body) as { functionName: string };
				response.setHeader("content-type", "application/json");
				const result =
					call.functionName === "GetCapabilityManifest"
						? resultJson({
								authoringLimits: {
									maxCommands: 1024,
									maxPayloadBytes: 1048576,
									maxTables: 16
								},
								authoringObjectPath:
									"/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
								capabilities: [
									"authoring.snapshot.v2",
									"authoring.table-list.v1",
									"authoring.apply.v1",
									"authoring.apply-result.v1",
									"authoring.save.v1"
								],
								producerKind: "unreal_editor",
								schemaVersion: 1
							})
						: call.functionName === "ListTableObjectPaths"
							? resultJson({
									contract: {
										name: "unreal-authoring-table-list",
										version: { major: 1, minor: 0 }
									},
									objectPaths: ["/Game/Fixture/DT_Test.DT_Test"]
								})
							: resultJson({
									authority: {
										kind: "live_editor",
										producerId: "producer",
										sessionId: "session"
									},
									completeness: "complete",
									contract: {
										name: "unreal-authoring",
										version: { major: 2, minor: 0 }
									},
									diagnostics: [],
									fingerprint: {
										algorithm: "sha256",
										status: "available",
										value: "sha256-v1:test",
										version: 1
									},
									producer: { name: "UEShedAuthoring", version: "1" },
									table: {
										kind: "data_table",
										objectPath: "/Game/Fixture/DT_Test.DT_Test",
										packageName: "/Game/Fixture/DT_Test",
										parentTables: [],
										rows: [],
										rowStruct: "/Script/Fixture.Row",
										schema: {
											fields: [],
											source: "live_reflection",
											status: "available"
										}
									}
								});
				response.end(result);
			});
		});

		const connection = await runRemoteControl(connectUnrealAuthoring(endpoint));
		expect(await Effect.runPromise(connection.listTableObjectPaths())).toEqual([
			"/Game/Fixture/DT_Test.DT_Test"
		]);
		const snapshot = await Effect.runPromise(
			connection.getTableSnapshot("/Game/Fixture/DT_Test.DT_Test")
		);
		expect(snapshot.authority.kind).toBe("live_editor");
	});

	it("returns a typed retryable error for an unavailable Remote Control server", async () => {
		const endpoint = await listen((_request, response) => {
			response.statusCode = 503;
			response.end("unavailable");
		});
		const error = await runRemoteControl(Effect.flip(connectUnrealAuthoring(endpoint)));
		expect(error).toBeInstanceOf(UnrealConnectionError);
		if (error instanceof UnrealConnectionError) {
			expect(error.retrySafe).toBe(true);
			expect(error.status).toBe(503);
		}
	});

	it("rejects a manifest that advertises authoring without an endpoint", async () => {
		const endpoint = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				resultJson({
					authoringLimits: {
						maxCommands: 1024,
						maxPayloadBytes: 1048576,
						maxTables: 16
					},
					capabilities: [
						"authoring.snapshot.v2",
						"authoring.table-list.v1",
						"authoring.apply.v1",
						"authoring.apply-result.v1",
						"authoring.save.v1"
					],
					producerKind: "unreal_editor",
					schemaVersion: 1
				})
			);
		});
		const error = await runRemoteControl(Effect.flip(connectUnrealAuthoring(endpoint)));
		expect(error).toBeInstanceOf(UnrealCapabilityError);
		if (error instanceof UnrealCapabilityError) {
			expect(error.capability).toBe("authoring.endpoint.v1");
		}
	});
});

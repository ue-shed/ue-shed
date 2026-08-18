import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	connectUnrealAuthoring,
	locateUnrealAsset,
	makeRemoteControlClient,
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

describe("Remote Control asset navigation adapter", () => {
	it("negotiates capability and locates a saved asset in Unreal", async () => {
		const calls: Array<{
			readonly functionName: string;
			readonly objectPath: string;
			readonly parameters: Schema.JsonObject;
		}> = [];
		const endpoint = await listen((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => (body += chunk));
			request.on("end", () => {
				// SAFETY: the client serializes this private request shape before the test server reads it.
				const call = JSON.parse(body) as (typeof calls)[number];
				calls.push(call);
				response.setHeader("content-type", "application/json");
				response.end(
					call.functionName === "GetCapabilityManifest"
						? resultJson({
								assetNavigationObjectPath:
									"/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary",
								capabilities: ["editor.asset-navigation.v1"],
								producerKind: "unreal_editor",
								schemaVersion: 1
							})
						: resultJson({
								contract: {
									name: "unreal-editor-asset-navigation",
									version: { major: 1, minor: 0 }
								},
								objectPath: "/Game/Text/ST_Game.ST_Game",
								status: "located"
							})
				);
			});
		});

		const result = await runRemoteControl(
			locateUnrealAsset({
				bringToFront: true,
				endpoint,
				objectPath: "/Game/Text/ST_Game.ST_Game"
			})
		);

		expect(result.status).toBe("located");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			functionName: "LocateAsset",
			generateTransaction: false,
			objectPath: "/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary",
			parameters: {
				BringToFront: true,
				ObjectPath: "/Game/Text/ST_Game.ST_Game"
			}
		});
	});

	it("rejects an editor without the navigation capability", async () => {
		const endpoint = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(
				resultJson({ capabilities: [], producerKind: "unreal_editor", schemaVersion: 1 })
			);
		});

		const error = await runRemoteControl(
			Effect.flip(
				locateUnrealAsset({
					bringToFront: true,
					endpoint,
					objectPath: "/Game/Text/ST_Game.ST_Game"
				})
			)
		);
		expect(error).toBeInstanceOf(UnrealCapabilityError);
		if (error instanceof UnrealCapabilityError) {
			expect(error.capability).toBe("editor.asset-navigation.v1");
		}
	});
});

async function listen(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> {
	server = createServer(handler);
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!(address instanceof Object)) throw new Error("test server has no TCP address");
	return `http://127.0.0.1:${address.port}`;
}

function resultJson<Value>(value: Value): string {
	return JSON.stringify({ ResultJson: JSON.stringify(value) });
}

describe("Remote Control authoring adapter", () => {
	it("negotiates the companion and validates a live snapshot over HTTP", async () => {
		const calls: Array<{
			readonly body: {
				readonly functionName: string;
				readonly generateTransaction: boolean;
				readonly objectPath: string;
				readonly parameters: Schema.JsonObject;
			};
			readonly method: string | undefined;
			readonly url: string | undefined;
		}> = [];
		const endpoint = await listen((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => (body += chunk));
			request.on("end", () => {
				// SAFETY: the client serializes this private request body before the test server reads it.
				const call = JSON.parse(body) as (typeof calls)[number]["body"];
				calls.push({ body: call, method: request.method, url: request.url });
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
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.method).toBe("PUT");
			expect(call.url).toBe("/remote/object/call");
			expect(call.body.generateTransaction).toBe(false);
		}
	});

	it("rejects a single UFUNCTION output that is not the companion ResultJson envelope", async () => {
		const endpoint = await listen((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ UnexpectedJson: "{}" }));
		});
		const client = makeRemoteControlClient({ defaultTimeout: "1 second" });
		const error = await Effect.runPromise(
			Effect.flip(
				client.request({
					endpoint,
					functionName: "GetCapabilityManifest",
					objectPath: "/Script/UEShedCore.Default__UEShedCoreLibrary",
					parameters: {}
				})
			)
		);

		expect(error.message).toContain("Invalid Remote Control envelope");
		expect(error.retrySafe).toBe(false);
	});

	it("does not retry Apply or Save after a transport failure", async () => {
		const calls: string[] = [];
		const endpoint = await listen((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => (body += chunk));
			request.on("end", () => {
				// SAFETY: every Remote Control request body includes its serialized functionName.
				calls.push((JSON.parse(body) as { functionName: string }).functionName);
				response.statusCode = 503;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ message: "unavailable" }));
			});
		});
		const client = makeRemoteControlClient({ defaultTimeout: "1 second" });

		for (const functionName of ["Apply", "Save"] as const) {
			const error = await Effect.runPromise(
				Effect.flip(
					client.request({
						endpoint,
						functionName,
						objectPath: "/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
						operation: `authoring.${functionName.toLowerCase()}`,
						parameters: { RequestJson: "{}" }
					})
				)
			);
			expect(error.retrySafe).toBe(true);
			expect(error.status).toBe(503);
		}

		expect(calls).toEqual(["Apply", "Save"]);
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

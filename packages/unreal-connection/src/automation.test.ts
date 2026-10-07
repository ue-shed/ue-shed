import { createServer, type Server } from "node:http";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	connectUnrealAutomation,
	findUnrealActorsReferencingRow,
	RemoteControlClient,
	RemoteControlClientLive,
	UnrealCapabilityError,
	UnrealConnectionError
} from "./index.js";

const Call = Schema.Struct({
	functionName: Schema.String,
	objectPath: Schema.String,
	parameters: Schema.Record(Schema.String, Schema.Json),
	generateTransaction: Schema.Boolean
});
type Call = typeof Call.Type;
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve()))
					)
			)
	);
});

const run = <A, E>(effect: Effect.Effect<A, E, RemoteControlClient>) =>
	Effect.runPromise(effect.pipe(Effect.provide(RemoteControlClientLive)));

async function listen(reply: (call: Call) => Schema.Json): Promise<string> {
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			const call = Schema.decodeUnknownSync(Call)(JSON.parse(body));
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ ResultJson: JSON.stringify(reply(call)) }));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!(address instanceof Object)) throw new Error("missing test server address");
	return `http://127.0.0.1:${address.port}`;
}

const version = { major: 1, minor: 0 } as const;
const worldObjectPath = "/Engine/Transient.SelectedWorld";
const playerControllerObjectPath = worldObjectPath + ":PersistentLevel.Controller";
const actionObjectPath = "/Game/Input/IA_Camera.IA_Camera";
const automationPath = "/Script/UEShedAutomation.Default__UEShedAutomationLibrary";
const authoringPath = "/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary";
const input = {
	contract: { name: "unreal-automation-input", version },
	worldObjectPath,
	playerControllerObjectPath,
	actionObjectPath,
	value: { kind: "axis2d", x: 0.25, y: -0.5 }
} as const;
const referenceRequest = {
	contract: { name: "unreal-authoring-actor-references", version },
	worldObjectPath,
	tableObjectPath: "/Game/Data/DT_Items.DT_Items",
	rowName: "Item",
	maxActors: 1000,
	maxResults: 10
} as const;
const manifest = {
	producerKind: "unreal_runtime",
	schemaVersion: 1,
	automationObjectPath: automationPath,
	capabilities: ["automation.players.v1", "automation.input.v1", "automation.csv.v1"]
};
const inputResult = {
	contract: input.contract,
	status: "injected",
	worldObjectPath,
	playerControllerObjectPath,
	actionObjectPath,
	errors: []
};

describe("optional Unreal automation over real HTTP", () => {
	it("negotiates runtime capabilities and delivers one explicitly targeted input call", async () => {
		const calls: Call[] = [];
		const endpoint = await listen((call) => {
			calls.push(call);
			return call.functionName === "GetCapabilityManifest" ? manifest : inputResult;
		});
		const connection = await run(connectUnrealAutomation(endpoint + "/"));
		const result = await run(connection.injectInput(input));
		expect(result.status).toBe("injected");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			functionName: "InjectInput",
			objectPath: automationPath,
			generateTransaction: false,
			parameters: { RequestJson: JSON.stringify(input) }
		});
	});

	it("keeps unavailable optional capabilities typed and never dispatches them", async () => {
		const calls: Call[] = [];
		const endpoint = await listen((call) => {
			calls.push(call);
			return { ...manifest, capabilities: ["automation.players.v1"] };
		});
		const connection = await run(connectUnrealAutomation(endpoint));
		const error = await run(Effect.flip(connection.injectInput(input)));
		expect(error).toBeInstanceOf(UnrealCapabilityError);
		expect(calls).toHaveLength(1);
	});

	it("rejects target substitution from the producer", async () => {
		const endpoint = await listen((call) =>
			call.functionName === "GetCapabilityManifest"
				? manifest
				: { ...inputResult, worldObjectPath: "/Engine/Transient.OtherWorld" }
		);
		const connection = await run(connectUnrealAutomation(endpoint));
		const error = await run(Effect.flip(connection.injectInput(input)));
		expect(error).toBeInstanceOf(UnrealConnectionError);
		if (error instanceof UnrealConnectionError) expect(error.retrySafe).toBe(false);
	});

	it("rejects oversized UTF-8 input requests before mutation dispatch", async () => {
		const calls: Call[] = [];
		const endpoint = await listen((call) => {
			calls.push(call);
			return manifest;
		});
		const connection = await run(connectUnrealAutomation(endpoint));
		const path = "/" + "界".repeat(2047);
		const error = await run(
			Effect.flip(
				connection.injectInput({
					...input,
					worldObjectPath: path,
					playerControllerObjectPath: path,
					actionObjectPath: path
				})
			)
		);
		expect(error).toBeInstanceOf(UnrealConnectionError);
		if (error instanceof UnrealConnectionError) expect(error.message).toContain("16384 UTF-8");
		expect(calls).toHaveLength(1);
	});

	it("never marks an indeterminate input mutation replay-safe", async () => {
		let mutationCalls = 0;
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				const call = Schema.decodeUnknownSync(Call)(JSON.parse(body));
				if (call.functionName !== "GetCapabilityManifest") {
					mutationCalls++;
					response.writeHead(503);
					response.end("outcome unknown");
				} else {
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ ResultJson: JSON.stringify(manifest) }));
				}
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!(address instanceof Object)) throw new Error("missing server address");
		const connection = await run(connectUnrealAutomation(`http://127.0.0.1:${address.port}`));
		const error = await run(Effect.flip(connection.injectInput(input)));
		expect(error).toBeInstanceOf(UnrealConnectionError);
		if (error instanceof UnrealConnectionError) expect(error.retrySafe).toBe(false);
		expect(mutationCalls).toBe(1);
	});

	it("returns player identities and the asynchronous profiler state", async () => {
		const endpoint = await listen((call) => {
			if (call.functionName === "GetCapabilityManifest") return manifest;
			if (call.functionName === "ListPlayers")
				return {
					contract: { name: "unreal-automation-players", version },
					status: "ok",
					worldObjectPath,
					players: [
						{
							controllerObjectPath: playerControllerObjectPath,
							playerInputObjectPath: null,
							localPlayerIndex: 0
						}
					],
					errors: []
				};
			return {
				contract: { name: "unreal-automation-csv", version },
				status: "ok",
				state: "stopping",
				outputDirectory: "/Project/Saved/Profiling/CSV/UEShed",
				outputFile: null,
				errors: []
			};
		});
		const connection = await run(connectUnrealAutomation(endpoint));
		expect(
			(
				await run(
					connection.listPlayers({
						contract: { name: "unreal-automation-players", version },
						worldObjectPath
					})
				)
			).players[0]?.controllerObjectPath
		).toBe(playerControllerObjectPath);
		expect(
			(
				await run(
					connection.csvProfiler({
						contract: { name: "unreal-automation-csv", version },
						command: "stop"
					})
				)
			).state
		).toBe("stopping");
	});
});

describe("bounded actor-reference lookup", () => {
	it("does not require editing capabilities and preserves partial results", async () => {
		const endpoint = await listen((call) =>
			call.functionName === "GetCapabilityManifest"
				? {
						producerKind: "unreal_editor",
						schemaVersion: 1,
						authoringObjectPath: authoringPath,
						capabilities: ["authoring.actor-references.v1"]
					}
				: {
						contract: referenceRequest.contract,
						status: "ok",
						worldObjectPath,
						tableObjectPath: referenceRequest.tableObjectPath,
						rowName: referenceRequest.rowName,
						actorObjectPaths: [playerControllerObjectPath],
						scannedActorCount: 1000,
						isComplete: false,
						errors: []
					}
		);
		const result = await run(
			findUnrealActorsReferencingRow({
				endpoint,
				request: referenceRequest
			})
		);
		expect(result.isComplete).toBe(false);
		expect(result.actorObjectPaths).toEqual([playerControllerObjectPath]);
	});

	it("rejects out-of-limit responses and invalid requests before dispatch", async () => {
		const calls: Call[] = [];
		const endpoint = await listen((call) => {
			calls.push(call);
			return call.functionName === "GetCapabilityManifest"
				? {
						producerKind: "unreal_editor",
						schemaVersion: 1,
						authoringObjectPath: authoringPath,
						capabilities: ["authoring.actor-references.v1"]
					}
				: {
						contract: referenceRequest.contract,
						status: "ok",
						worldObjectPath,
						tableObjectPath: referenceRequest.tableObjectPath,
						rowName: referenceRequest.rowName,
						actorObjectPaths: [],
						scannedActorCount: 1001,
						isComplete: true,
						errors: []
					};
		});
		const error = await run(
			Effect.flip(
				findUnrealActorsReferencingRow({
					endpoint,
					request: referenceRequest
				})
			)
		);
		expect(error).toBeInstanceOf(UnrealConnectionError);
		const invalid = await run(
			Effect.flip(
				findUnrealActorsReferencingRow({
					endpoint,
					request: { ...referenceRequest, maxActors: 0 }
				})
			)
		);
		expect(invalid).toBeInstanceOf(UnrealConnectionError);
		expect(calls).toHaveLength(2);
	});
});

import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { WorldRequest, worldPreparationContract } from "@ue-shed/world";
import { expect, it } from "vitest";
import { runCliAsync, parseRecord } from "./cli-process.test-support.js";

it("negotiates world preparation and prints native evidence through the CLI process", async () => {
	const calls: string[] = [];
	const world = {
		worldId: "world",
		mapPath: "/Game/Test",
		projectName: "Test",
		partitioned: true,
		streamingEnabled: true
	};
	const server = createServer(async (request, response) => {
		try {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const call = Schema.decodeUnknownSync(
				Schema.Struct({
					functionName: Schema.String,
					parameters: Schema.Record(Schema.String, Schema.Json)
				})
			)(JSON.parse(body));
			calls.push(call.functionName);
			let result: Schema.Json;
			if (call.functionName === "GetCapabilityManifest")
				result = {
					schemaVersion: 1,
					producerKind: "unreal_editor",
					capabilities: ["world.preparation.v1"],
					worldPreparationObjectPath:
						"/Script/UEShedWorldEditor.Default__UEShedWorldLibrary"
				};
			else {
				const operation = Schema.decodeUnknownSync(WorldRequest)(
					JSON.parse(String(call.parameters.RequestJson))
				);
				expect(operation.action).toBe("describe");
				result = { status: "described", world };
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ResultJson: JSON.stringify(result) }));
		} catch (error) {
			response.writeHead(400);
			response.end(String(error));
		}
	});
	const root = await mkdtemp(join(tmpdir(), "ue-shed-world-cli-"));
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
			server.address()
		);
		const path = join(root, "describe.json");
		await writeFile(
			path,
			JSON.stringify({ contract: worldPreparationContract, action: "describe" })
		);
		const result = await runCliAsync([
			"world",
			"request",
			path,
			"--endpoint",
			`http://127.0.0.1:${address.port}`
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(parseRecord(result.stdout)).toEqual({ status: "described", world });
		expect(calls).toEqual(["GetCapabilityManifest", "ExecuteWorldPreparation"]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}, 20000);

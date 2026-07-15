import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { describe, expect, it } from "vitest";
import { readLiveTexturePreview } from "./live.js";

const objectPath = "/Game/Fixture/Audits/Textures/T_Audit_Defaults_256.T_Audit_Defaults_256";

async function withRemoteControl(
	handle: (request: IncomingMessage, response: ServerResponse) => void,
	run: (endpoint: string) => Promise<void>
) {
	const server = createServer(handle);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address");
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((cause) => (cause ? rejectClose(cause) : resolveClose()))
		);
	}
}

function sendResult(response: ServerResponse, result: unknown) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ ResultJson: JSON.stringify(result) }));
}

describe("live texture preview", () => {
	it("negotiates the capability and validates a real Remote Control response", async () => {
		await withRemoteControl(
			(request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk) => (body += chunk));
				request.on("end", () => {
					const call = JSON.parse(body) as { functionName: string };
					if (call.functionName === "GetCapabilityManifest") {
						sendResult(response, {
							assetAuditsObjectPath:
								"/Script/UEShedAssetAudits.Default__UEShedAssetAuditsLibrary",
							authoringObjectPath:
								"/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
							capabilities: ["asset-audits.texture-preview.v1"],
							producerKind: "unreal_editor",
							projectName: "UEShedFixture",
							schemaVersion: 1
						});
						return;
					}
					sendResult(response, {
						contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
						status: "available",
						authority: "live_editor",
						objectPath,
						mimeType: "image/png",
						width: 256,
						height: 256,
						dataBase64: "iVBORw0KGgo="
					});
				});
			},
			async (endpoint) => {
				const result = await Effect.runPromise(
					readLiveTexturePreview({ endpoint, objectPath }).pipe(
						Effect.provide(RemoteControlClientLive)
					)
				);
				expect(result.status).toBe("available");
				if (result.status === "available") expect(result.width).toBe(256);
			}
		);
	});

	it("reports a missing optional capability without attempting a preview call", async () => {
		let calls = 0;
		await withRemoteControl(
			(_request, response) => {
				calls += 1;
				sendResult(response, {
					authoringObjectPath: "/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
					capabilities: [],
					producerKind: "unreal_editor",
					schemaVersion: 1
				});
			},
			async (endpoint) => {
				const result = await Effect.runPromise(
					readLiveTexturePreview({ endpoint, objectPath }).pipe(
						Effect.provide(RemoteControlClientLive)
					)
				);
				expect(result).toMatchObject({
					status: "unavailable",
					reason: "capability_missing"
				});
			}
		);
		expect(calls).toBe(1);
	});
});

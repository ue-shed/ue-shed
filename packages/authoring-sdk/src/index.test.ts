import { createServer } from "node:http";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeAuthoringSessionReviewResult,
	decodeAuthoringTransportRequest,
	makeAuthoringHttpClient
} from "./index.js";

describe("authoring SDK contracts", () => {
	for (const body of ["{invalid", "{}", JSON.stringify({ status: "success", value: {} })]) {
		for (const read of [false, true]) {
			it(`preserves ${read ? "read escalation" : "mutation reconciliation"} for malformed adopted-host reply ${body}`, async () => {
				let requests = 0;
				const server = createServer((request, response) => {
					request.resume();
					request.on("end", () => {
						requests += 1;
						response.writeHead(200, { "content-type": "application/json" });
						response.end(body);
					});
				});
				await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
				try {
					const address = server.address();
					if (!(address instanceof Object)) throw new Error("Expected TCP listener");
					const client = makeAuthoringHttpClient({
						endpoint: `http://127.0.0.1:${address.port}`
					});
					const call = read
						? client.listSessions().pipe(Effect.asVoid)
						: client.applySession("draft").pipe(Effect.asVoid);
					const error = await Effect.runPromise(Effect.flip(call));
					expect(error.retrySafe).toBe(read);
					expect(error.nextStep).toBe(read ? "escalate" : "reconcile");
					if (!read) expect(error.recovery).toContain("may have applied");
					expect(requests).toBe(1);
				} finally {
					await new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve()))
					);
				}
			});
		}
	}

	it("decodes complete session review results and rejects malformed projections", async () => {
		const result = {
			review: {
				activeCommandCount: 0,
				canRedo: false,
				canUndo: false,
				commandGroups: [],
				createdAt: "2026-07-16T00:00:00.000Z",
				lifecycle: "open",
				pipeline: { canApply: false, kind: "draft" },
				project: { id: "fixture", root: "C:/Fixture" },
				sessionId: "session-1",
				tables: [],
				updatedAt: "2026-07-16T00:00:00.000Z",
				validation: {
					diagnostics: [],
					errorCount: 0,
					valid: true,
					warningCount: 0
				}
			},
			status: "ready"
		};
		expect(await Effect.runPromise(decodeAuthoringSessionReviewResult(result))).toEqual(result);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeAuthoringSessionReviewResult({
						review: { tables: "bad" },
						status: "ready"
					})
				)
			)
		).toBe(true);
	});

	it("rejects malformed transport requests", async () => {
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeAuthoringTransportRequest({
						operation: "open_catalog_table",
						objectPath: "/Game/Data/DT_Test.DT_Test"
					})
				)
			)
		).toBe(true);

		expect(
			await Effect.runPromise(
				decodeAuthoringTransportRequest({
					authority: "live",
					objectPath: "/Game/Data/DT_Test.DT_Test",
					operation: "open_catalog_table"
				})
			)
		).toMatchObject({ authority: "live", operation: "open_catalog_table" });
	});

	it("uses the HTTP transport and decodes the operation result", async () => {
		const operations: string[] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				// SAFETY: the SDK serializes every authoring request with its operation discriminator.
				const payload = JSON.parse(body) as { operation: string };
				operations.push(payload.operation);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						status: "success",
						value:
							payload.operation === "get_catalog_progress"
								? {
										cacheHits: 170000,
										phase: "scanning",
										processedAssets: 171000,
										tablesFound: 550,
										totalAssets: 174026
									}
								: { diagnostics: [], status: "ready", tables: [] }
					})
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!(address instanceof Object)) throw new Error("Expected TCP address");
			const client = makeAuthoringHttpClient({
				endpoint: `http://127.0.0.1:${address.port}/api/authoring`
			});
			expect(await Effect.runPromise(client.loadConfiguredCatalog())).toEqual({
				diagnostics: [],
				status: "ready",
				tables: []
			});
			expect(await Effect.runPromise(client.getCatalogProgress())).toMatchObject({
				cacheHits: 170000,
				phase: "scanning",
				processedAssets: 171000
			});
			expect(operations).toEqual(["load_configured_catalog", "get_catalog_progress"]);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
		}
	});
});

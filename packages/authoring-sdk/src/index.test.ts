import { createServer } from "node:http";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeAuthoringSessionIntent,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionReviewResult,
	decodeAuthoringTransportRequest,
	makeAuthoringHttpClient
} from "./index.js";

describe("authoring SDK contracts", () => {
	it("decodes host-neutral row intents", async () => {
		expect(
			await Effect.runPromise(
				decodeAuthoringSessionIntent({
					kind: "duplicate_row",
					rowName: "Beta",
					sessionId: "session-1",
					sourceRowId: "row:Alpha",
					tableObjectPath: "/Game/Data/DT_Test.DT_Test"
				})
			)
		).toMatchObject({ kind: "duplicate_row", sourceRowId: "row:Alpha" });
	});

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

	it("decodes recent persisted session summaries", async () => {
		const result = {
			diagnostics: [],
			sessions: [
				{
					commandCount: 3,
					createdAt: "2026-07-16T00:00:00.000Z",
					id: "session-1",
					lifecycle: "open",
					tableObjectPaths: ["/Game/Data/DT_Test.DT_Test"],
					undoPointer: 2,
					updatedAt: "2026-07-16T00:00:01.000Z"
				}
			],
			status: "ready"
		};
		expect(await Effect.runPromise(decodeAuthoringSessionListResult(result))).toEqual(result);
	});

	it("rejects malformed transport requests", async () => {
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeAuthoringTransportRequest({ operation: "open_catalog_table" })
				)
			)
		).toBe(true);
	});

	it("requires an explicit authority when opening a catalog table", async () => {
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
			if (!address || typeof address === "string") throw new Error("Expected TCP address");
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

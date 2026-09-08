import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CameraFrameRequest,
	CameraRenderSessionRequest,
	cameraRenderContract,
	type CameraFrameResult
} from "@ue-shed/cameras";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	fixtureReviewSet,
	runCliAsync,
	JsonObject,
	parseRecord
} from "./cli-process.test-support.js";

describe("ue-shed Review capture CLI process", () => {
	it("records two external-automation captures from separate CLI processes", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-external-processes-"));
		const reviewSetPath = join(root, "review-set.json");
		await copyFile(fixtureReviewSet, reviewSetPath);
		const sessions = new Map<string, CameraRenderSessionRequest>();
		const frames = new Map<string, CameraFrameResult>();
		const closedSessions: string[] = [];
		const server = createServer((request, response) => {
			void (async () => {
				let body = "";
				request.setEncoding("utf8");
				for await (const chunk of request) body += chunk;
				// SAFETY: the CLI serializes this private Remote Control request contract.
				const call = JSON.parse(body) as {
					functionName: string;
					parameters: { RequestJson: string; SessionId: string };
				};
				const reply = (value: Schema.Json) => {
					response.writeHead(200, { "content-type": "application/json" });
					response.end(JSON.stringify({ ResultJson: JSON.stringify(value) }));
				};
				if (call.functionName === "GetCapabilityManifest") {
					return reply({
						schemaVersion: 1,
						producerKind: "unreal_editor",
						capabilities: ["cameras.render-session.v1"]
					});
				}
				if (call.functionName === "GetCameraRenderCapabilities") {
					return reply({
						contract: cameraRenderContract,
						projectName: "Fixture",
						engineVersion: "fixture-engine",
						pluginVersion: "fixture-plugin",
						renderers: [],
						preparation: [],
						freeze: [],
						maximumRetainedOperations: 64,
						maximumRetainedSessions: 9,
						retentionMs: 120000
					});
				}
				if (call.functionName === "BeginCameraRender") {
					const session = Schema.decodeUnknownSync(CameraRenderSessionRequest)(
						JSON.parse(call.parameters.RequestJson)
					);
					sessions.set(session.sessionId, session);
					return reply({
						status: "opened",
						sessionId: session.sessionId,
						resolvedPolicy: session.policy
					});
				}
				if (call.functionName === "EndCameraRender") {
					if (!sessions.delete(call.parameters.SessionId))
						throw new Error("Unknown render session");
					closedSessions.push(call.parameters.SessionId);
					return reply({
						status: "closed",
						sessionId: call.parameters.SessionId,
						restoration: "restored"
					});
				}
				if (call.functionName === "StartCameraFrame") {
					const frame = Schema.decodeUnknownSync(CameraFrameRequest)(
						JSON.parse(call.parameters.RequestJson)
					);
					const session = sessions.get(frame.sessionId);
					if (!session) throw new Error("Unknown render session");
					const relativePath = `${frame.sessionId}/${frame.operationId}.png`;
					const stagingPath = join(
						root,
						"Saved",
						"UEShed",
						"CameraRenderStaging",
						relativePath
					);
					await mkdir(join(stagingPath, ".."), { recursive: true });
					await writeFile(stagingPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
					const result: CameraFrameResult = {
						status: "captured",
						sessionId: frame.sessionId,
						operationId: frame.operationId,
						artifact: {
							relativePath,
							bytes: 8,
							width: frame.size.width,
							height: frame.size.height
						},
						evidence: {
							camera: frame.camera,
							size: frame.size,
							policy: session.policy,
							editorState: {
								mapPackageDirtyBefore: false,
								mapPackageDirtyAfter: false
							},
							exposureEV100: null,
							preparation: {
								status: "preserved",
								regionsHeld: 0,
								dataLayersApplied: 0,
								limitations: []
							},
							settling: {
								renderedFrames: 1,
								elapsedMs: 1,
								convergence: "not_assessed"
							},
							engineVersion: "fixture-engine",
							pluginVersion: "fixture-plugin"
						}
					};
					frames.set(frame.sessionId, result);
					return reply(result);
				}
				if (call.functionName !== "InspectRenderedReview")
					throw new Error(`Unexpected call: ${call.functionName}`);
				const frame = frames.get(call.parameters.SessionId);
				if (!frame) throw new Error("No rendered frame to inspect");
				// SAFETY: RequestJson is produced by the map-capture client immediately before this check.
				const capture = JSON.parse(call.parameters.RequestJson) as {
					subject: { actorPath: string; kind: "actor_path" };
				};
				const stagingPath = join(
					root,
					"Saved",
					"UEShed",
					"ReviewStaging",
					frame.sessionId,
					"pure.png"
				);
				await mkdir(join(stagingPath, ".."), { recursive: true });
				await copyFile(
					join(
						root,
						"Saved",
						"UEShed",
						"CameraRenderStaging",
						frame.artifact.relativePath
					),
					stagingPath
				);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						ResultJson: JSON.stringify({
							clearCompanion: { status: "not_requested" },
							resolvedSubject:
								capture.subject.kind === "actor_path"
									? {
											actorPath: capture.subject.actorPath,
											kind: capture.subject.kind,
											transform: {
												location: { x: 0, y: 0, z: 0 },
												rotation: { pitch: 0, roll: 0, yaw: 0 }
											}
										}
									: capture.subject,
							stagedArtifacts: [{ stagingPath, variant: "pure" }],
							status: "inspected",
							subjectProjection: {
								margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
								normalizedBounds: { maxX: 0.9, maxY: 0.9, minX: 0.1, minY: 0.1 },
								status: "projected",
								viewportStatus: "fully_within_viewport"
							},
							visibility: { reason: "Fake producer", status: "not_assessed" }
						})
					})
				);
			})().catch((cause) => {
				response.writeHead(500);
				response.end(String(cause));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!(address instanceof Object)) throw new Error("No server port");
			const endpoint = `http://127.0.0.1:${address.port}`;
			const captureArgs = [
				"review",
				"capture",
				root,
				reviewSetPath,
				endpoint,
				"--cause",
				"external_automation",
				"--correlation",
				"nightly-fixture"
			];
			const firstProcess = await runCliAsync(captureArgs);
			const secondProcess = await runCliAsync(captureArgs);
			expect(closedSessions).toHaveLength(2);
			expect(new Set(closedSessions).size).toBe(2);
			expect(sessions.size).toBe(0);
			expect(firstProcess.status, firstProcess.stdout + firstProcess.stderr).toBe(0);
			expect(secondProcess.status, secondProcess.stdout + secondProcess.stderr).toBe(0);
			const first = parseRecord(firstProcess.stdout);
			const second = parseRecord(secondProcess.stdout);
			expect(first.id).not.toBe(second.id);
			expect(first.invocation).toMatchObject({
				cause: { correlationId: "nightly-fixture", type: "external_automation" }
			});
			expect(second.invocation).toMatchObject({
				cause: { correlationId: "nightly-fixture", type: "external_automation" }
			});
			const resultArray = Schema.Array(JsonObject);
			const firstResult = Schema.decodeUnknownSync(resultArray)(first.results)[0]!;
			const secondResult = Schema.decodeUnknownSync(resultArray)(second.results)[0]!;
			expect(firstResult.viewRevision).toEqual(secondResult.viewRevision);
			expect(firstResult.realization).toEqual(secondResult.realization);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { force: true, recursive: true });
		}
	}, 30_000);
});

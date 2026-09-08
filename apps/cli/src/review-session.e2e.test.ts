import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSuccessfulCli, runCliAsync, parseRecord } from "./cli-process.test-support.js";

describe("ue-shed Review session CLI process", () => {
	it("generates a permissive rig and tunes its durable session from separate CLI calls", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-framing-rig-"));
		const parametersPath = join(root, "framing-parameters.json");
		const patchPath = join(root, "authoring-patch.json");
		const parameters = {
			fieldOfViewDegrees: 65,
			groups: [
				{
					displayName: "Automation ring",
					distanceScale: 1.6,
					elevation: 0.2,
					enabled: true,
					id: "automation_ring",
					pattern: { count: 30, kind: "ring", ringOffsetDegrees: 15 }
				}
			],
			margin: 0.1
		};
		await writeFile(parametersPath, JSON.stringify(parameters), "utf8");
		const server = createServer((request, response) => {
			void (async () => {
				let body = "";
				request.setEncoding("utf8");
				for await (const chunk of request) body += chunk;
				// SAFETY: the CLI serializes Remote Control calls with a required functionName.
				const call = JSON.parse(body) as { functionName: string };
				if (call.functionName !== "InspectReviewSelection") {
					throw new Error(`Unexpected call ${call.functionName}`);
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						ResultJson: JSON.stringify({
							actorPath:
								"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
							bounds: {
								center: { x: 0, y: 0, z: 250 },
								extent: { x: 600, y: 450, z: 250 },
								rotation: { pitch: 0, roll: 0, yaw: 15 }
							},
							contract: {
								name: "ue-shed-review-selection",
								version: { major: 1, minor: 1 }
							},
							displayName: "Review Subject",
							mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							status: "selected"
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
			const generatedProcess = await runCliAsync([
				"review",
				"framing",
				"candidates",
				endpoint,
				"--parameters",
				parametersPath
			]);
			expect(generatedProcess.status, generatedProcess.stderr).toBe(0);
			const generated = parseRecord(generatedProcess.stdout);
			expect(generated.candidates).toHaveLength(30);

			const bootstrapProcess = await runCliAsync([
				"review",
				"authoring",
				"bootstrap",
				root,
				endpoint
			]);
			expect(bootstrapProcess.status, bootstrapProcess.stderr).toBe(0);
			const session = parseRecord(bootstrapProcess.stdout);
			const sessionId = String(session.id);
			await writeFile(
				patchPath,
				JSON.stringify({
					candidateOverrides: [
						{
							candidateId: "preset/automation_ring/2",
							overrides: { elevation: 0.75 }
						}
					],
					discardedCandidateIds: [],
					framingParameters: parameters,
					manualReason: "",
					selectedCandidateId: "preset/automation_ring/2"
				}),
				"utf8"
			);
			const tuned = parseRecord(
				runSuccessfulCli(["review", "authoring", "tune", root, sessionId, patchPath])
			);
			expect(tuned.candidates).toHaveLength(30);
			expect(tuned).toMatchObject({
				candidateOverrides: [
					{
						candidateId: "preset/automation_ring/2",
						overrides: { elevation: 0.75 }
					}
				],
				selectedCandidateId: "preset/automation_ring/2"
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
			await rm(root, { force: true, recursive: true });
		}
	}, 30_000);
});

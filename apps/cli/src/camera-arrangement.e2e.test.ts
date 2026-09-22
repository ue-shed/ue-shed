import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { decodeReviewSet } from "@ue-shed/cameras";
import { describe, expect, it } from "vitest";
import {
	fixtureReviewSet,
	parseRecord,
	runSuccessfulHeadlessCli
} from "./cli-process.test-support.js";

describe("camera arrangement CLI process", () => {
	it("creates, tunes, restarts, and approves an actor-scoped camera without Unreal or Workbench", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-arrangement-cli-"));
		try {
			const set = await Effect.runPromise(
				decodeReviewSet(JSON.parse(await readFile(fixtureReviewSet, "utf8")))
			);
			const view = set.views[0];
			if (!view || view.target.kind !== "actor")
				throw new Error("The generic fixture requires an actor View.");
			const input = join(root, "input.json"),
				draft = join(root, "draft.json"),
				patch = join(root, "patch.json"),
				approval = join(root, "approval.json"),
				destination = join(root, "approved.json");
			await writeFile(
				input,
				JSON.stringify({
					reviewSet: set,
					arrangement: {
						version: 1,
						id: "cli-arrangement",
						revision: 0,
						projectName: "Fixture",
						mapPath: set.project.mapPath,
						subject: view.target.subject,
						bounds: {
							center: { x: 0, y: 0, z: 100 },
							extent: { x: 100, y: 100, z: 100 },
							rotation: { pitch: 0, yaw: 0, roll: 0 }
						},
						settings: {
							fieldOfViewDegrees: 60,
							distanceScale: 1,
							heightOffset: 0,
							margin: 0.1
						},
						cameras: [
							{
								id: "camera-a",
								viewId: "cli-camera-a",
								displayName: "CLI camera",
								yawDegrees: 45,
								overrides: {}
							}
						],
						retiredCameraIds: [],
						captureProfileId: view.captureProfileId,
						visibilityPolicyId: view.visibilityPolicyId
					}
				})
			);
			const run = (...args: string[]) =>
				parseRecord(
					runSuccessfulHeadlessCli(["review", "authoring", "arrangement", ...args])
				);
			expect(run("create", draft, input)).toMatchObject({ arrangement: { revision: 0 } });
			await writeFile(
				patch,
				JSON.stringify({
					kind: "tune",
					arrangementId: "cli-arrangement",
					expectedRevision: 0,
					operationId: "tune",
					settings: { fieldOfViewDegrees: 40, heightOffset: 100, distanceScale: 1.25 }
				})
			);
			expect(run("patch", draft, patch)).toMatchObject({ arrangement: { revision: 1 } });
			expect(run("show", draft)).toMatchObject({
				arrangement: { revision: 1, settings: { fieldOfViewDegrees: 40 } }
			});
			await writeFile(
				approval,
				JSON.stringify({
					expectedRevision: 1,
					operationId: "save",
					cameraId: "camera-a",
					destination
				})
			);
			run("approve", draft, approval);
			run("approve", draft, approval);
			const saved = await Effect.runPromise(
				decodeReviewSet(JSON.parse(await readFile(destination, "utf8")))
			);
			expect(saved.views).toHaveLength(set.views.length + 1);
			expect(saved.views[0]).toEqual(view);
			expect(saved.views.at(-1)).toMatchObject({
				revision: { number: 1 },
				authoring: { arrangementId: "cli-arrangement", cameraId: "camera-a" },
				viewpoint: { approvedPose: { fieldOfViewDegrees: 40, location: { z: 200 } } }
			});
			const savedView = saved.views.at(-1);
			if (!savedView || savedView.viewpoint.kind !== "world_fixed")
				throw new Error("Missing approved camera");
			const snapshotPath = join(root, "native.json"),
				proposalPath = join(root, "recovery.json");
			await writeFile(
				snapshotPath,
				JSON.stringify({
					version: 1,
					status: "ready",
					message: "",
					sessionId: "cli-arrangement",
					cameraId: "camera-a",
					producerId: "cli-native",
					revision: 1,
					sequence: 1,
					pending: true,
					piloting: false,
					saveRequested: false,
					pose: { ...savedView.viewpoint.approvedPose, fieldOfViewDegrees: 55 }
				})
			);
			const proposal = run("recovery-file", draft, snapshotPath);
			expect(proposal).toMatchObject({
				expectedRevision: 1,
				native: { pose: { fieldOfViewDegrees: 55 } }
			});
			await writeFile(proposalPath, JSON.stringify(proposal));
			expect(run("recovery-file", draft, proposalPath, "--choice", "native")).toMatchObject({
				arrangement: { revision: 2 }
			});
			expect(run("recovery-file", draft, proposalPath, "--choice", "native")).toMatchObject({
				arrangement: { revision: 2 }
			});
			expect(
				await Effect.runPromise(
					decodeReviewSet(JSON.parse(await readFile(destination, "utf8")))
				)
			).toEqual(saved);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30000);
});

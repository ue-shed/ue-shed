import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ArrangementCameraId, CameraOperationId } from "./camera-arrangement.js";
import { makeCameraAuthoringStore } from "./camera-authoring-store.js";
import { fixtureArrangement, fixtureSet } from "./camera-arrangement.test-support.js";

describe("camera authoring process crash recovery", () => {
	for (const contents of [
		"malformed",
		JSON.stringify({ version: 1, pid: process.pid, host: "another-machine", token: "abcdef" })
	]) {
		it("leaves uncertain or foreign directory ownership untouched", async () => {
			const root = await mkdtemp(join(tmpdir(), "camera-owner-"));
			try {
				const draft = join(root, "draft.json"),
					owner = join(`${draft}.lock-v2`, "owner-abcdef.json");
				await mkdir(`${draft}.lock-v2`);
				await writeFile(owner, contents);
				await expect(
					Effect.runPromise(
						makeCameraAuthoringStore(draft).create(fixtureArrangement(), fixtureSet())
					)
				).rejects.toThrow("writer lock");
				expect(await readFile(owner, "utf8")).toBe(contents);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	}
	for (const boundary of ["before-draft", "after-draft", "before-export", "cancel-draft"]) {
		it(`recovers a killed writer at ${boundary} without duplicate revisions`, async () => {
			const root = await mkdtemp(join(tmpdir(), "camera-crash-"));
			const draft = join(root, "draft.json"),
				destination = join(root, "approved.json");
			const store = makeCameraAuthoringStore(draft),
				arrangement = fixtureArrangement();
			await Effect.runPromise(store.create(arrangement, fixtureSet()));
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					fileURLToPath(new URL("./camera-crash.test-support.ts", import.meta.url)),
					draft,
					destination,
					boundary
				],
				{
					stdio: ["ignore", "ignore", "pipe", "ipc"],
					windowsHide: true
				}
			);
			const exited = once(child, "exit");
			let errors = "";
			child.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			try {
				await Promise.race([
					once(child, "message"),
					exited.then(() => {
						throw new Error(`Worker exited before crash boundary: ${errors}`);
					})
				]);
				const tune = {
					kind: "tune" as const,
					arrangementId: arrangement.id,
					expectedRevision: 0,
					operationId: CameraOperationId.make("crash-tune"),
					settings: { fieldOfViewDegrees: 40 }
				};
				await expect(Effect.runPromise(store.mutate(tune))).rejects.toThrow("writer lock");
				if (boundary === "cancel-draft") {
					const interrupted = once(child, "message");
					child.send?.("interrupt");
					await interrupted;
					await expect(Effect.runPromise(store.mutate(tune))).rejects.toThrow(
						"writer lock"
					);
					child.send?.("resume");
				} else child.kill("SIGKILL");
				await exited;
				if (boundary === "before-export") {
					const recovered = await Effect.runPromise(
						store.approve({
							operationId: CameraOperationId.make("crash-approval"),
							expectedRevision: 0,
							cameraId: ArrangementCameraId.make("camera-0"),
							destination
						})
					);
					expect(recovered.projection).toBeUndefined();
					expect(recovered.reviewSet.views[0]?.revision.number).toBe(1);
					expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(
						recovered.reviewSet
					);
				} else {
					const results = await Promise.allSettled(
						Array.from({ length: 8 }, () => Effect.runPromise(store.mutate(tune)))
					);
					expect(results.some((result) => result.status === "fulfilled")).toBe(true);
					const recovered = await Effect.runPromise(store.mutate(tune));
					expect(recovered.arrangement.revision).toBe(1);
					expect(recovered.arrangement.settings.fieldOfViewDegrees).toBe(40);
				}
				expect((await readdir(root)).filter((name) => name.endsWith(".lock-v2"))).toEqual(
					[]
				);
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited;
				await rm(root, { recursive: true, force: true });
			}
		}, 20_000);
	}
	it("preserves legacy and unreadable locks instead of guessing their ownership", async () => {
		const root = await mkdtemp(join(tmpdir(), "camera-lock-"));
		try {
			const draft = join(root, "draft.json");
			await writeFile(`${draft}.lock`, "unreadable");
			await expect(
				Effect.runPromise(
					makeCameraAuthoringStore(draft).create(fixtureArrangement(), fixtureSet())
				)
			).rejects.toThrow();
			expect(await readFile(`${draft}.lock`, "utf8")).toBe("unreadable");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

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

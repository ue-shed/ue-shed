import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { NiagaraPreviewProgress, readNiagaraPreviewProgress } from "./progress.js";
it("validates bounded progress identity and permits a missing older-producer file", async () => {
	const root = await mkdtemp(join(tmpdir(), "niagara-progress-"));
	const path = join(root, "progress.json");
	try {
		expect(await Effect.runPromise(readNiagaraPreviewProgress(path, "run"))).toBeUndefined();
		const progress = {
			schemaVersion: 1,
			runId: "run",
			phase: "capturing",
			completedFrames: 2,
			totalFrames: 10,
			elapsedMs: 200
		};
		await writeFile(path, JSON.stringify(progress));
		expect(await Effect.runPromise(readNiagaraPreviewProgress(path, "run"))).toEqual(progress);
		await expect(Effect.runPromise(readNiagaraPreviewProgress(path, "other"))).rejects.toThrow(
			"another run"
		);
		expect(Schema.is(NiagaraPreviewProgress)({ ...progress, completedFrames: 11 })).toBe(false);
		await writeFile(path, " ".repeat(4097));
		await expect(Effect.runPromise(readNiagaraPreviewProgress(path, "run"))).rejects.toThrow(
			"bounded"
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

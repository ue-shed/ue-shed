import { mkdir, mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateGameTextScale } from "./localization-scale-data.ts";

let temporary: string;
let first: string;
beforeAll(async () => {
	await mkdir(resolve("test-results/game-text-scale"), { recursive: true });
	temporary = await mkdtemp(resolve("test-results/game-text-scale/benchmark-"));
	first = resolve(temporary, "first");
	await generateGameTextScale({ root: first, scale: 0.001, seed: 57 });
});
afterAll(async () => {
	if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe("fresh-process Game Text benchmark checks", () => {
	it("records failed stages from fresh workers and enforces the RSS watchdog", async () => {
		await copyFile(resolve(first, "scale.json"), resolve(temporary, "scale.json"));
		const failedOutput = resolve(temporary, "failed.json");
		const stoppedOutput = resolve(temporary, "stopped.json");
		const benchmark = resolve("scripts/benchmark-game-text-scale.ts");
		const run = promisify(execFile);
		await expect(
			run(
				process.execPath,
				[
					benchmark,
					"--project",
					temporary,
					"--heaps",
					"default,256",
					"--output",
					failedOutput
				],
				{ windowsHide: true }
			)
		).rejects.toThrow();
		await expect(
			run(
				process.execPath,
				[benchmark, "--project", first, "--max-rss-gib", "0.01", "--output", stoppedOutput],
				{ windowsHide: true }
			)
		).rejects.toThrow();
		const decode = Schema.decodeUnknownSync(
			Schema.fromJsonString(
				Schema.Struct({
					results: Schema.Array(
						Schema.Struct({
							status: Schema.String,
							failureStage: Schema.String,
							error: Schema.String,
							seconds: Schema.Number,
							peak: Schema.Struct({
								heapUsed: Schema.Number,
								rss: Schema.Number,
								arrayBuffers: Schema.Number
							})
						})
					)
				})
			)
		);
		const failed = decode(await readFile(failedOutput, "utf8"));
		expect(failed.results).toHaveLength(2);
		for (const result of failed.results) {
			expect(result.status).toBe("failed");
			expect(result.failureStage).toBe("evidence");
			expect(result.error.length).toBeGreaterThan(0);
			expect(result.peak.heapUsed).toBeGreaterThan(0);
		}
		const stopped = decode(await readFile(stoppedOutput, "utf8"));
		expect(stopped.results[0]?.status).toBe("stopped");
		expect(stopped.results[0]?.error).toContain("RSS limit exceeded");
	}, 30_000);
	it("rejects a cached edit as a fresh PO measurement and restores the source bytes", async () => {
		const cache = resolve(temporary, "refresh-cache"),
			po = resolve(first, "Content/Localization/Generated/en/Generated.po"),
			original = await readFile(po);
		const command = (task: string, byte = 110) =>
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve("scripts/benchmark-localization-import.ts"),
					"--project",
					first,
					"--cache",
					cache,
					"--output",
					resolve(temporary, `${task}-${byte}.json`),
					"--mode",
					"shared",
					"--select",
					task,
					"--po-change-byte",
					String(byte)
				],
				{ windowsHide: true, timeout: 20000 }
			);
		await command("cold");
		await command("folder");
		const folder = JSON.parse(await readFile(resolve(temporary, "folder-110.json"), "utf8"));
		const nativeFolder = folder.results.find(
			(stage: { stage: string }) => stage.stage === "reader:native-folder"
		);
		expect(folder.outcome.kind).toBe("done");
		expect(nativeFolder.references).toBeGreaterThan(0);
		expect(
			folder.results.find(
				(stage: { stage: string }) => stage.stage === "reader:native-folder-oracle"
			)
		).toMatchObject({ references: nativeFolder.references, prefix: nativeFolder.prefix });
		await expect(command("refresh")).rejects.toThrow();
		const cached = JSON.parse(await readFile(resolve(temporary, "refresh-110.json"), "utf8"));
		expect(cached.outcome.kind).toBe("failed");
		expect(cached.outcome.error).toContain("already cached");
		expect(await readFile(po)).toEqual(original);
		await command("refresh", 111);
		const fresh = JSON.parse(await readFile(resolve(temporary, "refresh-111.json"), "utf8"));
		expect(fresh.outcome.kind).toBe("done");
		const refreshed = fresh.results.find(
			(stage: { stage: string }) => stage.stage === "one-byte-po:target"
		);
		expect(refreshed).toMatchObject({ parsed: 1 });
		// Native import probes the changed string block. Its reuse bound and entry parity are
		// covered by localization-import.test.ts; this harness checks that the edit is fresh.
		expect(refreshed.lookupStrings).toBeGreaterThan(0);
		expect(await readFile(po)).toEqual(original);
	}, 60000);
	it("records a run deadline as failure, including worker startup, and permits only lower caps", async () => {
		const report = resolve(temporary, "deadline.json");
		const benchmark = resolve("scripts/benchmark-localization-import.ts");
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					benchmark,
					"--project",
					first,
					"--cache",
					resolve(temporary, "deadline-cache"),
					"--output",
					report,
					"--mode",
					"shared",
					"--select",
					"cold",
					"--run-timeout-seconds",
					"0.05"
				],
				{ windowsHide: true, timeout: 15000 }
			)
		).rejects.toThrow();
		const result = JSON.parse(await readFile(report, "utf8"));
		expect(result.outcome.kind).toBe("failed");
		expect(result.outcome.error).toContain("exceeded");
		expect(result.limits.runSeconds).toBe(0.05);
		expect(result.results).toEqual([]);
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					benchmark,
					"--project",
					first,
					"--cache",
					resolve(temporary, "deadline-cache"),
					"--output",
					report,
					"--run-timeout-seconds",
					"1201"
				],
				{ windowsHide: true, timeout: 15000 }
			)
		).rejects.toThrow("cannot exceed");
	});
});

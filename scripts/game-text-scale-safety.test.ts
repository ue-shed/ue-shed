import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readScaleRecipe } from "./game-text-scale-options.ts";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";
import { benchmarkRunExpired, benchmarkRunSeconds } from "./game-text-scale-safety.ts";

describe("whole benchmark deadline", () => {
	it("restores only the edited byte when a killed worker cannot run its cleanup", async () => {
		await mkdir(resolve("test-results/game-text-scale"), { recursive: true });
		const directory = await mkdtemp(resolve("test-results/game-text-scale/byte-guard-"));
		const path = resolve(directory, "test.po");
		try {
			await writeFile(path, "prefix mirava trailing bytes");
			const saved = await captureBenchmarkByte(path, "mirava");
			await writeFile(path, "prefix nirava trailing bytes");
			await restoreBenchmarkByte(saved);
			expect(await readFile(path, "utf8")).toBe("prefix mirava trailing bytes");
			await restoreBenchmarkByte(saved);
			expect(await readFile(path, "utf8")).toBe("prefix mirava trailing bytes");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("limits every 10× or larger run to 900 seconds", () => {
		expect(benchmarkRunSeconds(1)).toBeUndefined();
		expect(benchmarkRunSeconds(10)).toBe(900);
		expect(benchmarkRunSeconds(20)).toBe(900);
	});
	it("fails at the hard line regardless of stage resets or a late done message", () => {
		const started = 12000,
			seconds = benchmarkRunSeconds(10);
		for (const stageReset of [started, started + 400000, started + 899000]) {
			expect(benchmarkRunExpired(started, stageReset, seconds)).toBe(false);
			expect(benchmarkRunExpired(started, started + 900000, seconds)).toBe(true);
		}
		expect(benchmarkRunExpired(started, started + 900001, seconds)).toBe(true);
		expect(benchmarkRunExpired(started, started + 2000000, undefined)).toBe(false);
	});
});

for (const field of ["recipe", "shape"]) {
	it(`rejects overflow in a stored ${field} without restricting fractional scales`, async () => {
		await mkdir(resolve("test-results/game-text-scale"), { recursive: true });
		const root = await mkdtemp(resolve("test-results/game-text-scale/recipe-"));
		const path = resolve(root, "scale.json");
		try {
			const document = `{"schemaVersion":1,"${field}":{"scale":1e999,"keys":1,"packages":1,"partialPackages":1,"occurrences":1,"gaps":1,"cultures":["en"]}}`;
			await writeFile(path, document);
			await expect(readScaleRecipe(root)).rejects.toThrow();
			await writeFile(path, document.replace("1e999", "0.001"));
			expect((await readScaleRecipe(root)).scale).toBe(0.001);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

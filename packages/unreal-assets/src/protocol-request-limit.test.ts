import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	batchProtocolPaths,
	batchStagedProtocolPaths,
	MAX_PROTOCOL_PATH_BYTES,
	MAX_PROTOCOL_REQUEST_BYTES
} from "./protocol-request-limit.js";
import { makeProtocolRequest } from "./protocol-transport.js";

const encodedBytes = (paths: readonly string[]) => Buffer.byteLength(JSON.stringify(paths), "utf8");

describe("batchProtocolPaths", () => {
	it("keeps a small request in one batch", () => {
		expect(batchProtocolPaths(["Content/A.uasset", "Content/B.uasset"])).toEqual([
			["Content/A.uasset", "Content/B.uasset"]
		]);
		expect(batchProtocolPaths([])).toEqual([]);
	});

	it("splits in order so every batch fits the path budget", () => {
		const paths = Array.from({ length: 40 }, (_, index) => `Content/Ünïcode/${index}.uasset`);
		const budget = 200;
		const batches = batchProtocolPaths(paths, budget);

		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(paths);
		for (const batch of batches) expect(encodedBytes(batch)).toBeLessThanOrEqual(budget + 1);
	});

	it("keeps an oversized path alone instead of dropping it", () => {
		const long = `Content/${"x".repeat(300)}.uasset`;
		expect(batchProtocolPaths(["Content/A.uasset", long, "Content/B.uasset"], 100)).toEqual([
			["Content/A.uasset"],
			[long],
			["Content/B.uasset"]
		]);
	});

	it("fits a default batch of real-sized paths inside the native frame limit", () => {
		const pathAt = (index: number) =>
			"Content/Maps/World/_Generated_/Package_" + String(index).padStart(8, "0") + ".uasset";
		const bytesPerPath = encodedBytes([pathAt(0)]) - 1;
		const paths = Array.from(
			{ length: Math.floor(MAX_PROTOCOL_PATH_BYTES / bytesPerPath) + 1 },
			(_, index) => pathAt(index)
		);
		const batches = batchProtocolPaths(paths);

		expect(batches).toHaveLength(2);
		expect(batches.flat()).toHaveLength(paths.length);
		for (const batch of batches) {
			expect(encodedBytes(batch)).toBeLessThanOrEqual(MAX_PROTOCOL_PATH_BYTES + 1);
			expect(encodedBytes(batch)).toBeLessThan(MAX_PROTOCOL_REQUEST_BYTES);
		}
	});
});

describe("batchStagedProtocolPaths", () => {
	const projectRoot = "D:/Projects/Example Project";
	const directory = "C:/Users/builder/AppData/Local/UE Shed/cache/staging/package-a1b2c3/99999";
	const paths = Array.from(
		{ length: 100_000 },
		(_, row) => `Content/Generated/Package_${String(row).padStart(8, "0")}.uasset`
	);
	// Ordered by group, as Game Text stages them: one to three digit groups.
	const groups = paths.map((_, row) => Math.floor((row * 256) / paths.length));
	const frameBytes = (start: number, length: number) =>
		Buffer.byteLength(
			`${JSON.stringify(
				makeProtocolRequest(
					{
						kind: "extract_text_packages",
						projectRoot,
						paths: paths.slice(start, start + length),
						staging: { directory, groups: groups.slice(start, start + length) }
					},
					{ concurrency: 8, maximumOutputBytes: 10 * 1024 ** 3, timeoutMs: 600_000 },
					{ contractMinor: 19 }
				)
			)}
`,
			"utf8"
		);

	it("keeps every complete staged request inside the native frame limit", () => {
		// Path-only budgeting overfills a staged request once group numbers are added.
		const [pathOnly] = batchProtocolPaths(paths);
		expect(frameBytes(0, pathOnly!.length)).toBeGreaterThan(MAX_PROTOCOL_REQUEST_BYTES);

		const lengths = batchStagedProtocolPaths(paths, groups, directory);
		expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(paths.length);
		expect(lengths.length).toBe(2);
		let start = 0;
		for (const length of lengths) {
			expect(frameBytes(start, length)).toBeLessThanOrEqual(MAX_PROTOCOL_REQUEST_BYTES);
			start += length;
		}
		// The first batch is filled to the boundary: one more path would cross the budget.
		expect(frameBytes(0, lengths[0]! + 1)).toBeGreaterThan(
			MAX_PROTOCOL_REQUEST_BYTES - 64 * 1024
		);
	});

	it("rejects groups that do not match the paths", () => {
		expect(() => batchStagedProtocolPaths(["Content/A.uasset"], [], directory)).toThrow(
			RangeError
		);
		expect(batchStagedProtocolPaths([], [], directory)).toEqual([]);
	});
});

it("matches the native reader's request frame limit", () => {
	const adapter = readFileSync(
		new URL("../../../crates/uasset-io/src/protocol_adapter.rs", import.meta.url),
		"utf8"
	);
	const match = /const MAX_REQUEST_BYTES: usize = (\d+) \* (\d+) \* (\d+);/u.exec(adapter);
	expect(match).not.toBeNull();
	const [, a, b, c] = match ?? [];
	expect(Number(a) * Number(b) * Number(c)).toBe(MAX_PROTOCOL_REQUEST_BYTES);
});

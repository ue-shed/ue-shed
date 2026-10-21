import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	batchProtocolPaths,
	MAX_PROTOCOL_PATH_BYTES,
	MAX_PROTOCOL_REQUEST_BYTES
} from "./protocol-request-limit.js";

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

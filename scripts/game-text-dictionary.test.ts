import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";
import {
	absentId,
	baselineHash,
	buildFront,
	buildHash,
	buildPerfect,
	compareBytes,
	decodeFrontBlock,
	encodeFrontBlock,
	frontRange,
	frontReader,
	hashBytes,
	lookupFront,
	lookupHash,
	packedStrings,
	perfectCandidate,
	sortBytes,
	stringBytes
} from "./game-text-dictionary.ts";
import { benchmarkRunExpired, benchmarkRunSeconds } from "./game-text-scale-safety.ts";

const values = ["", "a", "aa", "ab", "a/b", "a/b/c", "a/c", "z", "é", "ê", "😀", "\ue000"];
describe("dictionary experiment", () => {
	it("radix sorts UTF-8 bytes including terminators, duplicates and supplementary characters", () => {
		const input = packedStrings([...values].reverse().concat("a"));
		const sorted = Array.from(sortBytes(input), (id) => stringBytes(input, id).toString());
		expect(sorted).toEqual(
			[...values, "a"].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		);
	});
	it("front codes exact bytes even when a prefix ends inside a UTF-8 code point", () => {
		const buffers = values.map((value) => Buffer.from(value));
		expect(decodeFrontBlock(encodeFrontBlock(buffers))).toEqual(buffers);
	});
	it("rejects truncated and invalid front-code boundaries", () => {
		const encoded = encodeFrontBlock([Buffer.from("a"), Buffer.from("aa")]);
		expect(() => decodeFrontBlock(encoded.subarray(0, encoded.length - 1))).toThrow();
		expect(() => decodeFrontBlock(Buffer.from([1, 1, 0]))).toThrow("boundary");
		expect(() => decodeFrontBlock(Buffer.from([0, 0]))).toThrow("Trailing");
	});
	for (const blockSize of [16, 32, 64]) {
		it(`looks up and decodes sorted ranks with ${blockSize}-string blocks`, () => {
			const input = packedStrings(
				Array.from({ length: 1001 }, (_, i) => `folder/${1000 - i}/é`)
			);
			const order = sortBytes(input),
				dictionary = buildFront(input, order, blockSize);
			const requests = packedStrings(["folder/0/é", "folder/500/é", "missing"]),
				sorted = sortBytes(requests);
			const lookup = lookupFront(dictionary, requests, sorted);
			for (let i = 0; i < sorted.length; i++) {
				const key = stringBytes(requests, sorted[i]!);
				if (key.toString() === "missing") expect(lookup.result[i]).toBe(absentId);
				else
					expect(compareBytes(stringBytes(input, order[lookup.result[i]!]!), key)).toBe(
						0
					);
			}
			const reader = frontReader(dictionary);
			for (let rank = 0; rank < order.length; rank++)
				expect(reader.block(Math.floor(rank / blockSize))[rank % blockSize]).toEqual(
					stringBytes(input, order[rank]!)
				);
			expect(reader.stats.frames).toBe(dictionary.frames.length);
			expect(dictionary.storedBytes).toBeLessThan(dictionary.rawBytes);
		});
	}
	it("returns the exact contiguous prefix range across blocks, and empty/all ranges", () => {
		const input = packedStrings(
				Array.from({ length: 500 }, (_, i) => `${i < 230 ? "a/" : "b/"}${i}`)
			),
			order = sortBytes(input),
			dictionary = buildFront(input, order, 32);
		expect(frontRange(dictionary, Buffer.from("a/"))).toMatchObject({ start: 0, end: 230 });
		expect(frontRange(dictionary, Buffer.from("b/"))).toMatchObject({ start: 230, end: 500 });
		expect(frontRange(dictionary, Buffer.from("c/"))).toMatchObject({ start: 500, end: 500 });
		expect(frontRange(dictionary, Buffer.alloc(0))).toMatchObject({ start: 0, end: 500 });
	});
	it("visits each compressed group and block at most once for a sorted append batch", () => {
		const input = packedStrings(
			Array.from(
				{ length: 16000 },
				(_, i) => `${i.toString().padStart(6, "0")}/${i.toString(36).repeat(32)}`
			)
		);
		const order = sortBytes(input),
			dictionary = buildFront(input, order, 32);
		expect(dictionary.frames.length).toBeGreaterThan(1);
		const requests = packedStrings(
			Array.from({ length: 1000 }, (_, i) => stringBytes(input, i * 16).toString())
		);
		const sorted = sortBytes(requests),
			lookup = lookupFront(dictionary, requests, sorted);
		for (let i = 0; i < sorted.length; i++)
			expect(stringBytes(input, order[lookup.result[i]!]!)).toEqual(
				stringBytes(requests, sorted[i]!)
			);
		expect(lookup.stats.frames).toBeLessThanOrEqual(dictionary.frames.length);
		expect(lookup.stats.blocks).toBeLessThanOrEqual(dictionary.offsets.length);
	});
	it("builds a BBHash bijection and retains insertion IDs rather than hash slots", () => {
		const input = packedStrings(
				Array.from({ length: 10003 }, (_, i) => `identity-${10003 - i}-😀`)
			),
			dictionary = buildPerfect(input);
		expect(new Set(dictionary.ids).size).toBe(10003);
		for (let i = 0; i < 10003; i++) {
			const hash = hashBytes(stringBytes(input, i));
			expect(perfectCandidate(dictionary, hash[0], hash[1])).toBe(i);
		}
		expect((dictionary.mphBytes * 8) / 10003).toBeLessThan(5);
		expect(dictionary.storedBytes).toBeGreaterThan(dictionary.mphBytes + 10003);
	});
	it("uses fingerprints to reject absences and exact bytes to reject remaining candidates", () => {
		const input = packedStrings(Array.from({ length: 1000 }, (_, i) => `key/${i}`)),
			dictionary = buildPerfect(input);
		let candidates = 0,
			accepted = 0;
		for (let i = 0; i < 10000; i++) {
			const key = Buffer.from(`absent/${i}`),
				hash = hashBytes(key),
				id = perfectCandidate(dictionary, hash[0], hash[1]);
			if (id !== absentId) {
				candidates++;
				if (key.equals(stringBytes(input, id))) accepted++;
			}
		}
		expect(candidates).toBeGreaterThan(0);
		expect(candidates).toBeLessThan(100);
		expect(accepted).toBe(0);
	});
	it("baseline pages round trip exact IDs and reject absent requests", () => {
		const input = packedStrings(Array.from({ length: 20000 }, (_, i) => `string/${i}`)),
			dictionary = buildHash(input);
		const requests = packedStrings(["string/0", "string/8192", "string/19999", "absent"]);
		const lookup = lookupHash(
			dictionary,
			input,
			requests,
			Uint32Array.from({ length: 4 }, (_, i) => baselineHash(stringBytes(requests, i)))
		);
		expect(Array.from(lookup.result)).toEqual([0, 8192, 19999, absentId]);
		expect(lookup.stats.pages).toBeLessThanOrEqual(dictionary.pages.length);
	});
});
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

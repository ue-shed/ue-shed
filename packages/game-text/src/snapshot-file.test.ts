import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	encodeStringBlock,
	encodeSnapshotDirectory,
	MAX_SNAPSHOT_SECTION_BYTES,
	snapshotStringTableBuilder,
	SnapshotFormatError,
	snapshotChecksum,
	type SnapshotColumn,
	type SnapshotEntry
} from "./snapshot-format.js";
import { openSnapshotFile, snapshotColumnsSource, writeSnapshotFile } from "./snapshot-file.js";

let directory: string;
beforeEach(async () => {
	await mkdir(resolve("test-results/snapshot-tests"), { recursive: true });
	directory = await mkdtemp(resolve("test-results/snapshot-tests/file-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});
async function fixture(level = 1) {
	const hot = snapshotStringTableBuilder("hot", 8 + 1024 * 30);
	for (let i = 0; i < 2050; i++)
		hot.intern(`source/${i.toString().padStart(4, "0")}/repeated words`);
	const culture = snapshotStringTableBuilder("c0");
	culture.intern("translation");
	const columns: SnapshotColumn[] = [
		{ name: "state", kind: "u8", values: new Uint8Array(1024) },
		{
			name: "line.source",
			kind: "stringIds",
			domain: "hot",
			stringCount: hot.count,
			values: new Uint32Array([0, 1024, 2049])
		},
		...hot.finish(),
		...culture.finish()
	];
	const path = join(directory, "test.snapshot");
	const metadata = await writeSnapshotFile(path, snapshotColumnsSource(columns), level);
	return { path, metadata };
}
async function damage(path: string, offset: number, bytes = new Uint8Array([255])) {
	const file = await open(path, "r+");
	try {
		await file.write(bytes, 0, bytes.length, offset);
	} finally {
		await file.close();
	}
}

describe("file-backed lazy sections", () => {
	it("bounds decoded domain allocation before touching compressed frames", async () => {
		const starts = Uint32Array.from({ length: 129 }, (_, id) => id);
		const payload = new Uint8Array(starts.buffer);
		const directoryLength = 48 + 130 * 96;
		const entries: SnapshotEntry[] = Array.from(starts, (_, id) => ({
			name: `source.b${id}`,
			kind: "strings",
			codec: 1,
			offset: directoryLength,
			storedLength: 0,
			rawLength: MAX_SNAPSHOT_SECTION_BYTES,
			count: MAX_SNAPSHOT_SECTION_BYTES,
			checksum: 0,
			domain: "source",
			stringCount: 129
		}));
		entries.push({
			name: "source.starts",
			kind: "u32",
			codec: 0,
			offset: directoryLength,
			storedLength: payload.length,
			rawLength: payload.length,
			count: 129,
			checksum: snapshotChecksum(payload),
			domain: "",
			stringCount: 0
		});
		const bytes = new Uint8Array(directoryLength + payload.length);
		bytes.set(encodeSnapshotDirectory(entries, bytes.length));
		bytes.set(payload, directoryLength);
		const path = join(directory, "bounds.snapshot");
		await writeFile(path, bytes);
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.domain("source")).rejects.toMatchObject({
				message: "Raw domain exceeds bulk load cap; use page reads"
			});
		} finally {
			await reader.close();
		}
	});
	it("looks up variable byte blocks and scans multibyte text case insensitively", async () => {
		const table = snapshotStringTableBuilder("source", 24);
		for (const text of ["Éclair", "😀É", "lower", ""]) table.intern(text);
		const path = join(directory, "unicode.snapshot");
		await writeSnapshotFile(path, snapshotColumnsSource([...table.finish()]));
		const reader = await openSnapshotFile(path);
		try {
			expect(await reader.strings("source", [3, 1, 0, 2])).toEqual([
				"",
				"😀É",
				"Éclair",
				"lower"
			]);
			const domain = await reader.domain("source");
			expect(domain.scanSubstring("é")).toBe(2);
			expect(domain.scanSubstring("CLAIR")).toBe(1);
			expect(domain.string(3)).toBe("");
		} finally {
			await reader.close();
		}
	});
	it("bulk loads bounded groups into one buffer and scans Unicode without loading other domains", async () => {
		const { path, metadata } = await fixture();
		await damage(path, metadata.entries.get("c0.b0")!.offset);
		const reader = await openSnapshotFile(path, { bulkReadBytes: 1024 });
		try {
			const domain = await reader.domain("hot");
			expect(domain.count).toBe(2050);
			expect(domain.timings.readBatches).toBeGreaterThan(1);
			expect(domain.string(2049)).toBe("source/2049/repeated words");
			expect(domain.scanSubstring("REPEATED WORDS")).toBe(2050);
			expect(domain.blockStarts).toEqual(new Uint32Array([0, 1024, 2048]));
			expect(domain.blockOffsets[3]).toBe(domain.bytes.length);
			await expect(reader.domain("c0")).rejects.toMatchObject({ section: "c0.b0" });
			await reader.close();
			expect(domain.string(0)).toBe("source/0000/repeated words");
			await expect(reader.domain("hot")).rejects.toMatchObject({
				message: "Reader scope is closed"
			});
		} finally {
			await reader.close();
		}
	});
	it("rejects a checksummed block index inconsistent with block counts", async () => {
		const table = snapshotStringTableBuilder("source", 24);
		for (const text of ["éé", "AbC", "word", "tail"]) table.intern(text);
		const columns = [...table.finish()];
		const starts = columns.find((column) => column.name === "source.starts")!;
		if (!(starts.values instanceof Uint32Array)) throw new Error("Wrong index kind");
		starts.values[1] = 1;
		const path = join(directory, "index.snapshot");
		await writeSnapshotFile(path, snapshotColumnsSource(columns), 0);
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.domain("source")).rejects.toMatchObject({
				message: "String block count mismatch"
			});
			await expect(reader.strings("source", [0])).rejects.toMatchObject({
				message: "String block count mismatch"
			});
		} finally {
			await reader.close();
		}
	});
	it.each(["crc", "padding", "starts"])("checks bulk domain %s corruption", async (fault) => {
		const { path, metadata } = await fixture(fault === "crc" ? 0 : 1);
		const block = metadata.entries.get(fault === "starts" ? "hot.starts" : "hot.b1")!;
		if (fault === "padding") {
			const padded = [...metadata.entries.values()].find(
				(e) => e.kind === "strings" && e.domain === "hot" && e.storedLength % 4
			)!;
			await damage(path, padded.offset + padded.storedLength, new Uint8Array([1]));
		} else await damage(path, block.offset);
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.domain("hot")).rejects.toBeInstanceOf(SnapshotFormatError);
		} finally {
			await reader.close();
		}
	});
	it("opens only metadata and verifies corruption only when that section loads", async () => {
		const { path, metadata } = await fixture();
		await damage(path, metadata.entries.get("c0.b0")!.offset);
		const reader = await openSnapshotFile(path);
		try {
			expect([...(await reader.load("state"))]).toEqual([...new Uint8Array(1024)]);
			expect(await reader.strings("hot", [2049, 0, 1024, 0])).toEqual([
				"source/2049/repeated words",
				"source/0000/repeated words",
				"source/1024/repeated words",
				"source/0000/repeated words"
			]);
			await expect(reader.strings("c0", [0])).rejects.toMatchObject({
				_tag: "SnapshotFormatError",
				section: "c0.b0"
			});
		} finally {
			await reader.close();
		}
	});
	it("reads only the page's blocks even within a domain", async () => {
		const { path, metadata } = await fixture();
		await damage(path, metadata.entries.get("hot.b1")!.offset);
		const reader = await openSnapshotFile(path);
		try {
			expect(await reader.strings("hot", [0, 2049])).toHaveLength(2);
			await expect(reader.strings("hot", [1024])).rejects.toBeInstanceOf(SnapshotFormatError);
			await expect(reader.strings("hot", [2050])).rejects.toBeInstanceOf(SnapshotFormatError);
			await expect(reader.load("absent")).rejects.toBeInstanceOf(SnapshotFormatError);
		} finally {
			await reader.close();
		}
	});
	it("cold sections load independently of corrupt hot strings", async () => {
		const { path, metadata } = await fixture();
		await damage(path, metadata.entries.get("hot.b0")!.offset);
		const reader = await openSnapshotFile(path);
		try {
			expect(await reader.strings("c0", [0])).toEqual(["translation"]);
		} finally {
			await reader.close();
		}
	});
	it("uses raw sections when compression costs more and checks their CRC", async () => {
		const { path, metadata } = await fixture(0);
		expect([...metadata.entries.values()].every((entry) => entry.codec === 0)).toBe(true);
		await damage(path, metadata.entries.get("state")!.offset);
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.load("state")).rejects.toMatchObject({
				section: "state",
				message: "Section checksum mismatch"
			});
		} finally {
			await reader.close();
		}
	});
	it("checks alignment padding when its section loads", async () => {
		const path = join(directory, "padding.snapshot");
		const metadata = await writeSnapshotFile(
			path,
			snapshotColumnsSource([{ name: "state", kind: "u8", values: new Uint8Array([7]) }]),
			0
		);
		const state = metadata.entries.get("state")!;
		await damage(path, state.offset + state.storedLength, new Uint8Array([1]));
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.load("state")).rejects.toMatchObject({
				section: "state",
				message: "Nonzero section padding"
			});
		} finally {
			await reader.close();
		}
	});
	it("rejects truncation at every section boundary without reading payloads", async () => {
		const { path, metadata } = await fixture();
		const file = await open(path, "r+");
		try {
			for (const entry of [...metadata.entries.values()].reverse()) {
				await file.truncate(entry.offset);
				await expect(openSnapshotFile(path)).rejects.toBeInstanceOf(SnapshotFormatError);
			}
		} finally {
			await file.close();
		}
	});
	it("rejects post-open truncation and reads after close", async () => {
		const { path, metadata } = await fixture();
		const reader = await openSnapshotFile(path);
		const file = await open(path, "r+");
		await file.truncate(metadata.entries.get("hot.b0")!.offset);
		await file.close();
		await expect(reader.strings("hot", [0])).rejects.toBeInstanceOf(SnapshotFormatError);
		await reader.close();
		await expect(reader.load("state")).rejects.toMatchObject({
			message: "Reader scope is closed"
		});
	});
	it("bounds decompression by the raw directory length even for a valid zstd frame", async () => {
		const { path, metadata } = await fixture();
		const state = metadata.entries.get("state")!;
		expect(state.codec).toBe(1);
		const file = await open(path, "r+");
		try {
			const bytes = new Uint8Array(48 + metadata.entries.size * 96);
			await file.read(bytes, 0, bytes.length, 0);
			const view = new DataView(bytes.buffer);
			view.setUint32(48 + 52, 32, true);
			view.setUint32(48 + 56, 32, true);
			view.setUint32(28, snapshotChecksum(bytes.subarray(48)), true);
			view.setUint32(32, snapshotChecksum(bytes.subarray(0, 32)), true);
			await file.write(bytes, 0, bytes.length, 0);
		} finally {
			await file.close();
		}
		const reader = await openSnapshotFile(path);
		try {
			await expect(reader.load("state")).rejects.toMatchObject({ section: "state" });
			expect(await reader.strings("c0", [0])).toEqual(["translation"]);
		} finally {
			await reader.close();
		}
	});
	it("streams source columns in order without loading the next before the previous is written", async () => {
		let previousLoaded = false;
		const path = join(directory, "stream.snapshot");
		const block = encodeStringBlock(["text"]);
		const metadata = await writeSnapshotFile(
			path,
			{
				columns: [
					{
						name: "state",
						kind: "u8",
						load: async () => {
							previousLoaded = true;
							return new Uint8Array([7]);
						}
					},
					{
						name: "hot.b0",
						kind: "strings",
						domain: "hot",
						stringCount: 1,
						load: async () => {
							expect(previousLoaded).toBe(true);
							const file = await open(path, "r");
							try {
								const byte = new Uint8Array(1);
								await file.read(byte, 0, 1, 336);
								expect(byte[0]).toBe(7);
							} finally {
								await file.close();
							}
							return block;
						}
					},
					{ name: "hot.starts", kind: "u32", load: async () => new Uint32Array([0]) }
				]
			},
			0
		);
		expect(metadata.entries.get("state")!.checksum).toBe(snapshotChecksum(new Uint8Array([7])));
	});
});

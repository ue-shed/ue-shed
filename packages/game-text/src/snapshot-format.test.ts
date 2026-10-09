import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import {
	decodeSnapshotDirectory,
	decodeSnapshotSection,
	decodeStringBlock,
	encodeSnapshotDirectory,
	encodeStringBlock,
	snapshotChecksum,
	snapshotPayload,
	snapshotStringTableBuilder,
	snapshotDirectoryLength,
	SnapshotFormatError,
	MAX_SNAPSHOT_SECTION_BYTES,
	type SnapshotEntry
} from "./snapshot-format.js";

const payload = new Uint8Array([1, 2, 3, 4]);
const entry: SnapshotEntry = {
	name: "state",
	kind: "u8",
	codec: 0,
	offset: 144,
	storedLength: 4,
	rawLength: 4,
	count: 4,
	checksum: snapshotChecksum(payload),
	domain: "",
	stringCount: 0
};
const fixture = () => encodeSnapshotDirectory([entry], 148);
function repair(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer);
	view.setUint32(28, snapshotChecksum(bytes.subarray(48)), true);
	view.setUint32(32, snapshotChecksum(bytes.subarray(0, 32)), true);
}
describe("snapshot format", () => {
	it("cuts UTF-8 blocks by raw bytes and indexes variable ID ranges", () => {
		const builder = snapshotStringTableBuilder("source", 32);
		for (const text of ["éé", "😀", "", "longer than the target byte budget" + "é".repeat(20)])
			builder.intern(text);
		const columns = [...builder.finish()];
		const blocks = columns.filter((column) => column.kind === "strings");
		expect(
			blocks.map((column) => {
				if (!(column.values instanceof Uint8Array))
					throw new Error("Wrong string block kind");
				return decodeStringBlock(column.values).count;
			})
		).toEqual([3, 1]);
		expect(columns.at(-1)!.values).toEqual(new Uint32Array([0, 3]));
		expect(blocks[0]!.values.byteLength).toBeLessThanOrEqual(32);
		expect(blocks[1]!.values.byteLength).toBeGreaterThan(32);
	});
	it("round trips a directory, borrowed columns and deduplicated UTF-8 blocks", () => {
		const directory = decodeSnapshotDirectory(fixture(), 148);
		expect(decodeSnapshotSection(directory.entries.get("state")!, payload)).toBe(payload);
		const builder = snapshotStringTableBuilder("hot");
		expect(builder.intern("hé😀\uFEFF")).toBe(0);
		expect(builder.intern("")).toBe(1);
		expect(builder.intern("hé😀\uFEFF")).toBe(0);
		const block = [...builder.finish()][0]!;
		expect(decodeStringBlock(snapshotPayload(block)).string(0)).toBe("hé😀\uFEFF");
		expect(decodeStringBlock(snapshotPayload(block)).string(1)).toBe("");
		expect(snapshotChecksum(payload)).toBe(crc32(payload));
	});
	it.each([
		["magic", 0, 0],
		["version", 8, 99],
		["count zero", 12, 0],
		["count cap", 12, 1048577],
		["directory end", 24, 4],
		["header flags", 36, 1],
		["kind", 80, 99],
		["codec", 84, 2],
		["offset", 88, 145],
		["stored cap", 96, MAX_SNAPSHOT_SECTION_BYTES + 1],
		["raw cap", 100, MAX_SNAPSHOT_SECTION_BYTES + 1],
		["raw count", 104, 5],
		["directory flags", 140, 1],
		["unexpected domain count", 136, 1],
		["file length", 16, 149]
	] as const)("rejects %s with repaired CRCs before any allocation", (_, offset, value) => {
		const bytes = fixture();
		new DataView(bytes.buffer).setUint32(offset, value, true);
		repair(bytes);
		expect(() => decodeSnapshotDirectory(bytes, 148)).toThrow(SnapshotFormatError);
	});
	it.each([0, 7, 47, 48, 100, 143])("rejects directory truncation at %i", (length) => {
		expect(() => decodeSnapshotDirectory(fixture().subarray(0, length), 148)).toThrow(
			SnapshotFormatError
		);
	});
	it.each([0, 28, 32, 48, 79, 127])("rejects checksum or name damage at %i", (position) => {
		const bytes = fixture();
		bytes[position] = bytes[position]! ^ 1;
		expect(() => decodeSnapshotDirectory(bytes, 148)).toThrow(SnapshotFormatError);
	});
	it("rejects missing, extraneous and inconsistent domain blocks", () => {
		const block = encodeStringBlock([""]);
		const value: SnapshotEntry = {
			...entry,
			name: "hot.b0",
			kind: "strings",
			domain: "hot",
			stringCount: 1025,
			storedLength: block.length,
			rawLength: block.length,
			count: block.length
		};
		expect(() => encodeSnapshotDirectory([value], 144 + block.length)).toThrow(
			SnapshotFormatError
		);
		expect(() =>
			encodeSnapshotDirectory(
				[{ ...value, stringCount: 1, name: "hot.b1" }],
				144 + block.length
			)
		).toThrow(SnapshotFormatError);
	});
	it("checks payload CRC, lengths, string IDs and backing alignment", () => {
		expect(() => decodeSnapshotSection(entry, new Uint8Array(4))).toThrow(SnapshotFormatError);
		expect(() => decodeSnapshotSection(entry, payload.subarray(0, 3))).toThrow(
			SnapshotFormatError
		);
		const ids = new Uint32Array([2]);
		const bytes = new Uint8Array(ids.buffer);
		expect(() =>
			decodeSnapshotSection(
				{
					...entry,
					kind: "stringIds",
					count: 1,
					stringCount: 2,
					checksum: snapshotChecksum(bytes)
				},
				bytes
			)
		).toThrow(SnapshotFormatError);
		expect(() =>
			snapshotPayload({
				name: "id",
				kind: "stringIds",
				values: ids,
				domain: "hot",
				stringCount: 2
			})
		).toThrow(SnapshotFormatError);
		expect(() => snapshotPayload({ name: "wrong", kind: "u32", values: payload })).toThrow(
			SnapshotFormatError
		);
		const unaligned = new Uint8Array(5).subarray(1);
		expect(() =>
			decodeSnapshotSection(
				{ ...entry, kind: "u32", count: 1, checksum: snapshotChecksum(unaligned) },
				unaligned
			)
		).toThrow(SnapshotFormatError);
	});
	it.each(["count", "endpoint", "order", "utf8", "split", "short"] as const)(
		"validates string block %s",
		(fault) => {
			const bytes = encodeStringBlock(["é", "a"]);
			const view = new DataView(bytes.buffer);
			if (fault === "count") view.setUint32(0, 33554431, true);
			if (fault === "endpoint") view.setUint32(4, 1, true);
			if (fault === "order") view.setUint32(8, 99, true);
			if (fault === "utf8") bytes[16] = 255;
			if (fault === "split") view.setUint32(8, 1, true);
			expect(() =>
				decodeStringBlock(fault === "short" ? bytes.subarray(0, 7) : bytes)
			).toThrow(SnapshotFormatError);
		}
	);
	it("caps header-derived allocation and string lookups", () => {
		const bytes = fixture();
		new DataView(bytes.buffer).setBigUint64(16, 0xffffffffffffffffn, true);
		repair(bytes);
		expect(() => snapshotDirectoryLength(bytes.subarray(0, 48))).toThrow(SnapshotFormatError);
		for (const id of [-1, 1, NaN, 0.5])
			expect(() => decodeStringBlock(encodeStringBlock([""])).string(id)).toThrow(
				SnapshotFormatError
			);
		expect(() => encodeStringBlock([])).toThrow(SnapshotFormatError);
		expect(() => snapshotStringTableBuilder().intern("a".repeat(1024 * 1024 + 1))).toThrow(
			SnapshotFormatError
		);
	});
});

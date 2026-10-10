import { describe, expect, it } from "vitest";
import {
	encodeA64,
	decodeA64,
	sortBytes,
	packedStrings,
	stringBytes
} from "./shared-string-codec.js";
import { SnapshotFormatError } from "./snapshot-format.js";

describe("A64 byte dictionary", () => {
	it("round trips GUID bytes with exact mixed case and noncanonical keys", () => {
		const values = [
			"",
			"00000000000000000000000000000000",
			"0123456789abcdefABCDEF0123456789ab",
			"ABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
			"01234567-89ab-cdef-0123-456789abcdef",
			"g123456789abcdef0123456789abcdef0",
			"f".repeat(31),
			"f".repeat(33),
			"🦋 café\u0000"
		];
		const encoded = encodeA64(values.map((s) => Buffer.from(s)));
		expect(decodeA64(encoded).map((b) => b.toString())).toEqual(values);
		expect(encodeA64([Buffer.from("f".repeat(32))]).length).toBe(18);
		expect(encodeA64([Buffer.from("F".repeat(32))]).length).toBe(22);
	});
	it("matches the UTF-8 byte oracle at every block boundary", () => {
		const values = Array.from(
			{ length: 1025 },
			(_, i) => `${i % 7}:${i.toString(16).padStart(32, "0")}:é`
		);
		const packed = packedStrings(values),
			order = sortBytes(packed);
		const expected = values.map((s) => Buffer.from(s)).sort(Buffer.compare);
		for (let start = 0; start < order.length; start += 64) {
			const actual = decodeA64(
				encodeA64(
					Array.from(order.subarray(start, start + 64), (id) => stringBytes(packed, id))
				)
			);
			expect(actual).toEqual(expected.slice(start, start + 64));
		}
	});
	it("reports typed failures for counts, tags, varints, suffixes, UTF-8 and case masks", () => {
		for (const bytes of [
			Buffer.of(0),
			Buffer.of(65),
			Buffer.of(1, 3),
			Buffer.of(1, 0, 1, 0),
			Buffer.of(1, 0, 0, 1),
			Buffer.of(1, 0, 0, 1, 255),
			Buffer.of(1, 1),
			Buffer.of(1, 0, 128, 128, 128, 128, 128, 0),
			Buffer.concat([Buffer.of(1, 2), Buffer.alloc(16), Buffer.of(1, 0, 0, 0)]),
			Buffer.concat([encodeA64([Buffer.from("ok")]), Buffer.of(0)])
		])
			expect(() => decodeA64(bytes)).toThrow(SnapshotFormatError);
	});
});

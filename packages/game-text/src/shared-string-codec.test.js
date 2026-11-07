import { describe, expect, it } from "vitest";
import { encodeA64, decodeA64, decodeA64Into, sortBytes, packedStrings, stringBytes, packedStringReader, sortPackedStringsByLocale, sortPackedStringsByLocaleSteps, validatePackedStrings } from "./shared-string-codec.js";
import { StringArena } from "./shared-string-codec.js";
import { HostSliceClock, runHostStepsSync } from "./host-slices.js";
it("gives cached decode arenas their own backing buffer through growth", () => {
    const arena = new StringArena(1024, 64, true);
    arena.add(Uint8Array.of(65));
    const first = arena.finish();
    expect(first.bytes.buffer.byteLength).toBe(1024);
    arena.add(new Uint8Array(1500).fill(66));
    const grown = arena.finish();
    expect(grown.bytes.buffer.byteLength).toBe(2048);
    expect(grown.bytes[0]).toBe(65);
    expect(grown.offsets[2]).toBe(1501);
});
it("orders locale ties the same for every run size and slice budget", () => {
    const words = ["á", "á", "A", "a", "b", "B", "é", "é", ""];
    const values = Array.from({ length: 5000 }, (_, row) => words[(row * 7919) % words.length]);
    const packed = packedStrings(values);
    const expected = Array.from(sortPackedStringsByLocale(packed));
    for (const runSize of [1, 3, 64, 1024]) {
        const steps = sortPackedStringsByLocaleSteps(packed, undefined, runSize, new HostSliceClock(0, 1));
        expect(Array.from(runHostStepsSync(steps))).toEqual(expected);
    }
});
import { SnapshotFormatError } from "./snapshot-format.js";
describe("A64 byte dictionary", () => {
    it("validates individual boundaries in UTF-8 and separate lone surrogate entries", () => {
        expect(() => validatePackedStrings({ bytes: Buffer.of(0xc3, 0xa9), offsets: Uint32Array.of(0, 1, 2) }, "fixture")).toThrow("Invalid packed string boundary");
        expect(() => validatePackedStrings(packedStrings(["", "\ud800", "\udc00", "\ud83d\ude00"]), "fixture")).not.toThrow();
        expect(() => validatePackedStrings({ bytes: Buffer.of(97, 98), offsets: Uint32Array.of(0, 3, 2) }, "fixture")).toThrow("Invalid packed string range");
    });
    it("merges bounded locale runs with the same stable order as the string oracle", () => {
        const alphabet = [
            "",
            "a",
            "A",
            "\u00e9",
            "e\u0301",
            "\ud800",
            "\udc00",
            "\ud83d\ude00",
            "10",
            "2"
        ];
        const values = Array.from({ length: 207 }, (_, row) => `${alphabet[(row * 17) % alphabet.length]}:${row % 7}`);
        const packed = packedStrings(values);
        for (const runSize of [1, 7, 32, 8192]) {
            const order = Uint32Array.from({ length: values.length }, (_, row) => values.length - 1 - row);
            const original = order.slice();
            const expected = order.slice().sort((a, b) => values[a].localeCompare(values[b]));
            expect(sortPackedStringsByLocale(packed, order, runSize)).toEqual(expected);
            expect(order).toEqual(original);
        }
        expect(sortPackedStringsByLocale(packedStrings([]))).toEqual(new Uint32Array());
        expect(() => sortPackedStringsByLocale(packed, undefined, 0)).toThrow("Invalid sort run size");
    });
    it("the bounded comparator reader preserves repeated Unicode and lone surrogate IDs", () => {
        const values = ["", "é", "😀", "\ud800", "\udc00", "ABC", "tail"];
        const read = packedStringReader(packedStrings(values));
        for (const row of [0, 1, 0, 1, 2, 3, 2, 4, 5, 6, 0, 3])
            expect(read(row)).toBe(values[row]);
        const order = values.map((_, row) => row).sort((a, b) => read(a).localeCompare(read(b)));
        expect(order).toEqual(values.map((_, row) => row).sort((a, b) => values[a].localeCompare(values[b])));
    });
    it("expands directly into contiguous UTF-8 and rejects invalid entry boundaries", () => {
        const values = ["", "café", "caféteria", "ABCDEF0123456789abcdef0123456789", "😀", "tail"];
        const packed = packedStrings(values), output = {
            bytes: Buffer.alloc(packed.bytes.length),
            offsets: new Uint32Array(values.length + 1)
        };
        expect(decodeA64Into(encodeA64(values.map((value) => Buffer.from(value))), output, 0)).toBe(values.length);
        expect(output.bytes).toEqual(packed.bytes);
        expect(Array.from(output.offsets)).toEqual(Array.from(packed.offsets));
        // Concatenation would be valid UTF-8, but neither entry is valid by itself.
        expect(() => decodeA64Into(Buffer.of(2, 0, 0, 1, 0xc3, 0, 0, 1, 0xa9), { bytes: Buffer.alloc(2), offsets: new Uint32Array(3) }, 0)).toThrow(SnapshotFormatError);
    });
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
        const values = Array.from({ length: 1025 }, (_, i) => `${i % 7}:${i.toString(16).padStart(32, "0")}:é`);
        const packed = packedStrings(values), order = sortBytes(packed);
        const expected = values.map((s) => Buffer.from(s)).sort(Buffer.compare);
        const contiguous = {
            bytes: Buffer.alloc(packed.bytes.length),
            offsets: new Uint32Array(values.length + 1)
        };
        for (let start = 0; start < order.length; start += 64) {
            const block = encodeA64(Array.from(order.subarray(start, start + 64), (id) => stringBytes(packed, id)));
            const actual = decodeA64(block);
            decodeA64Into(block, contiguous, start);
            expect(actual).toEqual(expected.slice(start, start + 64));
        }
        expect(contiguous.bytes).toEqual(Buffer.concat(expected));
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
        ]) {
            expect(() => decodeA64(bytes)).toThrow(SnapshotFormatError);
            expect(() => decodeA64Into(bytes, { bytes: Buffer.alloc(1024), offsets: new Uint32Array(65) }, 0)).toThrow(SnapshotFormatError);
        }
    });
});

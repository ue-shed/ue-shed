import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { decodeWtf8, encodeWtf8, isWtf8 } from "./wtf8.js";
import { a64Cursor, decodeA64Into, encodeA64, packedStrings } from "./shared-string-codec.js";
import { decodeStringBlock, encodeStringBlock, SnapshotFormatError, SNAPSHOT_VERSION } from "./snapshot-format.js";
import { openSnapshotFile } from "./snapshot-file.js";
const Golden = Schema.Struct({
    formatVersion: Schema.Number,
    magic: Schema.String,
    cases: Schema.Array(Schema.Struct({
        name: Schema.String,
        units: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff }))),
        hex: Schema.String,
        valid: Schema.Boolean
    }))
});
const directory = new URL("../../../fixtures/game-text-wtf8/", import.meta.url);
const golden = Schema.decodeSync(Schema.fromJsonString(Golden))(await readFile(new URL("golden.json", directory), "utf8"));
const values = golden.cases
    .filter((item) => item.valid)
    .map((item) => String.fromCharCode(...item.units));
describe("canonical WTF-8 shared golden bytes", () => {
    it.each(golden.cases)("$name", async ({ name, units, hex, valid }) => {
        const bytes = await readFile(new URL(`${name}.bin`, directory));
        expect(bytes.toString("hex")).toBe(hex);
        expect(isWtf8(bytes)).toBe(valid);
        if (valid) {
            const value = String.fromCharCode(...units);
            expect(decodeWtf8(bytes)).toBe(value);
            expect(Buffer.from(encodeWtf8(value)).toString("hex")).toBe(hex);
        }
        else
            expect(() => decodeWtf8(bytes)).toThrow();
    });
    it("preserves independent lone surrogates across string and A64 block boundaries", () => {
        const entries = [...values, "\ud800", "\udc00", "\ufeff"];
        const block = decodeStringBlock(encodeStringBlock(entries), "golden.b0");
        expect(entries.map((_, id) => block.string(id))).toEqual(entries);
        const packed = packedStrings(entries);
        const output = {
            bytes: Buffer.alloc(packed.bytes.length),
            offsets: new Uint32Array(entries.length + 1)
        };
        decodeA64Into(encodeA64(entries.map((value) => Buffer.from(encodeWtf8(value)))), output, 0);
        expect(entries.map((_, id) => decodeWtf8(output.bytes.subarray(output.offsets[id], output.offsets[id + 1])))).toEqual(entries);
        const encoded = encodeA64([Buffer.from("eda080edb080", "hex")]);
        expect(() => a64Cursor(encoded).next()).toThrow(SnapshotFormatError);
        expect(() => decodeA64Into(encoded, { bytes: Buffer.alloc(6), offsets: new Uint32Array(2) }, 0)).toThrow(SnapshotFormatError);
    });
    it.each(["typescript.snapshot", "rust.snapshot"])("reads the shared %s snapshot", async (name) => {
        const reader = await openSnapshotFile(new URL(name, directory).pathname.replace(/^\/([A-Z]:)/u, "$1"));
        try {
            expect(reader.directory.version).toBe(SNAPSHOT_VERSION);
            expect(golden.formatVersion).toBe(SNAPSHOT_VERSION);
            expect(await reader.strings("golden", values.map((_, id) => id))).toEqual(values);
        }
        finally {
            await reader.close();
        }
    });
});

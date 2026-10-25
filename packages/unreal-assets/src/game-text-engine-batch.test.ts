import { describe, expect, it } from "vitest";
import type { GameTextContract } from "@ue-shed/protocol";
import { EngineBatch } from "./game-text-engine-batch.js";

/** Lays out buffers as the engine does: each 8-aligned, after an 8-aligned header. */
function body(header: (offsets: number[]) => object, buffers: readonly Uint8Array[]) {
	const offsets: number[] = [];
	let size = 0;
	for (const buffer of buffers) {
		offsets.push(size);
		size = Math.ceil((size + buffer.byteLength) / 8) * 8;
	}
	const json = new TextEncoder().encode(JSON.stringify(header(offsets)));
	const start = Math.ceil((4 + json.byteLength) / 8) * 8;
	const bytes = new Uint8Array(start + size);
	new DataView(bytes.buffer).setUint32(0, json.byteLength, true);
	bytes.set(json, 4);
	buffers.forEach((buffer, index) => bytes.set(buffer, start + offsets[index]!));
	return bytes.buffer;
}
const u32 = (...values: number[]) => new Uint8Array(new Uint32Array(values).buffer);
const f64 = (...values: number[]) => new Uint8Array(new Float64Array(values).buffer);

describe("EngineBatch", () => {
	it("reads every column type, missing values and lone surrogates through views", () => {
		// Entries: "de" after a U+FEFF that is text, not a byte order mark; "a" and a lone high
		// surrogate (WTF-8 ED A0 80); and JSON text.
		const entries = [
			new TextEncoder().encode("﻿de"),
			new Uint8Array([0x61, 0xed, 0xa0, 0x80]),
			new TextEncoder().encode('{"kind":"x","n":[1]}')
		];
		const stringBytes = new Uint8Array(entries.reduce((sum, entry) => sum + entry.length, 0));
		const stringOffsets = [0];
		for (const entry of entries) {
			stringBytes.set(entry, stringOffsets.at(-1)!);
			stringOffsets.push(stringOffsets.at(-1)! + entry.length);
		}
		const buffers = [
			u32(0, 2, 3), // key list offsets: row 0 has two entries, row 1 one
			u32(0, 1, 0), // their string-table indices
			u32(3, 1), // lines
			f64(2.5, 0), // sourceWords
			new Uint8Array([0b01]), // sourceWords validity
			u32(2, 2), // data: JSON cells
			new Uint8Array([0b11]), // flag bits
			u32(...stringOffsets),
			stringBytes,
			new Uint8Array([0b010])
		];
		const batch = new EngineBatch<"group">(
			body(
				(at) =>
					({
						part: "groups",
						relation: "group",
						rows: 2,
						columns: [
							{
								name: "key",
								type: "strList",
								offset: at[0]!,
								values: at[1]!,
								missing: "never"
							},
							{ name: "lines", type: "u32", offset: at[2]!, missing: "never" },
							{
								name: "sourceWords",
								type: "f64",
								offset: at[3]!,
								validity: at[4]!,
								missing: "omit"
							},
							{ name: "data", type: "json", offset: at[5]!, missing: "never" },
							{ name: "flag", type: "bool", offset: at[6]!, missing: "never" }
						],
						strings: {
							entries: 3,
							offsets: at[7]!,
							bytes: at[8]!,
							loneSurrogates: at[9]!
						}
					}) satisfies GameTextContract.BatchHeader,
				buffers
			)
		);
		expect(batch.part).toBe("groups");
		expect(batch.rows).toBe(2);
		expect(batch.columns).toEqual(["key", "lines", "sourceWords", "data", "flag"]);
		expect(Array.from(batch.numbers("lines"))).toEqual([3, 1]);
		expect(batch.cell(0, "key")).toEqual(["﻿de", "a\ud800"]);
		expect(batch.cell(1, "sourceWords")).toBeUndefined();
		expect(batch.row(0)).toEqual({
			key: ["﻿de", "a\ud800"],
			lines: 3,
			sourceWords: 2.5,
			data: { kind: "x", n: [1] },
			flag: true
		});
		// The row's keys follow the batch's column order; a missing value omits its key.
		expect(Object.keys(batch.row(1))).toEqual(["key", "lines", "data", "flag"]);
		expect(batch.objects()).toHaveLength(2);
	});
});

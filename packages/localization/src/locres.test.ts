import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { parseArchive, parseManifest } from "./json-formats.js";
import { parseLocres } from "./locres.js";
import { defaultLocalizationLimits } from "./schema.js";

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}
function failureCode<A>(result: Result.Result<A, { readonly code: string }>) {
	return Result.isFailure(result) ? result.failure.code : "succeeded";
}
const localization = (project: string, target: string, culture: string, extension: string) =>
	resolve("fixtures", project, "Content/Localization", target, culture, `${target}.${extension}`);

const magic = [
	0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc, 0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37, 0x7f, 0x1b
];
interface Entry {
	readonly namespace: string;
	readonly key: string;
	readonly sourceHash: number;
	readonly text: string;
}
/** Writes the layouts FTextLocalizationResource::SaveToArchive produces, for round trips. */
function encode(version: 0 | 1 | 2 | 3, entries: readonly Entry[]) {
	const out: number[] = [];
	const int32 = (value: number) => {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setInt32(0, value, true);
		out.push(...bytes);
	};
	const fstring = (value: string) => {
		if (value === "") return int32(0);
		const ansi = [...value].every((character) => character.charCodeAt(0) < 0x80);
		if (ansi) {
			int32(value.length + 1);
			for (const character of value) out.push(character.charCodeAt(0));
			out.push(0);
		} else {
			int32(-(value.length + 1));
			for (let index = 0; index < value.length; index++) {
				const unit = value.charCodeAt(index);
				out.push(unit & 0xff, unit >> 8);
			}
			out.push(0, 0);
		}
	};
	const texts = [...new Set(entries.map((entry) => entry.text))];
	const namespaces = [...new Set(entries.map((entry) => entry.namespace))];
	let offsetAt = -1;
	if (version >= 1) {
		out.push(...magic, version);
		offsetAt = out.length;
		out.push(0, 0, 0, 0, 0, 0, 0, 0);
	}
	if (version >= 2) int32(entries.length);
	int32(namespaces.length);
	for (const namespace of namespaces) {
		if (version >= 2) int32(0x1234);
		fstring(namespace);
		const keys = entries.filter((entry) => entry.namespace === namespace);
		int32(keys.length);
		for (const entry of keys) {
			if (version >= 2) int32(0x5678);
			fstring(entry.key);
			int32(entry.sourceHash | 0);
			if (version >= 1) int32(texts.indexOf(entry.text));
			else fstring(entry.text);
		}
	}
	if (version >= 1) {
		const offset = out.length;
		const view = new DataView(new ArrayBuffer(8));
		view.setBigInt64(0, BigInt(offset), true);
		for (let index = 0; index < 8; index++) out[offsetAt + index] = view.getUint8(index);
		int32(texts.length);
		for (const text of texts) {
			fstring(text);
			if (version >= 2) int32(entries.filter((entry) => entry.text === text).length);
		}
	}
	return Uint8Array.from(out);
}
const sample: readonly Entry[] = [
	{
		namespace: "ST_Hex",
		key: "endscreen_stat_kills",
		sourceHash: 0xdeadbeef,
		text: "Jumlah Bunuh"
	},
	{ namespace: "ST_Hex", key: "endscreen_stat_timealive", sourceHash: 1, text: "Waktu Hidup" },
	{ namespace: "", key: "Greeting", sourceHash: 2, text: "こんにちは、世界" },
	{ namespace: "Shared", key: "Same", sourceHash: 3, text: "Jumlah Bunuh" }
];

describe("compiled localization resources", () => {
	for (const [project, target, cultures] of [
		["unreal-project", "FixtureGame", ["de", "en", "fr"]],
		["unreal-project", "Game", ["de", "en", "fr", "ja"]],
		["unreal-427-localization", "Fixture427", ["de", "en", "fr"]]
	] as const) {
		for (const culture of cultures) {
			it(`reads Unreal's ${target}/${culture} and agrees with its archive`, () => {
				const resource = success(
					parseLocres(readFileSync(localization(project, target, culture, "locres")))
				);
				expect(resource.version).toBe(3);
				// 4.27 leaves untranslated entries out, so only the native culture is never empty.
				if (culture === "en") expect(resource.entries.length).toBeGreaterThan(0);
				const manifest = success(
					parseManifest(
						readFileSync(
							resolve(
								"fixtures",
								project,
								"Content/Localization",
								target,
								`${target}.manifest`
							)
						)
					)
				);
				const archive = success(
					parseArchive(readFileSync(localization(project, target, culture, "archive")))
				);
				const id = (entry: { namespace: string; key: string }) =>
					`${entry.namespace}\u0000${entry.key}`;
				const sources = new Map(
					manifest.entries.map((entry) => [id(entry), entry.source.Text])
				);
				const archived = new Map(archive.entries.map((entry) => [id(entry), entry]));
				// Unreal compiles a translation only when it was made from the current source;
				// otherwise, and for an empty translation, the resource holds the source itself.
				for (const entry of resource.entries) {
					const source = sources.get(id(entry));
					const translated = archived.get(id(entry));
					const current =
						translated !== undefined &&
						translated.source.Text === source &&
						translated.translation.Text !== "";
					expect(entry.text).toBe(current ? translated.translation.Text : source);
				}
			});
		}
	}

	for (const version of [0, 1, 2, 3] as const) {
		it(`round-trips version ${version}, including UTF-16 text and shared strings`, () => {
			expect(success(parseLocres(encode(version, sample)))).toEqual({
				version,
				entries: sample
			});
		});
	}

	it("reads an empty resource", () => {
		expect(success(parseLocres(encode(3, [])))).toEqual({ version: 3, entries: [] });
	});

	it("refuses truncated, padded, unknown and duplicated input", () => {
		const bytes = encode(3, sample);
		for (let length = 0; length < bytes.length; length++)
			expect(failureCode(parseLocres(bytes.subarray(0, length)))).not.toBe("succeeded");
		expect(failureCode(parseLocres(Uint8Array.from([...bytes, 0])))).toBe("malformed_locres");
		const newer = Uint8Array.from(bytes);
		newer[16] = 4;
		expect(failureCode(parseLocres(newer))).toBe("unsupported_version");
		const duplicated = encode(2, [sample[0]!, { ...sample[0]!, text: "Lagi" }]);
		expect(failureCode(parseLocres(duplicated))).toBe("malformed_locres");
	});

	it("refuses a text index outside the string table", () => {
		const bytes = encode(1, [sample[0]!]);
		// The single entry's text index is the four bytes just before the string table.
		const view = new DataView(bytes.buffer);
		const tableOffset = Number(view.getBigInt64(17, true));
		view.setInt32(tableOffset - 4, 5, true);
		expect(failureCode(parseLocres(bytes))).toBe("malformed_locres");
	});

	it("applies the reader's size and entry limits", () => {
		const bytes = encode(3, sample);
		expect(
			failureCode(parseLocres(bytes, { ...defaultLocalizationLimits, maxFileBytes: 16 }))
		).toBe("limit_exceeded");
		expect(
			failureCode(parseLocres(bytes, { ...defaultLocalizationLimits, maxEntries: 2 }))
		).toBe("limit_exceeded");
	});
});

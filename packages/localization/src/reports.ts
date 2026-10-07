import { Schema } from "effect";
import {
	checkSize,
	decodeText,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import {
	CultureCode,
	LocalizationMeta,
	WordCountReport,
	type LocalizationLimits
} from "./schema.js";

// Unreal's serialized FGuid, expressed as bytes rather than a host-endian integer.
const locmetaMagic = [
	0x4f, 0xee, 0x4c, 0xa1, 0x68, 0x48, 0x55, 0x83, 0x6c, 0x4c, 0x46, 0xbd, 0x70, 0xda, 0x50, 0x7c
];

export function parseLocmeta(bytes: Uint8Array, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		checkSize(bytes, limits);
		const fail = (): never => {
			throw localizationError("malformed_locmeta");
		};
		if (bytes.length < 17 || !locmetaMagic.every((byte, index) => bytes[index] === byte))
			fail();
		const version = bytes[16];
		if (version !== 0 && version !== 1 && version !== 2)
			throw localizationError("unsupported_version");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let cursor = 17;
		const int32 = () => {
			if (cursor + 4 > bytes.length) return fail();
			const value = view.getInt32(cursor, true);
			cursor += 4;
			return value;
		};
		const string = () => {
			const count = int32();
			if (count === 0) return "";
			const width = count < 0 ? 2 : 1;
			const length = Math.abs(count) * width;
			if (cursor + length > bytes.length || length < width) return fail();
			const data = bytes.subarray(cursor, cursor + length);
			cursor += length;
			if (data.at(-1) !== 0 || (width === 2 && data.at(-2) !== 0)) return fail();
			try {
				if (width === 1)
					return Array.from(data.subarray(0, -1), (byte) =>
						String.fromCharCode(byte)
					).join("");
				return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(
					data.subarray(0, -2)
				);
			} catch {
				return fail();
			}
		};
		const nativeCulture = string();
		const nativeLocresPath = string();
		const count = version >= 1 ? int32() : 0;
		if (count < 0) fail();
		if (count > limits.maxEntries) throw localizationError("limit_exceeded");
		const compiledCultures = Array.from({ length: count }, () => string());
		const ugc = version >= 2 ? int32() : 0;
		if (ugc !== 0 && ugc !== 1) fail();
		if (cursor !== bytes.length) fail();
		return immutable(
			validate(
				LocalizationMeta,
				{ version, nativeCulture, nativeLocresPath, compiledCultures, isUGC: ugc === 1 },
				"malformed_locmeta"
			)
		);
	});
}

function csvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let closed = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {
				cell += '"';
				index++;
			} else if (character === '"') {
				quoted = false;
				closed = true;
			} else cell += character;
			continue;
		}
		if (character === ",") {
			row.push(cell);
			cell = "";
			closed = false;
		} else if (character === "\r" || character === "\n") {
			if (character === "\r" && text[index + 1] === "\n") index++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			closed = false;
		} else if (character === '"' && cell === "" && !closed) quoted = true;
		else if (closed || character === '"') throw localizationError("malformed_csv");
		else cell += character;
	}
	if (quoted) throw localizationError("malformed_csv");
	if (row.length > 0 || cell !== "") {
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

export function parseWordCountCSV(bytes: Uint8Array, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		const rows = csvRows(decodeText(bytes, limits));
		const header = rows.shift();
		if (header?.[0] !== "Date/Time" || header[1] !== "Word Count")
			throw localizationError("malformed_csv");
		const cultures = header
			.slice(2)
			.map((culture) => validate(CultureCode, culture, "malformed_csv"));
		if (new Set(cultures).size !== cultures.length) throw localizationError("malformed_csv");
		if (rows.length > limits.maxEntries || cultures.length > limits.maxEntries)
			throw localizationError("limit_exceeded");
		const count = (value: string | undefined) => {
			if (
				value === undefined ||
				!/^\d+$/u.test(value) ||
				!Number.isSafeInteger(Number(value))
			)
				throw localizationError("malformed_csv");
			return Number(value);
		};
		return immutable(
			validate(
				WordCountReport,
				{
					cultures,
					rows: rows.map((row) => {
						if (row.length !== header.length) throw localizationError("malformed_csv");
						return {
							dateTime: validate(Schema.NonEmptyString, row[0], "malformed_csv"),
							wordCount: count(row[1]),
							cultureWordCounts: Object.fromEntries(
								cultures.map((culture, index) => [culture, count(row[index + 2])])
							)
						};
					})
				},
				"malformed_csv"
			)
		);
	});
}

import {
	checkSize,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import { LocalizationResource, type LocalizationLimits } from "./schema.js";

// FTextLocalizationResource's magic GUID, as serialized bytes. Version 0 files have none.
const locresMagic = [
	0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc, 0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37, 0x7f, 0x1b
];

/**
 * Decodes a bounded compiled `.locres`: versions 0 (legacy), 1 (compact), 2 (CRC32 keys) and
 * 3 (CityHash64 keys). Namespace and key hashes are skipped; texts resolve through the
 * string table without hashing. Every byte must be accounted for, and a namespace/key pair
 * may appear once. Returns a typed Result; it does not compile or regenerate resources.
 */
export function parseLocres(bytes: Uint8Array, options?: LocalizationLimits) {
	return parseResult(() => {
		const limits = limitsFor(options);
		checkSize(bytes, limits);
		const fail = (): never => {
			throw localizationError("malformed_locres");
		};
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let cursor = 0;
		const need = (size: number) => {
			if (cursor + size > bytes.length) fail();
		};
		const int32 = () => {
			need(4);
			const value = view.getInt32(cursor, true);
			cursor += 4;
			return value;
		};
		const uint32 = () => {
			need(4);
			const value = view.getUint32(cursor, true);
			cursor += 4;
			return value;
		};
		const count = () => {
			const value = int32();
			if (value < 0) fail();
			if (value > limits.maxEntries) throw localizationError("limit_exceeded");
			return value;
		};
		// FString: a positive length is ANSI, a negative one UTF-16; both include the terminator.
		const string = () => {
			const length = int32();
			if (length === 0) return "";
			const width = length < 0 ? 2 : 1;
			const size = Math.abs(length) * width;
			need(size);
			const data = bytes.subarray(cursor, cursor + size);
			cursor += size;
			if (data.at(-1) !== 0 || (width === 2 && data.at(-2) !== 0)) fail();
			if (width === 1)
				return Array.from(data.subarray(0, -1), (byte) => String.fromCharCode(byte)).join(
					""
				);
			try {
				return new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(
					data.subarray(0, -2)
				);
			} catch {
				return fail();
			}
		};

		const hasMagic =
			bytes.length >= 17 && locresMagic.every((byte, index) => bytes[index] === byte);
		let version = 0;
		if (hasMagic) {
			version = bytes[16] ?? 0;
			if (version < 1 || version > 3) throw localizationError("unsupported_version");
			cursor = 17;
		}

		// Compact and later keep each text once, in a table after the namespaces.
		let texts: string[] | undefined;
		let tableStart = bytes.length;
		if (version >= 1) {
			need(8);
			const offset = view.getBigInt64(cursor, true);
			cursor += 8;
			const afterHeader = cursor;
			if (offset !== -1n) {
				if (offset < BigInt(afterHeader) || offset > BigInt(bytes.length)) fail();
				tableStart = Number(offset);
				cursor = tableStart;
				const size = count();
				texts = [];
				for (let index = 0; index < size; index++) {
					texts.push(string());
					if (version >= 2) int32(); // How many keys share this text.
				}
				if (cursor !== bytes.length) fail();
			}
			cursor = afterHeader;
		}
		if (version >= 2) uint32(); // Total entry count, a reserve hint.

		const entries: { namespace: string; key: string; sourceHash: number; text: string }[] = [];
		const seen = new Set<string>();
		const namespaces = count();
		for (let n = 0; n < namespaces; n++) {
			if (version >= 2) uint32(); // Namespace hash.
			const namespace = string();
			const keys = count();
			if (entries.length + keys > limits.maxEntries)
				throw localizationError("limit_exceeded");
			for (let k = 0; k < keys; k++) {
				if (version >= 2) uint32(); // Key hash.
				const key = string();
				const sourceHash = uint32();
				let text: string;
				if (version >= 1) {
					const index = int32();
					text = texts?.[index] ?? fail();
				} else text = string();
				const identity = `${namespace}\u0000${key}`;
				if (seen.has(identity)) fail();
				seen.add(identity);
				entries.push({ namespace, key, sourceHash, text });
			}
		}
		if (cursor !== tableStart) fail();
		return immutable(validate(LocalizationResource, { version, entries }, "malformed_locres"));
	});
}

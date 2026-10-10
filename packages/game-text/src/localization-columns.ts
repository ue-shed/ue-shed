import { openSync, closeSync, readSync, writeSync } from "node:fs";
import { Schema, Effect, Result } from "effect";
import {
	ArchiveEntry,
	ManifestEntry,
	POEntry,
	LocalizationText,
	OpaqueRecord,
	parsePOBlock,
	parsePOIdentity,
	TextNamespace,
	TextKey,
	type LocalizationCollapseMode,
	type POFormat,
	type POLine
} from "@ue-shed/localization";
import { encodeStringBlock, decodeStringBlock } from "./snapshot-format.js";
import type { SnapshotSource, SnapshotSourceColumn } from "./snapshot-file.js";
import type { SnapshotReader } from "./snapshot-store.js";
import {
	importFailure,
	localizationJsonStream,
	localizationPOStream,
	type LocalizationImportLimits
} from "./localization-stream.js";

export type LocalizationFileFormat = "manifest" | "archive" | "po";
export interface LocalizationImportOptions {
	readonly format: LocalizationFileFormat;
	readonly poFormat?: POFormat;
	readonly collapseMode?: LocalizationCollapseMode;
}
const Key = Schema.Struct({
	Key: Schema.String,
	Path: Schema.String,
	Optional: Schema.optionalKey(Schema.Boolean),
	MetaData: Schema.optionalKey(OpaqueRecord),
	DevNotes: Schema.optionalKey(Schema.String)
});
const ManifestChild = Schema.Struct({ Source: LocalizationText, Keys: Schema.Array(Key) });
const ArchiveChild = Schema.Struct({
	Source: LocalizationText,
	Translation: LocalizationText,
	Key: Schema.String,
	Optional: Schema.optionalKey(Schema.Boolean),
	MetaData: Schema.optionalKey(OpaqueRecord)
});
const decodeManifestChild = Schema.decodeUnknownResult(ManifestChild);
const decodeArchiveChild = Schema.decodeUnknownResult(ArchiveChild);
const decodePOComments = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const Meta = Schema.Struct({
	format: Schema.Literals(["manifest", "archive", "po"]),
	count: Schema.Int,
	poFormat: Schema.Literals(["Unreal", "Crowdin"]),
	hasSourceText: Schema.Boolean,
	pathPrefix: Schema.optionalKey(Schema.String)
});
const fields = [
	"namespace",
	"key",
	"source",
	"translation",
	"path",
	"notes",
	"metadata",
	"source-extra",
	"translation-extra",
	"po-extra",
	"options",
	"ordinal"
] as const;
type Field = (typeof fields)[number];
const domains = {
	namespace: "identity",
	key: "identity",
	source: "source",
	translation: "translation",
	path: "paths",
	notes: "comments",
	metadata: "comments",
	"source-extra": "comments",
	"translation-extra": "comments",
	"po-extra": "comments"
} satisfies Record<Exclude<Field, "options" | "ordinal">, string>;

/** Block-local deduplication bounds retained authored strings independently of input length. */
function spilledDomain(
	domain: string,
	handle: number,
	cursor: { offset: number },
	limits: LocalizationImportLimits,
	file: string
) {
	const blocks: Omit<SnapshotSourceColumn, "stringCount">[] = [];
	const starts: number[] = [];
	let strings: string[] = [];
	let ids = new Map<string, number>();
	let bytes = 8;
	let count = 0;
	function flush() {
		if (!strings.length) return;
		const payload = encodeStringBlock(strings);
		const length = payload.length;
		const offset = cursor.offset;
		let written = 0;
		while (written < payload.length)
			written += writeSync(
				handle,
				payload,
				written,
				payload.length - written,
				offset + written
			);
		cursor.offset += payload.length;
		if (cursor.offset > limits.maxFileBytes) throw importFailure(file, "limit_exceeded");
		starts.push(count - strings.length);
		blocks.push({
			name: `${domain}.b${blocks.length}`,
			kind: "strings",
			domain,
			compressionLevel: domain === "paths" ? 9 : 3,
			load: async () => {
				const value = new Uint8Array(length);
				let read = 0;
				while (read < value.length) {
					const size = readSync(handle, value, read, value.length - read, offset + read);
					if (!size) throw importFailure(file, "file_changed");
					read += size;
				}
				return value;
			}
		});
		strings = [];
		ids = new Map();
		bytes = 8;
	}
	return {
		add(value: string) {
			if (value === "" && count > 0) return 0;
			const existing = ids.get(value);
			if (existing !== undefined) return existing;
			const length = Buffer.byteLength(value);
			if (length > 1024 * 1024) throw importFailure(file, "limit_exceeded");
			if (bytes + length + 4 > 256 * 1024) flush();
			const id = count++;
			// Detach slices from input chunks, keeping the block's memory bound truthful.
			const stable = (" " + value).slice(1);
			strings.push(stable);
			ids.set(stable, id);
			bytes += length + 4;
			return id;
		},
		finish(): SnapshotSourceColumn[] {
			flush();
			return [
				...blocks.map((block) => ({ ...block, stringCount: count })),
				{
					name: `${domain}.starts`,
					kind: "u32",
					load: async () => Uint32Array.from(starts)
				}
			];
		},
		get count() {
			return count;
		},
		async visitStrings(
			visit: (start: number, values: ReturnType<typeof decodeStringBlock>) => boolean
		) {
			flush();
			for (let index = 0; index < blocks.length; index++) {
				const values = await blocks[index]!.load();
				if (!(values instanceof Uint8Array)) throw importFailure(file, "invalid_schema");
				if (!visit(starts[index]!, decodeStringBlock(values))) break;
			}
		}
	};
}

export function localizationColumnsBuilder(
	file: string,
	spill: string,
	options: LocalizationImportOptions,
	limits: LocalizationImportLimits
) {
	const handle = openSync(spill, "wx+");
	const cursor = { offset: 0 };
	const identityIds = new Map<string, number>();
	const identityStrings: string[] = [];
	let identityBytes = 0;
	const tables = Object.fromEntries(
		["source", "translation", "paths", "comments"].map((domain) => [
			domain,
			spilledDomain(domain, handle, cursor, limits, file)
		])
	);
	for (const table of Object.values(tables)) table.add("");
	// SAFETY: The closed field list initializes every property with a Uint32Array.
	const column = Object.fromEntries(
		fields.map((name) => [name, new Uint32Array(4096)])
	) as Record<Field, Uint32Array>;
	let capacity = 4096;
	let count = 0;
	let poFormat = options.poFormat ?? "Unreal";
	let headerSeen = false;
	let pathPrefix = "";
	let unresolvedPrefix = 0;
	let invalidChildOffset: number | undefined;
	function id(value: string) {
		const existing = identityIds.get(value);
		if (existing !== undefined) return existing;
		const length = Buffer.byteLength(value);
		if (length > 1024 * 1024) throw importFailure(file, "limit_exceeded");
		const stable = (" " + value).slice(1);
		identityBytes += length + 128 + value.length * 2;
		if (identityBytes > limits.maxIdentityBytes) throw importFailure(file, "limit_exceeded");
		const index = identityStrings.length;
		identityStrings.push(stable);
		identityIds.set(stable, index);
		return index;
	}
	function row() {
		if (count >= limits.maxEntries) throw importFailure(file, "limit_exceeded");
		if (count === capacity) {
			capacity = Math.min(limits.maxEntries, capacity * 2);
			for (const field of fields) {
				const next = new Uint32Array(capacity);
				next.set(column[field]);
				column[field] = next;
			}
		}
		column.ordinal[count] = count;
	}
	function put(
		field: Exclude<Field, "options" | "ordinal" | "namespace" | "key">,
		value: string
	) {
		if (field === "path" && value !== "") {
			if (Buffer.byteLength(value) > 1024 * 1024) throw importFailure(file, "limit_exceeded");
			if (!pathPrefix) pathPrefix = value.slice(0, value.lastIndexOf("/") + 1);
			if (pathPrefix && value.startsWith(pathPrefix)) {
				value = value.slice(pathPrefix.length);
				column.options[count]! |= 1024;
			}
		}
		column[field][count] = tables[domains[field]]!.add(value);
	}
	const extra = ({ Text: _text, ...rest }: typeof LocalizationText.Type) =>
		Object.keys(rest).length ? JSON.stringify(rest) : "";
	function jsonChild(value: Schema.Json, node: number, offset: number) {
		if (options.format === "manifest") {
			const decoded = decodeManifestChild(value);
			if (Result.isFailure(decoded)) {
				invalidChildOffset ??= offset;
				return;
			}
			for (const key of decoded.success.Keys) {
				row();
				column.namespace[count] = node;
				column.key[count] = id(key.Key);
				put("source", decoded.success.Source.Text);
				put("source-extra", extra(decoded.success.Source));
				put("path", key.Path);
				if (key.DevNotes !== undefined) {
					put("notes", key.DevNotes);
					column.options[count]! |= 4;
				}
				if (key.MetaData !== undefined) {
					put("metadata", JSON.stringify(key.MetaData));
					column.options[count]! |= 8;
				}
				if (key.Optional !== undefined) column.options[count]! |= key.Optional ? 3 : 1;
				count++;
			}
		} else {
			const decoded = decodeArchiveChild(value);
			if (Result.isFailure(decoded)) {
				invalidChildOffset ??= offset;
				return;
			}
			const entry = decoded.success;
			row();
			column.namespace[count] = node;
			column.key[count] = id(entry.Key);
			put("source", entry.Source.Text);
			put("source-extra", extra(entry.Source));
			if (entry.Translation.Text === entry.Source.Text) column.options[count]! |= 128;
			else put("translation", entry.Translation.Text);
			put("translation-extra", extra(entry.Translation));
			if (entry.MetaData !== undefined) {
				put("metadata", JSON.stringify(entry.MetaData));
				column.options[count]! |= 8;
			}
			if (entry.Optional !== undefined) column.options[count]! |= entry.Optional ? 3 : 1;
			count++;
		}
	}
	function poBlock(lines: readonly POLine[], firstLine: number) {
		const parsed = parsePOBlock(lines, firstLine - 1, false);
		if (Result.isFailure(parsed)) {
			const line = /Line (\d+)/u.exec(parsed.failure.message);
			throw importFailure(
				file,
				parsed.failure.code,
				` at line ${Number(line?.[1] ?? firstLine)}`
			);
		}
		{
			const block = parsed.success;
			if (block.kind === "header" && !headerSeen) {
				headerSeen = true;
				unresolvedPrefix = count;
				if (
					!options.poFormat &&
					/^X-Crowdin-SourceKey:\s*msgstr\s*$/imu.test(block.entry?.msgstr["0"] ?? "")
				)
					poFormat = "Crowdin";
			}
			if (block.kind !== "entry" || !block.entry) return;
			const entry = block.entry;
			row();
			const keyed =
				poFormat === "Crowdin" &&
				(options.collapseMode ?? "IdenticalTextIdAndSource") === "IdenticalTextIdAndSource";
			const parsedId = parsePOIdentity(keyed ? entry.msgid : (entry.msgctxt ?? ""));
			if (Result.isFailure(parsedId))
				throw importFailure(file, parsedId.failure.code, ` at line ${firstLine}`);
			column.namespace[count] = id(parsedId.success.namespace);
			column.key[count] = id(parsedId.success.key);
			column.options[count] = entry.msgctxt === undefined && !keyed ? 16 : 0;
			put("source", entry.msgid);
			if (entry.msgstr["0"] === entry.msgid) column.options[count]! |= 128;
			else put("translation", entry.msgstr["0"] ?? "");
			const { msgstr, msgctxt } = entry;
			const extras: Record<string, Schema.Json> = {};
			if (entry.msgidPlural !== undefined) extras.msgidPlural = entry.msgidPlural;
			let extracted = entry.extractedComments;
			if (extracted[0] === `Key: ${parsedId.success.key}` && options.poFormat) {
				column.options[count]! |= 256;
				extracted = extracted.slice(1);
			}
			if (extracted.length) extras.extractedComments = extracted;
			if (entry.translatorComments.length)
				extras.translatorComments = entry.translatorComments;
			if (entry.flags.length) extras.flags = entry.flags;
			if (entry.previousMsgidLines.length)
				extras.previousMsgidLines = entry.previousMsgidLines;
			if (entry.referenceComments.length) {
				column.options[count]! |= 512;
				put("path", entry.referenceComments[0]!);
				if (entry.referenceComments.length > 1)
					extras.referenceComments = entry.referenceComments.slice(1);
			}
			let otherTranslations: Record<string, string> | undefined;
			for (const key in msgstr)
				if (key !== "0") (otherTranslations ??= {})[key] = msgstr[key]!;
			if (otherTranslations) extras.msgstr = otherTranslations;
			if (Object.hasOwn(msgstr, "0")) column.options[count]! |= 64;
			const canonicalContext = `${parsedId.success.namespace.replaceAll(",", "\\,")},${parsedId.success.key.replaceAll(",", "\\,")}`;
			if (msgctxt !== undefined) {
				if (options.poFormat && msgctxt === canonicalContext) column.options[count]! |= 32;
				else extras.msgctxt = msgctxt;
			}
			put("po-extra", Object.keys(extras).length ? JSON.stringify(extras) : "");
			count++;
		}
	}
	const parser =
		options.format === "po"
			? localizationPOStream(file, limits, poBlock)
			: localizationJsonStream(file, limits, jsonChild);
	return {
		feed: (text: string) => parser.feed(text),
		close: () => closeSync(handle),
		async finish(): Promise<SnapshotSource> {
			if (options.format === "po") {
				// SAFETY: The format branch selects the same PO constructor used above.
				(parser as ReturnType<typeof localizationPOStream>).feed("", true);
				// Explicit target formats are normal. Auto-detected Crowdin identities are resolved
				// after the header, including files whose header follows their entries.
				if (
					!options.poFormat &&
					poFormat === "Crowdin" &&
					(options.collapseMode ?? "IdenticalTextIdAndSource") ===
						"IdenticalTextIdAndSource"
				) {
					let row = 0;
					await tables.source!.visitStrings((start, values) => {
						while (
							row < unresolvedPrefix &&
							column.source[row]! < start + values.count
						) {
							const parsed = parsePOIdentity(
								column.source[row] === 0
									? ""
									: values.string(column.source[row]! - start)
							);
							if (Result.isFailure(parsed))
								throw importFailure(file, parsed.failure.code);
							column.namespace[row] = id(parsed.success.namespace);
							column.key[row] = id(parsed.success.key);
							column.options[row]! &= ~16;
							row++;
						}
						return row < unresolvedPrefix;
					});
				}
			} else {
				// SAFETY: Non-PO formats select the JSON constructor used above.
				const namespaces = (parser as ReturnType<typeof localizationJsonStream>)
					.finish(options.format === "manifest" ? 1 : 2)
					.map(id);
				if (invalidChildOffset !== undefined)
					throw importFailure(
						file,
						"invalid_schema",
						` at character offset ${invalidChildOffset}`
					);
				const flattened = Uint32Array.from({ length: count }, (_, i) => i);
				flattened.sort((a, b) => column.namespace[a]! - column.namespace[b]! || a - b);
				for (let i = 0; i < count; i++) column.ordinal[flattened[i]!] = i;
				for (let i = 0; i < count; i++)
					column.namespace[i] = namespaces[column.namespace[i]!]!;
			}
			if (!identityStrings.length) id("");
			for (const table of Object.values(tables)) if (!table.count) table.add("");
			const order = Uint32Array.from({ length: count }, (_, i) => i);
			order.sort((a, b) => {
				const an = column.namespace[a]!,
					bn = column.namespace[b]!;
				if (an !== bn) {
					const av = identityStrings[an]!,
						bv = identityStrings[bn]!;
					if (av < bv) return -1;
					if (av > bv) return 1;
				}
				const ak = column.key[a]!,
					bk = column.key[b]!;
				if (ak !== bk) {
					const av = identityStrings[ak]!,
						bv = identityStrings[bk]!;
					if (av < bv) return -1;
					if (av > bv) return 1;
				}
				return column.ordinal[a]! - column.ordinal[b]!;
			});
			const descriptors: SnapshotSourceColumn[] = [];
			for (const field of fields) {
				const domain =
					field === "options" || field === "ordinal" ? undefined : domains[field];
				const stringCount =
					domain === "identity"
						? identityStrings.length
						: domain
							? tables[domain]!.count
							: 0;
				const descriptor: SnapshotSourceColumn = {
					name: `entry.${field}`,
					kind: domain ? "stringIds" : "u32",
					load: async () => {
						const sorted = new Uint32Array(count),
							values = column[field];
						for (let i = 0; i < count; i++) sorted[i] = values[order[i]!]!;
						return sorted;
					}
				};
				if (domain) Object.assign(descriptor, { domain, stringCount });
				descriptors.push(descriptor);
			}
			for (const table of Object.values(tables)) descriptors.push(...table.finish());
			// Identity blocks remain within the accounted dictionary budget; authored text spills.
			const starts: number[] = [];
			for (let start = 0; start < identityStrings.length; ) {
				let end = start,
					bytes = 8;
				while (end < identityStrings.length) {
					const size = Buffer.byteLength(identityStrings[end]!) + 4;
					if (end > start && bytes + size > 256 * 1024) break;
					bytes += size;
					end++;
				}
				starts.push(start);
				const values = encodeStringBlock(identityStrings.slice(start, end));
				descriptors.push({
					name: `identity.b${starts.length - 1}`,
					kind: "strings",
					domain: "identity",
					compressionLevel: 6,
					stringCount: identityStrings.length,
					load: async () => values
				});
				start = end;
			}
			descriptors.push({
				name: "identity.starts",
				kind: "u32",
				load: async () => Uint32Array.from(starts)
			});
			const meta = new TextEncoder().encode(
				JSON.stringify({
					format: options.format,
					count,
					poFormat,
					pathPrefix,
					hasSourceText:
						poFormat !== "Crowdin" ||
						(options.collapseMode ?? "IdenticalTextIdAndSource") !==
							"IdenticalTextIdAndSource"
				})
			);
			descriptors.push({ name: "file.meta", kind: "bytes", load: async () => meta });
			return { columns: descriptors };
		}
	};
}

/** Explicit bounded hydration for tests and consumers; ordinal restores PO parser order. */
export const decodeLocalizationSnapshot = Effect.fn("LocalizationSnapshot.decode")(function* (
	reader: SnapshotReader,
	start = 0,
	maximum = 50
) {
	const metaBytes = yield* reader.section("file.meta");
	const meta = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Meta))(
		new TextDecoder().decode(metaBytes)
	);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(maximum) ||
		start < 0 ||
		maximum < 0 ||
		maximum > 10000
	)
		return yield* Effect.fail(importFailure("snapshot", "limit_exceeded"));
	const end = Math.min(meta.count, start + maximum);
	const values: Partial<Record<Field, number[]>> = {};
	const decoded: Partial<Record<Field, string[]>> = {};
	for (const field of fields) {
		const column = yield* reader.section(`entry.${field}`);
		values[field] = Array.from(column.subarray(start, end));
		if (field !== "options" && field !== "ordinal")
			decoded[field] = yield* reader.strings(domains[field], values[field]!);
	}
	const entries: (ManifestEntry | ArchiveEntry | POEntry)[] = [];
	for (let index = 0; index < end - start; index++) {
		const string = (field: Field) => decoded[field]![index]!;
		const json = (field: Field) =>
			Schema.decodeUnknownSync(OpaqueRecord)(JSON.parse(string(field) || "{}"));
		const flags = values.options![index]!;
		const path = (flags & 1024 ? (meta.pathPrefix ?? "") : "") + string("path");
		const identity = {
			namespace: TextNamespace.make(string("namespace")),
			key: TextKey.make(string("key"))
		};
		const sourceExtra = Schema.decodeUnknownSync(OpaqueRecord)(json("source-extra"));
		const source = { Text: string("source"), ...sourceExtra };
		if (meta.format === "po") {
			const extras = json("po-extra");
			const msgstr = {
				...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
					extras.msgstr ?? {}
				)
			};
			if (flags & 64) msgstr["0"] = flags & 128 ? string("source") : string("translation");
			const entry = {
				...extras,
				translatorComments: decodePOComments(extras.translatorComments ?? []),
				extractedComments: decodePOComments(extras.extractedComments ?? []),
				referenceComments: decodePOComments(extras.referenceComments ?? []),
				flags: decodePOComments(extras.flags ?? []),
				previousMsgidLines: decodePOComments(extras.previousMsgidLines ?? []),
				msgstr,
				msgid: string("source"),
				identity: flags & 16 ? null : identity
			};
			if (flags & 256)
				entry.extractedComments = [`Key: ${identity.key}`, ...entry.extractedComments];
			if (flags & 512) entry.referenceComments = [path, ...entry.referenceComments];
			if (flags & 32)
				Object.assign(entry, {
					msgctxt: `${identity.namespace.replaceAll(",", "\\,")},${identity.key.replaceAll(",", "\\,")}`
				});
			entries.push(Schema.decodeUnknownSync(POEntry)(entry));
		} else {
			const entry = { ...identity, source };
			if (flags & 1) Object.assign(entry, { optional: Boolean(flags & 2) });
			if (flags & 8) Object.assign(entry, { metadata: json("metadata") });
			if (meta.format === "manifest") {
				const manifest = { ...entry, path };
				if (flags & 4) Object.assign(manifest, { devNotes: string("notes") });
				entries.push(Schema.decodeUnknownSync(ManifestEntry)(manifest));
			} else
				entries.push(
					Schema.decodeUnknownSync(ArchiveEntry)({
						...entry,
						translation: {
							Text: flags & 128 ? string("source") : string("translation"),
							...json("translation-extra")
						}
					})
				);
		}
	}
	return { ...meta, entries, ordinals: values.ordinal! };
});

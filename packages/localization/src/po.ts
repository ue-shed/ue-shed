import {
	checkSize,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import {
	type LocalizationIdentity,
	LocalizationError,
	PODocument,
	POEntry,
	type POFormat,
	POParseOptions,
	type POLine,
	TextKey,
	TextNamespace,
	type POBlock,
	type POEvidence,
	type POStringField
} from "./schema.js";

/** Unreal's pipeline applies replacements in this order, including its literal-backslash caveat. */
export function decodePOEscapes(value: string): string {
	if (!value.includes("\\")) return value;
	return value
		.replaceAll("\\t", "\t")
		.replaceAll("\\n", "\n")
		.replaceAll("\\r", "\r")
		.replaceAll('\\"', '"')
		.replaceAll("\\\\", "\\");
}

export function parsePOIdentity(value: string) {
	return parseResult(() => {
		let escaped = false;
		const hasEscapes = value.includes("\\");
		let comma = hasEscapes ? -1 : value.indexOf(",");
		for (let index = 0; hasEscapes && comma === -1 && index < value.length; index++) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (value[index] === ",") {
				comma = index;
				break;
			}
			if (value[index] === "\\") escaped = true;
		}
		const identity: LocalizationIdentity = {
			namespace: TextNamespace.make(
				(comma === -1 ? value : value.slice(0, comma)).replaceAll("\\,", ",")
			),
			key: TextKey.make((comma === -1 ? "" : value.slice(comma + 1)).replaceAll("\\,", ","))
		};
		return immutable(identity);
	});
}

function malformedPO(lineNumber: number): LocalizationError {
	return new LocalizationError({
		code: "malformed_po",
		message: `Line ${lineNumber} of the PO file is not valid PO syntax.`,
		recovery: localizationError("malformed_po").recovery
	});
}

function quoted(input: string, lineNumber: number): string {
	if (!input.startsWith('"')) throw malformedPO(lineNumber);
	const closing = input.indexOf('"', 1);
	if (closing > 0 && !input.slice(1, closing).includes("\\")) {
		if (input.slice(closing + 1).trim() !== "") throw malformedPO(lineNumber);
		return input.slice(1, closing);
	}
	const match = /^"((?:[^"\\]|\\[\s\S])*)"\s*$/u.exec(input);
	if (match) return match[1]!;
	throw malformedPO(lineNumber);
}

function rawLines(text: string): POLine[] {
	const lines: POLine[] = [];
	for (const match of text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)) {
		if (match[0] !== "") {
			// SAFETY: the ending capture enumerates exactly POLine's four endings.
			lines.push({ text: match[1] ?? "", ending: match[2] as POLine["ending"] });
		}
	}
	return lines;
}

function blocksFromLines(lines: readonly POLine[]): POLine[][] {
	const blocks: POLine[][] = [];
	let block: POLine[] = [];
	let finished = false;
	let blank = false;
	for (const line of lines) {
		const trimmed = line.text.trim();
		if (
			trimmed !== "" &&
			(blank || (finished && (trimmed.startsWith("#") || /^msg(?:ctxt|id)\s/u.test(trimmed))))
		) {
			if (block.length > 0) blocks.push(block);
			block = [];
			finished = false;
		}
		block.push(line);
		blank = trimmed === "";
		if (/^msgstr(?:\[\d+\])?\s/u.test(trimmed)) finished = true;
	}
	if (block.length > 0) blocks.push(block);
	return blocks;
}

function decodeBlock(lines: readonly POLine[], lineOffset: number, detailed = true): POBlock {
	const fields: {
		name: POStringField["name"];
		index?: number;
		lineIndices: number[];
		raw: string;
	}[] = [];
	const translatorComments: string[] = [];
	const extractedComments: string[] = [];
	const referenceComments: string[] = [];
	const flags: string[] = [];
	const previousMsgidLines: string[] = [];
	let current: (typeof fields)[number] | undefined;
	for (const [index, line] of lines.entries()) {
		const lineNumber = lineOffset + index + 1;
		const trimmed = line.text.trim();
		if (trimmed === "") {
			current = undefined;
			continue;
		}
		if (trimmed.startsWith("#")) {
			current = undefined;
			if (trimmed.startsWith("#.")) extractedComments.push(trimmed.slice(2).trimStart());
			else if (trimmed.startsWith("#:")) referenceComments.push(trimmed.slice(2).trimStart());
			else if (trimmed.startsWith("#,"))
				flags.push(
					...trimmed
						.slice(2)
						.split(",")
						.map((flag) => flag.trim())
						.filter(Boolean)
				);
			else if (trimmed.startsWith("#|")) previousMsgidLines.push(line.text);
			else if (trimmed === "#" || trimmed.startsWith("# "))
				translatorComments.push(trimmed.slice(1).replace(/^ /u, ""));
			continue;
		}
		if (trimmed.startsWith('"')) {
			if (current === undefined) throw malformedPO(lineNumber);
			current.raw += quoted(trimmed, lineNumber);
			current.lineIndices.push(index);
			continue;
		}
		const match = /^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?\s+(.*)$/su.exec(trimmed);
		if (match === null) throw malformedPO(lineNumber);
		// SAFETY: the keyword capture enumerates exactly the four PO field names.
		const name = match[1] as POStringField["name"];
		const fieldIndex = match[2] === undefined ? undefined : Number(match[2]);
		if (fieldIndex !== undefined && (name !== "msgstr" || !Number.isSafeInteger(fieldIndex)))
			throw malformedPO(lineNumber);
		if (fields.some((field) => field.name === name && (field.index ?? 0) === (fieldIndex ?? 0)))
			throw malformedPO(lineNumber);
		current = {
			name,
			raw: quoted(match[3] ?? "", lineNumber),
			lineIndices: [index]
		};
		if (fieldIndex !== undefined) current.index = fieldIndex;
		fields.push(current);
	}
	if (fields.length === 0) return { kind: "trivia", lines, fields: [] };
	const id = fields.find((field) => field.name === "msgid");
	const context = fields.find((field) => field.name === "msgctxt");
	const plural = fields.find((field) => field.name === "msgid_plural");
	const translations = fields.filter((field) => field.name === "msgstr");
	if (id === undefined || translations.length === 0)
		throw malformedPO(lineOffset + (fields[0]?.lineIndices[0] ?? 0) + 1);
	const decoded: POEntry = {
		msgid: decodePOEscapes(id.raw),
		msgstr: Object.fromEntries(
			translations.map((field) => [String(field.index ?? 0), decodePOEscapes(field.raw)])
		),
		translatorComments,
		extractedComments,
		referenceComments,
		flags,
		previousMsgidLines,
		identity: null
	};
	if (context !== undefined) Object.assign(decoded, { msgctxt: decodePOEscapes(context.raw) });
	if (plural !== undefined) Object.assign(decoded, { msgidPlural: decodePOEscapes(plural.raw) });
	return {
		kind: id.raw === "" && context === undefined && plural === undefined ? "header" : "entry",
		lines,
		fields: detailed
			? fields.map(({ raw, ...field }) => ({ ...field, value: decodePOEscapes(raw) }))
			: [],
		entry: decoded
	};
}

/** Common single-line entry form; richer blocks keep the full shared grammar below. */
function simpleEntry(lines: readonly POLine[]): POEntry | undefined {
	const translatorComments: string[] = [],
		extractedComments: string[] = [],
		referenceComments: string[] = [];
	let msgctxt: string | undefined, msgid: string | undefined, msgstr: string | undefined;
	let fields = false;
	for (const line of lines) {
		const text = line.text;
		const trimmed = text.trim();
		if (!trimmed) continue;
		if (text !== trimmed) return undefined;
		if (!fields && text.startsWith("#. ")) {
			extractedComments.push(text.slice(3).trimStart());
			continue;
		}
		if (!fields && text.startsWith("#: ")) {
			referenceComments.push(text.slice(3).trimStart());
			continue;
		}
		if (!fields && text.startsWith("# ")) {
			translatorComments.push(text.slice(2));
			continue;
		}
		fields = true;
		let name: "msgctxt" | "msgid" | "msgstr", prefix: number;
		if (text.startsWith('msgctxt "')) {
			name = "msgctxt";
			prefix = 9;
		} else if (text.startsWith('msgid "')) {
			name = "msgid";
			prefix = 7;
		} else if (text.startsWith('msgstr "')) {
			name = "msgstr";
			prefix = 8;
		} else return undefined;
		if (!text.endsWith('"')) return undefined;
		const value = text.slice(prefix, -1);
		if (value.includes('"') || value.includes("\\")) return undefined;
		if (name === "msgctxt") {
			if (msgctxt !== undefined) return undefined;
			msgctxt = value;
		} else if (name === "msgid") {
			if (msgid !== undefined) return undefined;
			msgid = value;
		} else {
			if (msgstr !== undefined) return undefined;
			msgstr = value;
		}
	}
	if (msgid === undefined || msgstr === undefined || msgid === "") return undefined;
	const entry: POEntry = {
		msgid,
		msgstr: { "0": msgstr },
		translatorComments,
		extractedComments,
		referenceComments,
		flags: [],
		previousMsgidLines: [],
		identity: null
	};
	if (msgctxt !== undefined) Object.assign(entry, { msgctxt });
	return entry;
}

/** Decode one already bounded block from a streaming scanner. Offset is zero-based physical lines. */
export function parsePOBlock(lines: readonly POLine[], lineOffset = 0, detailed = true) {
	return parseResult(() => {
		if (!detailed) {
			const entry = simpleEntry(lines);
			if (entry) return { kind: "entry" as const, lines, fields: [], entry };
		}
		return decodeBlock(lines, lineOffset, detailed);
	});
}

export function parsePO(bytes: Uint8Array, input: POParseOptions = {}) {
	return parseResult(() => {
		const options = validate(POParseOptions, input);
		const limits = limitsFor(options.limits);
		checkSize(bytes, limits);
		const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.subarray(bom ? 3 : 0)
			);
		} catch {
			throw localizationError("invalid_encoding");
		}
		const rawBlocks = blocksFromLines(rawLines(text));
		if (rawBlocks.length > limits.maxEntries) throw localizationError("limit_exceeded");
		let lineOffset = 0;
		const blocks = rawBlocks.map((lines) => {
			const block = decodeBlock(lines, lineOffset);
			lineOffset += lines.length;
			return block;
		});
		const header = blocks.find((block) => block.kind === "header")?.entry?.msgstr["0"] ?? "";
		const format: POFormat =
			options.format ??
			(/^X-Crowdin-SourceKey:\s*msgstr\s*$/imu.test(header) ? "Crowdin" : "Unreal");
		const keyedCrowdin =
			format === "Crowdin" &&
			(options.collapseMode ?? "IdenticalTextIdAndSource") === "IdenticalTextIdAndSource";
		const identified = blocks.map((block): POBlock => {
			if (block.kind !== "entry" || block.entry === undefined) return block;
			const value = keyedCrowdin ? block.entry.msgid : block.entry.msgctxt;
			if (value === undefined) return block;
			const identity = parsePOIdentity(value);
			if (identity._tag === "Failure") throw identity.failure;
			return { ...block, entry: { ...block.entry, identity: identity.success } };
		});
		const document: PODocument = {
			bom,
			format,
			hasSourceText: !keyedCrowdin,
			blocks: identified
		};
		return immutable(document);
	});
}

export function projectPOEvidence(document: PODocument): POEvidence {
	// Copy strings so short comments and identities cannot retain the entire decoded file.
	return immutable({
		format: document.format,
		hasSourceText: document.hasSourceText,
		entries: document.blocks.flatMap((block) =>
			block.kind === "entry" && block.entry !== undefined ? [copyPOEntry(block.entry)] : []
		)
	});
}

const emptyComments: readonly string[] = Object.freeze([]);
const copyString = (value: string) => (" " + value).slice(1);
function copyPOEntry(entry: POEntry): POEntry {
	const comments = (values: readonly string[]) =>
		values.length === 0 ? emptyComments : values.map(copyString);
	const result: POEntry = {
		msgid: copyString(entry.msgid),
		msgstr: Object.fromEntries(
			Object.entries(entry.msgstr).map(([key, value]) => [key, copyString(value)])
		),
		translatorComments: comments(entry.translatorComments),
		extractedComments: comments(entry.extractedComments),
		referenceComments: comments(entry.referenceComments),
		flags: comments(entry.flags),
		previousMsgidLines: comments(entry.previousMsgidLines),
		identity:
			entry.identity === null
				? null
				: {
						namespace: TextNamespace.make(copyString(entry.identity.namespace)),
						key: TextKey.make(copyString(entry.identity.key))
					}
	};
	if (entry.msgctxt !== undefined) Object.assign(result, { msgctxt: copyString(entry.msgctxt) });
	if (entry.msgidPlural !== undefined)
		Object.assign(result, { msgidPlural: copyString(entry.msgidPlural) });
	return result;
}

/** Serialization uses preserved lines, never regenerated decoded strings. No file write API. */
export function serializePO(document: PODocument): Uint8Array {
	return new TextEncoder().encode(
		(document.bom ? "\uFEFF" : "") +
			document.blocks
				.flatMap((block) => block.lines.map((line) => line.text + line.ending))
				.join("")
	);
}

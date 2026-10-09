import { Schema } from "effect";
import {
	checkSize,
	immutable,
	limitsFor,
	localizationError,
	parseResult,
	validate
} from "./decode.js";
import {
	LocalizationIdentity,
	LocalizationError,
	PODocument,
	POEntry,
	POFormat,
	POParseOptions,
	POLine,
	type POBlock,
	type POStringField
} from "./schema.js";

/** Unreal's pipeline applies replacements in this order, including its literal-backslash caveat. */
export function decodePOEscapes(value: string): string {
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
		let comma = -1;
		for (let index = 0; index < value.length; index++) {
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
		return immutable(
			validate(LocalizationIdentity, {
				namespace: (comma === -1 ? value : value.slice(0, comma)).replaceAll("\\,", ","),
				key: (comma === -1 ? "" : value.slice(comma + 1)).replaceAll("\\,", ",")
			})
		);
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
	let escaped = false;
	for (let index = 1; index < input.length; index++) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (input[index] === "\\") {
			escaped = true;
			continue;
		}
		if (input[index] === '"') {
			if (input.slice(index + 1).trim() !== "") throw malformedPO(lineNumber);
			return input.slice(1, index);
		}
	}
	throw malformedPO(lineNumber);
}

function rawLines(text: string): POLine[] {
	return [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)]
		.filter((match) => match[0] !== "")
		.map((match, index) => {
			const decoded = Schema.decodeUnknownResult(POLine)({
				text: match[1],
				ending: match[2]
			});
			if (decoded._tag === "Failure") throw malformedPO(index + 1);
			return decoded.success;
		});
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

function decodeBlock(lines: readonly POLine[], lineOffset: number): POBlock {
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
		const name = validate(POStringFieldName, match[1], "malformed_po");
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
	const entry = validate(POEntry, decoded, "malformed_po");
	return {
		kind: id.raw === "" && context === undefined && plural === undefined ? "header" : "entry",
		lines,
		fields: fields.map(({ raw, ...field }) => ({ ...field, value: decodePOEscapes(raw) })),
		entry
	};
}

const POStringFieldName = Schema.Literals(["msgctxt", "msgid", "msgid_plural", "msgstr"]);

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
		const format = validate(
			POFormat,
			options.format ??
				(/^X-Crowdin-SourceKey:\s*msgstr\s*$/imu.test(header) ? "Crowdin" : "Unreal")
		);
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
		return immutable(
			validate(
				PODocument,
				{ bom, format, hasSourceText: !keyedCrowdin, blocks: identified },
				"malformed_po"
			)
		);
	});
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

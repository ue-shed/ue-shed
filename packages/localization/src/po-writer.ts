import { Result, Schema } from "effect";
import { decodePOEscapes, parsePO, serializePO } from "./po.js";
import { LocalizationIdentity, type PODocument, type POLine } from "./schema.js";

/** One replacement of a singular `msgstr` in an Unreal-format or Crowdin-format PO document. */
export const POTranslationEdit = Schema.Struct({
	identity: LocalizationIdentity,
	translation: Schema.String
});
export type POTranslationEdit = typeof POTranslationEdit.Type;

export const POEditFailureCode = Schema.Literals([
	"entry_not_found",
	"ambiguous_entry",
	"plural_entry",
	"duplicate_edit",
	"unsafe_escape",
	"unverifiable_write"
]);
export type POEditFailureCode = typeof POEditFailureCode.Type;

export class POEditError extends Schema.TaggedErrorClass<POEditError>()("POEditError", {
	code: POEditFailureCode,
	identity: Schema.NullOr(LocalizationIdentity),
	message: Schema.String,
	recovery: Schema.String
}) {}

const recovery = {
	entry_not_found:
		"Export the target's PO files through Unreal so the line has an entry, then stage the edit again.",
	ambiguous_entry:
		"The PO file repeats this identity; re-export it through Unreal before editing.",
	plural_entry:
		"Unreal imports only singular msgstr values; edit plural forms inside the translation text.",
	duplicate_edit: "Keep one replacement per identity in a single write.",
	unsafe_escape:
		"Unreal's PO import turns a backslash before n, r or t into a control character. Rephrase the translation so it survives the import.",
	unverifiable_write:
		"The rewritten PO file did not round-trip; nothing was written. Report this as a defect."
} satisfies Record<POEditFailureCode, string>;

function editError(code: POEditFailureCode, identity: LocalizationIdentity | null): POEditError {
	return new POEditError({
		code,
		identity,
		message: `The PO edit could not be prepared (${code}).`,
		recovery: recovery[code]
	});
}

/** Unreal's export conditioning (`PortableObjectPipeline::ConditionArchiveStrForPO`), in order. */
export function escapePOString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t");
}

const identityKey = (identity: LocalizationIdentity) =>
	JSON.stringify([identity.namespace, identity.key]);

/**
 * Replaces only the singular `msgstr` lines of the identified entries. Every other byte of the
 * document is preserved, and the result is re-parsed to prove the edited values decode exactly.
 */
export function replacePOTranslations(
	document: PODocument,
	edits: readonly POTranslationEdit[]
): Result.Result<PODocument, POEditError> {
	const pending = new Map<string, POTranslationEdit>();
	for (const edit of edits) {
		const key = identityKey(edit.identity);
		if (pending.has(key)) return Result.fail(editError("duplicate_edit", edit.identity));
		if (decodePOEscapes(escapePOString(edit.translation)) !== edit.translation)
			return Result.fail(editError("unsafe_escape", edit.identity));
		pending.set(key, edit);
	}
	const matches = new Map<string, number>();
	for (const [index, block] of document.blocks.entries()) {
		const identity = block.kind === "entry" ? block.entry?.identity : null;
		if (!identity) continue;
		const key = identityKey(identity);
		if (!pending.has(key)) continue;
		if (matches.has(key)) return Result.fail(editError("ambiguous_entry", identity));
		matches.set(key, index);
	}
	for (const edit of pending.values())
		if (!matches.has(identityKey(edit.identity)))
			return Result.fail(editError("entry_not_found", edit.identity));

	const editsByBlock = new Map<number, POTranslationEdit>();
	for (const [key, index] of matches) {
		const edit = pending.get(key);
		if (edit !== undefined) editsByBlock.set(index, edit);
	}
	const blocks: PODocument["blocks"][number][] = [];
	for (const [index, block] of document.blocks.entries()) {
		const edit = editsByBlock.get(index);
		if (edit === undefined) {
			blocks.push(block);
			continue;
		}
		const lines = replaceMsgstrLines(block, edit);
		if (Result.isFailure(lines)) return Result.fail(lines.failure);
		blocks.push({ ...block, lines: lines.success });
	}
	return verify(document, { ...document, blocks }, pending, matches);
}

function replaceMsgstrLines(
	block: PODocument["blocks"][number],
	edit: POTranslationEdit
): Result.Result<readonly POLine[], POEditError> {
	const msgstr = block.fields.filter((field) => field.name === "msgstr");
	const plural = block.fields.some((field) => field.name === "msgid_plural");
	const singular = msgstr.length === 1 && msgstr[0]?.index === undefined ? msgstr[0] : undefined;
	if (plural || singular === undefined)
		return Result.fail(editError("plural_entry", edit.identity));
	const first = singular.lineIndices[0];
	const last = singular.lineIndices.at(-1);
	const original = first === undefined ? undefined : block.lines[first];
	const ending = last === undefined ? undefined : block.lines[last]?.ending;
	if (first === undefined || last === undefined || original === undefined || ending === undefined)
		return Result.fail(editError("unverifiable_write", edit.identity));
	const indentation = /^\s*/u.exec(original.text)?.[0] ?? "";
	const replacement: POLine = {
		text: `${indentation}msgstr "${escapePOString(edit.translation)}"`,
		ending
	};
	return Result.succeed([
		...block.lines.slice(0, first),
		replacement,
		...block.lines.slice(last + 1)
	]);
}

function verify(
	before: PODocument,
	after: PODocument,
	pending: ReadonlyMap<string, POTranslationEdit>,
	matches: ReadonlyMap<string, number>
): Result.Result<PODocument, POEditError> {
	const reparsed = parsePO(serializePO(after), { format: before.format });
	if (Result.isFailure(reparsed)) return Result.fail(editError("unverifiable_write", null));
	const document = reparsed.success;
	if (document.blocks.length !== before.blocks.length)
		return Result.fail(editError("unverifiable_write", null));
	const edited = new Set(matches.values());
	const encoder = new TextEncoder();
	const bytes = (block: PODocument["blocks"][number]) =>
		encoder.encode(block.lines.map((line) => line.text + line.ending).join(""));
	for (const [index, block] of document.blocks.entries()) {
		const original = before.blocks[index];
		if (original === undefined) return Result.fail(editError("unverifiable_write", null));
		if (!edited.has(index)) {
			if (!sameBytes(bytes(block), bytes(original)))
				return Result.fail(editError("unverifiable_write", null));
			continue;
		}
		const identity = block.entry?.identity;
		const edit = identity ? pending.get(identityKey(identity)) : undefined;
		if (edit === undefined || block.entry?.msgstr["0"] !== edit.translation)
			return Result.fail(editError("unverifiable_write", identity ?? null));
		const { msgstr: _after, ...restAfter } = block.entry;
		const { msgstr: _before, ...restBefore } = original.entry ?? block.entry;
		if (JSON.stringify(restAfter) !== JSON.stringify(restBefore))
			return Result.fail(editError("unverifiable_write", identity ?? null));
	}
	return Result.succeed(document);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

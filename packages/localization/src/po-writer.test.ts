import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { parsePO, serializePO } from "./po.js";
import { escapePOString, replacePOTranslations, type POTranslationEdit } from "./po-writer.js";
import type { PODocument } from "./schema.js";
import { LocalizationIdentity, TextKey, TextNamespace } from "./schema.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const identity = (namespace: string, key: string) =>
	LocalizationIdentity.make({ namespace: TextNamespace.make(namespace), key: TextKey.make(key) });

function parsed(bytes: Uint8Array): PODocument {
	const result = parsePO(bytes);
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

function rewrite(document: PODocument, edits: readonly POTranslationEdit[]) {
	const result = replacePOTranslations(document, edits);
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

function failureCode(document: PODocument, edits: readonly POTranslationEdit[]) {
	const result = replacePOTranslations(document, edits);
	return Result.isFailure(result) ? result.failure.code : undefined;
}

const fixturePO = resolve(
	"fixtures/unreal-project/Content/Localization/FixtureGame/de/FixtureGame.po"
);

describe("PO translation writer", () => {
	it("rewrites only the edited msgstr line of a real Unreal PO file", () => {
		const input = readFileSync(fixturePO);
		const document = parsed(input);
		const named = identity("Fixture.Localization.Table", "NamedArgument");
		const output = serializePO(
			rewrite(document, [{ identity: named, translation: "Gespräch mit {PlayerName}" }])
		);
		const before = decoder.decode(input).split("\n");
		const after = decoder.decode(output).split("\n");
		expect(after).toHaveLength(before.length);
		const changed = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
		expect(changed).toHaveLength(1);
		// The writer keeps the line's original ending, whichever Unreal wrote.
		expect(after[changed[0] ?? -1]?.replace(/\r$/u, "")).toBe(
			'msgstr "Gespräch mit {PlayerName}"'
		);
		expect([...output.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const entry = parsed(output).blocks.find(
			(block) => block.entry?.identity?.key === "NamedArgument"
		)?.entry;
		expect(entry?.msgstr["0"]).toBe("Gespräch mit {PlayerName}");
		expect(entry?.msgid).toBe("Talking with {PlayerName}");
	});

	it("escapes like Unreal's exporter and round-trips quotes, tabs and line breaks", () => {
		const document = parsed(encoder.encode('msgctxt "NS,Key"\nmsgid "Source"\nmsgstr "Old"\n'));
		const translation = 'Say "hi"\tthen\r\nleave \\ here';
		const output = serializePO(
			rewrite(document, [{ identity: identity("NS", "Key"), translation }])
		);
		expect(decoder.decode(output)).toBe(
			'msgctxt "NS,Key"\nmsgid "Source"\nmsgstr "Say \\"hi\\"\\tthen\\r\\nleave \\\\ here"\n'
		);
		expect(parsed(output).blocks[0]?.entry?.msgstr["0"]).toBe(translation);
		expect(escapePOString("a\\b")).toBe("a\\\\b");
	});

	it("collapses a wrapped msgstr into one line and keeps the block's line endings", () => {
		const input = encoder.encode(
			'msgctxt "NS,Key"\r\nmsgid "Source"\r\nmsgstr ""\r\n"First "\r\n"second"\r\n\r\nmsgctxt "NS,Other"\r\nmsgid "Other"\r\nmsgstr "Kept"\r\n'
		);
		const output = decoder.decode(
			serializePO(
				rewrite(parsed(input), [{ identity: identity("NS", "Key"), translation: "Neu" }])
			)
		);
		expect(output).toBe(
			'msgctxt "NS,Key"\r\nmsgid "Source"\r\nmsgstr "Neu"\r\n\r\nmsgctxt "NS,Other"\r\nmsgid "Other"\r\nmsgstr "Kept"\r\n'
		);
	});

	it("writes raw Unicode separators and round-trips them through the parser", () => {
		const document = parsed(encoder.encode('msgctxt "NS,Key"\nmsgid "Source"\nmsgstr "Old"\n'));
		const translation = "\u2028First\u2029Second\u2028";
		expect(escapePOString(translation)).toBe(translation);
		const output = serializePO(
			rewrite(document, [{ identity: identity("NS", "Key"), translation }])
		);
		expect(decoder.decode(output)).toBe(
			`msgctxt "NS,Key"\nmsgid "Source"\nmsgstr "${translation}"\n`
		);
		const reparsed = parsed(output);
		expect(reparsed.blocks[0]?.entry?.msgstr["0"]).toBe(translation);
		expect(serializePO(reparsed)).toEqual(output);
	});

	it("identifies Crowdin entries by their msgid key", () => {
		const input = encoder.encode(
			'msgid ""\nmsgstr "X-Crowdin-SourceKey: msgstr\\n"\n\nmsgid "NS,Key"\nmsgstr "Old"\n'
		);
		const output = serializePO(
			rewrite(parsed(input), [{ identity: identity("NS", "Key"), translation: "New" }])
		);
		expect(decoder.decode(output)).toContain('msgid "NS,Key"\nmsgstr "New"\n');
	});

	it("rejects missing, ambiguous, plural, duplicate and import-unsafe edits", () => {
		const document = parsed(
			encoder.encode(
				'msgctxt "NS,Key"\nmsgid "A"\nmsgstr "a"\n\nmsgctxt "NS,Key"\nmsgid "B"\nmsgstr "b"\n\nmsgctxt "NS,Plural"\nmsgid "One"\nmsgid_plural "Many"\nmsgstr[0] "x"\nmsgstr[1] "y"\n'
			)
		);
		expect(
			failureCode(document, [{ identity: identity("NS", "Missing"), translation: "x" }])
		).toBe("entry_not_found");
		expect(failureCode(document, [{ identity: identity("NS", "Key"), translation: "x" }])).toBe(
			"ambiguous_entry"
		);
		expect(
			failureCode(document, [{ identity: identity("NS", "Plural"), translation: "x" }])
		).toBe("plural_entry");
		const single = parsed(encoder.encode('msgctxt "NS,One"\nmsgid "A"\nmsgstr "a"\n'));
		const edit = { identity: identity("NS", "One"), translation: "b" };
		expect(failureCode(single, [edit, edit])).toBe("duplicate_edit");
		expect(
			failureCode(single, [{ identity: identity("NS", "One"), translation: "C:\\new" }])
		).toBe("unsafe_escape");
	});
});

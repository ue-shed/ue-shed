import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodePOEscapes, parsePO, parsePOIdentity, serializePO } from "./po.js";
import { defaultLocalizationLimits, LocalizationError } from "./schema.js";

function success<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}
const bytes = (text: string) => new TextEncoder().encode(text);

describe("lossless PO documents", () => {
	for (const { project, target, directory } of [
		{
			project: "unreal-project",
			target: "FixtureGame",
			directory: resolve("fixtures/unreal-project/Content/Localization/FixtureGame")
		},
		{
			project: "unreal-427-localization",
			target: "Fixture427",
			directory: resolve("fixtures/unreal-427-localization/Content/Localization/Fixture427")
		},
		{
			project: "unreal-project/ue5.8-output",
			target: "FixtureGame",
			directory: resolve("fixtures/unreal-project/FixtureExpected/localization/ue5.8-output")
		}
	]) {
		for (const culture of ["de", "en", "fr"]) {
			it(`round trips every byte of ${project}/${culture}`, () => {
				const input = readFileSync(resolve(directory, culture, `${target}.po`));
				const document = success(parsePO(input));
				expect(Buffer.from(serializePO(document))).toEqual(input);
				expect(document.bom).toBe(true);
				expect(document.blocks[0]?.kind).toBe("header");
				expect(document.hasSourceText).toBe(true);
				expect(document.blocks.filter((block) => block.kind === "entry")).toHaveLength(
					target === "FixtureGame" ? 14 : 3
				);
				expect(Object.isFrozen(document.blocks)).toBe(true);
			});
		}
	}

	for (const ending of ["\r\n", "\n"]) {
		for (const trailing of [true, false]) {
			it(`preserves ${JSON.stringify(ending)} with trailing newline ${trailing}`, () => {
				const input = bytes(
					[
						"# translator",
						"#. extracted",
						"#: source:12",
						"#, fuzzy, c-format",
						'#| msgid "Before"',
						'msgctxt ",Key"',
						'msgid ""',
						'"Hello "',
						'"world"',
						'msgstr ""',
						'"Bonjour "',
						'"monde"'
					].join(ending) + (trailing ? ending : "")
				);
				const document = success(parsePO(input));
				expect(serializePO(document)).toEqual(input);
				const block = document.blocks[0];
				expect(block?.entry).toMatchObject({
					msgctxt: ",Key",
					msgid: "Hello world",
					msgstr: { "0": "Bonjour monde" },
					identity: { namespace: "", key: "Key" },
					translatorComments: ["translator"],
					extractedComments: ["extracted"],
					referenceComments: ["source:12"],
					flags: ["fuzzy", "c-format"],
					previousMsgidLines: ['#| msgid "Before"']
				});
				expect(block?.fields.find((field) => field.name === "msgstr")?.lineIndices).toEqual(
					[9, 10, 11]
				);
			});
		}
	}

	it("decodes escaped commas, Unreal escapes and multiline strings in the correct order", () => {
		const input = bytes(String.raw`msgctxt "NS\\,part,Key\\,part"
msgid "quote: \" slash: \\ cr: \r lf: \n tab: \t"
msgstr "translated"`);
		const document = success(parsePO(input));
		expect(serializePO(document)).toEqual(input);
		expect(document.blocks[0]?.entry?.identity).toEqual({
			namespace: "NS,part",
			key: "Key,part"
		});
		expect(document.blocks[0]?.entry?.msgid).toBe('quote: " slash: \\ cr: \r lf: \n tab: \t');
		expect(decodePOEscapes(String.raw`\\n`)).toBe("\\\n");
		expect(success(parsePOIdentity("Namespace"))).toEqual({ namespace: "Namespace", key: "" });
	});

	it("retains plural fields and indexed translations", () => {
		const input = bytes(
			'msgctxt "N,K"\nmsgid "one"\nmsgid_plural "many"\nmsgstr[0] "un"\nmsgstr[1] "plusieurs"'
		);
		const document = success(parsePO(input));
		expect(document.blocks[0]?.entry?.msgidPlural).toBe("many");
		expect(document.blocks[0]?.entry?.msgstr).toEqual({ "0": "un", "1": "plusieurs" });
		expect(serializePO(document)).toEqual(input);
	});

	it("detects Crowdin headers or explicit format and reports absence of source text", () => {
		const input = bytes(
			'msgid ""\nmsgstr ""\n"X-Crowdin-SourceKey: msgstr\\n"\n\nmsgid "Namespace,Key"\nmsgstr "Translated"\n'
		);
		const document = success(parsePO(input));
		expect(document.format).toBe("Crowdin");
		expect(document.hasSourceText).toBe(false);
		expect(document.blocks[1]?.entry?.identity).toEqual({ namespace: "Namespace", key: "Key" });
		expect(serializePO(document)).toEqual(input);
		expect(
			success(parsePO(bytes('msgid ",K"\nmsgstr "Translation"'), { format: "Crowdin" }))
				.blocks[0]?.entry?.identity
		).toEqual({ namespace: "", key: "K" });
	});

	it("preserves trivia, obsolete entries, mixed endings, extra blank lines and BOM", () => {
		const input = bytes(
			'\uFEFF\r\n\n#~ msgid "old"\r\n#~ msgstr "previous"\n\n\n# next\rmsgctxt "N,K"\nmsgid "Source"\r\nmsgstr "Translation"\n\n'
		);
		expect(serializePO(success(parsePO(input)))).toEqual(input);
	});

	it("keeps source text in the legacy namespace-collapse mapping, including configured Crowdin", () => {
		const input = bytes('msgctxt "Namespace"\nmsgid "Source"\nmsgstr "Translation"');
		const document = success(
			parsePO(input, { format: "Crowdin", collapseMode: "IdenticalNamespaceAndSource" })
		);
		expect(document.hasSourceText).toBe(true);
		expect(document.blocks[0]?.entry?.identity).toEqual({ namespace: "Namespace", key: "" });
		expect(document.blocks[0]?.entry?.msgid).toBe("Source");
		expect(serializePO(document)).toEqual(input);
	});

	it("handles adjacent entries without blank separators", () => {
		const input = bytes(
			'msgctxt "N,A"\nmsgid "A"\nmsgstr "B"\nmsgctxt "N,C"\nmsgid "C"\nmsgstr "D"'
		);
		const document = success(parsePO(input));
		expect(document.blocks).toHaveLength(2);
		expect(serializePO(document)).toEqual(input);
	});

	it("returns typed failures without leaking malformed entry text", () => {
		for (const input of [
			'msgid "private"',
			'msgid "private\nmsgstr "x"',
			'"orphan"',
			'msgid "private"\nmsgstr[bad] "x"',
			'msgid "private"\nmsgid "again"\nmsgstr "x"'
		]) {
			const result = parsePO(bytes(input));
			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure).toBeInstanceOf(LocalizationError);
				expect(result.failure.code).toBe("malformed_po");
				expect(result.failure.message).not.toContain("private");
			}
		}
		const oversized = parsePO(bytes('msgid "a"\nmsgstr "b"'), {
			limits: { ...defaultLocalizationLimits, maxFileBytes: 1 }
		});
		expect(Result.isFailure(oversized) && oversized.failure.code).toBe("limit_exceeded");
		const tooMany = parsePO(bytes('msgid "a"\nmsgstr "b"\n\nmsgid "c"\nmsgstr "d"'), {
			limits: { ...defaultLocalizationLimits, maxEntries: 1 }
		});
		expect(Result.isFailure(tooMany) && tooMany.failure.code).toBe("limit_exceeded");
		expect(parsePO(new Uint8Array([0xff]))._tag).toBe("Failure");
	});
});

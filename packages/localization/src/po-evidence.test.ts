import { Result, Schema } from "effect";
import { expect, it } from "vitest";
import { parsePO, projectPOEvidence } from "./po.js";
import { POEvidence } from "./schema.js";

it("preserves every decoded entry and comment while omitting serialization data", () => {
	const parsed = parsePO(
		new TextEncoder().encode(
			'msgid ""\r\nmsgstr "Header\\n"\r\n\r\n# translator\r\n#. Key: K\r\n#: source:12\r\n#, fuzzy\r\n#| msgid "Previous"\r\nmsgctxt "N,K"\r\nmsgid ""\r\n"Source\u2028"\r\nmsgid_plural "Sources"\r\nmsgstr[0] "Translation"\r\nmsgstr[1] "Translations"\r\n\r\n#~ msgid "obsolete"'
		)
	);
	if (Result.isFailure(parsed)) throw parsed.failure;
	const evidence = projectPOEvidence(parsed.success);
	expect(evidence).toEqual({
		format: parsed.success.format,
		hasSourceText: parsed.success.hasSourceText,
		entries: [parsed.success.blocks.find((block) => block.kind === "entry")?.entry]
	});
	expect(Schema.decodeUnknownSync(POEvidence)(evidence)).toEqual(evidence);
	expect(Object.isFrozen(evidence.entries[0]?.extractedComments)).toBe(true);
	expect(evidence.entries[0]).not.toBe(
		parsed.success.blocks.find((block) => block.kind === "entry")?.entry
	);
});

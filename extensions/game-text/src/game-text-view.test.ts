import {
	decodeTextOccurrenceId,
	decodeTextUnitId,
	type TextCorpus
} from "@ue-shed/game-text/browser";
import { describe, expect, it } from "vitest";
import { filterTextUnits, identityLabel, occurrenceContext, sourceText } from "./game-text-view.js";

const corpus: TextCorpus = {
	schemaVersion: 1,
	status: "complete",
	coverage: {
		discoveredPackages: 1,
		inspectedPackages: 1,
		partialPackages: 0,
		failedPackages: 0,
		textUnits: 1,
		textOccurrences: 1,
		resolvedOccurrences: 1,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	units: [
		{
			id: decodeTextUnitId("unreal:UI:Continue"),
			source: { status: "consistent", value: "Continue" },
			identity: { status: "resolved", namespace: "UI", key: "Continue" },
			occurrences: [
				{
					id: decodeTextOccurrenceId("occurrence:continue"),
					packageFile: "Content/Text/ST_Game.uasset",
					source: "Continue",
					identity: { status: "resolved", namespace: "UI", key: "Continue" },
					location: {
						kind: "string_table_entry",
						objectPath: "/Game/Text/ST_Game.ST_Game",
						entryKey: "PromptContinue"
					},
					editCapability: "source_editable"
				}
			]
		}
	],
	diagnostics: []
};

describe("game text presentation", () => {
	it("filters the corpus by searchable context and edit capability", () => {
		expect(
			filterTextUnits({ corpus, query: "PromptContinue", capability: "all" })
		).toHaveLength(1);
		expect(
			filterTextUnits({ corpus, query: "Continue", capability: "read_only" })
		).toHaveLength(0);
	});

	it("formats writing context without hiding Unreal identity", () => {
		const unit = corpus.units[0]!;
		expect(sourceText(unit)).toBe("Continue");
		expect(identityLabel(unit)).toBe("UI · Continue");
		expect(occurrenceContext(unit.occurrences[0]!)).toBe("String Table · PromptContinue");
	});
});

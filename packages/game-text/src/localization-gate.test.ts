import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	DEFAULT_GATE_FAILURES,
	localizationGateFailures,
	localizationGateResult,
	localizationGateTarget,
	type LocalizationGateCheck
} from "./localization-gate.js";
import { applyLocalizationKeyChanges, localizationKeyChanges } from "./localization-key-changes.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	unit
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.js";
import { TextUnit, type TextCorpus } from "./schema.js";

const MENU = "Content/Text/DT_Menu.uasset";

function cell(key: string, source: string, id = `unit:${key}`): TextUnit {
	return Schema.decodeUnknownSync(TextUnit)({
		id,
		source: { status: "consistent", value: source },
		identity: { status: "resolved", namespace: "NS", key },
		occurrences: [
			{
				id: `occurrence:${id}`,
				devNotes: "",
				packageFile: MENU,
				source,
				identity: { status: "resolved", namespace: "NS", key },
				editCapability: "source_editable",
				location: {
					kind: "data_table_cell",
					objectPath: "/Game/Text/DT_Menu.DT_Menu",
					row: key,
					propertyPath: "Label"
				}
			}
		]
	});
}

function scanned(units: readonly TextUnit[]): TextCorpus {
	return {
		...corpus(units),
		packageCoverage: [
			{ packageFile: "Content/Text/Table.uasset", status: "complete" },
			{ packageFile: MENU, status: "complete" }
		]
	};
}

const place = (row: string) => `/Game/Text/DT_Menu.DT_Menu.${row}.Label`;

function gate(
	text: TextCorpus,
	evidenceFor: Parameters<typeof joinLocalizationTarget>[1],
	files: readonly string[] = [MENU],
	failOn: readonly LocalizationGateCheck[] = DEFAULT_GATE_FAILURES
) {
	const joined = joinLocalizationTarget(text, evidenceFor);
	const join = applyLocalizationKeyChanges(joined, localizationKeyChanges(joined, text).pairs);
	return localizationGateTarget({
		corpus: text,
		query: textCorpusQuery(text, undefined, join),
		join,
		files,
		failOn
	});
}

describe("checking a change's text", () => {
	it("fails a key change whose earlier key has translations, and names the way forward", () => {
		const result = gate(
			scanned([cell("Start", "Start game")]),
			evidence(
				[manifestEntry("OldStart", "Start game", place("Start"))],
				[archiveEntry("OldStart", "Start game", "Spiel starten")]
			)
		);
		expect(result.status).toBe("failed");
		expect(result.checks.key_changed).toBe(1);
		// The earlier key is the same change, so it is not also reported as removed text.
		expect(result.checks.removed).toBe(0);
		expect(result.items[0]).toMatchObject({
			check: "key_changed",
			severity: "fail",
			namespace: "NS",
			key: "Start",
			file: "Content/Text/DT_Menu"
		});
		expect(result.items[0]?.guidance).toContain("NS,OldStart");
		expect(result.items[0]?.guidance).toContain("loc run prepare --carry");
	});

	it("only warns about a key change that loses nothing", () => {
		const result = gate(
			scanned([cell("Start", "Start game")]),
			evidence([manifestEntry("OldStart", "Start game", place("Start"))], [])
		);
		expect(result.status).toBe("passed");
		expect(result.checks.key_changed).toBe(0);
		expect(result.items.map((item) => [item.check, item.severity])).toEqual([
			["not_gathered", "warn"]
		]);
	});

	it("fails text changed after translation and warns about untranslated changes", () => {
		const result = gate(
			scanned([cell("Hello", "Hello there"), cell("Bye", "Goodbye now")]),
			evidence(
				[
					manifestEntry("Hello", "Hello", place("Hello")),
					manifestEntry("Bye", "Goodbye", place("Bye"))
				],
				[archiveEntry("Hello", "Hello", "Hallo")]
			)
		);
		expect(result.status).toBe("failed");
		expect(result.items.map((item) => [item.key, item.check, item.severity])).toEqual([
			["Hello", "translated_text_changed", "fail"],
			["Bye", "text_changed", "warn"]
		]);
	});

	it("fails one key with two texts", () => {
		const result = gate(
			scanned([cell("Title", "Main menu"), cell("Title", "Main Menu", "unit:Title:2")]),
			evidence([manifestEntry("Title", "Main menu", place("Title"))], [])
		);
		expect(result.status).toBe("failed");
		expect(result.checks.conflicting_source).toBe(1);
	});

	it("warns about removed text and text gathered from changed source files", () => {
		const result = gate(
			scanned([]),
			evidence(
				[
					manifestEntry("Gone", "Removed line", place("Gone")),
					manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)")
				],
				[archiveEntry("Gone", "Removed line", "Entfernt")]
			),
			[MENU, "Source/Game/Private/Menu.cpp"]
		);
		expect(result.status).toBe("passed");
		expect(result.checks.removed).toBe(1);
		expect(result.checks.gathered_source).toBe(1);
		expect(result.items.find((item) => item.check === "gathered_source")?.file).toBe(
			"Source/Game/Private/Menu.cpp"
		);
	});

	it("ignores text in files the change does not touch", () => {
		const result = gate(
			scanned([cell("Start", "Start game"), unit("Other", "Elsewhere")]),
			evidence(
				[manifestEntry("OldStart", "Start game", place("Start"))],
				[archiveEntry("OldStart", "Start game", "Spiel starten")]
			),
			["Content/Text/Table.uasset"]
		);
		expect(result.status).toBe("passed");
		expect(result.lines).toBe(1);
		expect(result.fileScope).toMatchObject({ files: 1, textFiles: 1, outside: 0 });
	});

	it("follows a project's policy", () => {
		expect(localizationGateFailures()).toEqual(DEFAULT_GATE_FAILURES);
		const failOn = localizationGateFailures(["not_gathered"], ["key_changed"]);
		expect(failOn).toEqual(["conflicting_source", "translated_text_changed", "not_gathered"]);
		const result = gate(
			scanned([cell("Start", "Start game")]),
			evidence(
				[manifestEntry("OldStart", "Start game", place("Start"))],
				[archiveEntry("OldStart", "Start game", "Spiel starten")]
			),
			[MENU],
			failOn
		);
		expect(result.items.map((item) => item.severity)).toEqual(["warn"]);
		expect(result.status).toBe("passed");
		expect(localizationGateResult([result], failOn).status).toBe("passed");
	});

	it("lists a bounded number of lines and counts the rest", () => {
		const units = Array.from({ length: 230 }, (_, index) =>
			cell(`New${index}`, `Line ${index}`)
		);
		const result = gate(scanned(units), evidence([], []));
		expect(result.checks.not_gathered).toBe(230);
		expect(result.items).toHaveLength(200);
		expect(result.omitted).toBe(30);
	});
});

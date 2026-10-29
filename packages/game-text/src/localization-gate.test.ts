import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	DEFAULT_GATE_FAILURES,
	localizationGateFailures,
	localizationGateResult,
	localizationGateTarget,
	localizationGateUnreadEvidence,
	localizationGateUnreadPackages,
	localizationGatePartialPackages,
	LOCALIZATION_GATE_FIELDS,
	type LocalizationGateCheck
} from "./localization-gate.js";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import {
	LocalizationError,
	LocalizationTargetName,
	type LocalizationTargetEvidence
} from "@ue-shed/localization/browser";
import { localizationKeyChanges } from "./localization-key-changes.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	ftextUnit,
	manifestEntry,
	unit
} from "./localization.test-support.js";
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
	files: LocalizationTargetEvidence,
	changed: readonly string[] = [MENU],
	failOn: readonly LocalizationGateCheck[] = DEFAULT_GATE_FAILURES
) {
	const joined = joinLocalizationTarget(text, files);
	const keyChangePairs = localizationKeyChanges(joined, text).pairs;
	return withIndexedCorpus(text, { files, keyChangePairs }, ({ query, localization }) =>
		Effect.gen(function* () {
			const base = {
				query: "",
				capability: "all" as const,
				localization: { target: localization.target },
				where: { files: changed }
			};
			const fileScope = (yield* query.search({ ...base, pageSize: 1 })).fileScope;
			return localizationGateTarget({
				lines: yield* query.selectLocalizationLines(base, LOCALIZATION_GATE_FIELDS),
				...(fileScope === undefined ? undefined : { fileScope }),
				join: localization,
				files: changed,
				failOn
			});
		})
	);
}

describe("checking a change's text", () => {
	it.live(
		"recognizes translated saved package namespaces without reporting a new or removed key",
		() =>
			Effect.gen(function* () {
				const result = yield* gate(
					corpus([ftextUnit("K", "Source", "Content/Text/Table.uasset", "NS [PKG]")]),
					evidence(),
					["Content/Text/Table.uasset"]
				);
				expect(result.status).toBe("passed");
				expect(result.lines).toBe(1);
				expect(result.checks.not_gathered).toBe(0);
				expect(result.checks.removed).toBe(0);
				expect(result.items).toEqual([]);
			})
	);

	it.live.each(["Source", "Other"])("judges package variants as one identity (%s)", (source) =>
		Effect.gen(function* () {
			const first = ftextUnit("K", "Source", "Content/Text/Table.uasset", "NS [A]");
			const second = TextUnit.make({
				...ftextUnit("K", source, "Content/Text/Other.uasset", "NS [B]"),
				id: TextUnit.fields.id.make("unit:other")
			});
			const text = corpus([first, second]);
			const result = yield* gate(text, evidence(), ["Content/Text/Table.uasset"]);
			expect(result.lines).toBe(1);
			expect(result.status).toBe(source === "Source" ? "passed" : "failed");
			expect(result.checks.conflicting_source).toBe(source === "Source" ? 0 : 1);
			expect(result.checks.not_gathered).toBe(0);
		})
	);

	it.live(
		"fails a key change whose earlier key has translations, and names the way forward",
		() =>
			Effect.gen(function* () {
				const result = yield* gate(
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
				expect(result.items[0]?.guidance).toContain(
					"Carry the translations to the new key"
				);
			})
	);

	it.live("only warns about a key change that loses nothing", () =>
		Effect.gen(function* () {
			const result = yield* gate(
				scanned([cell("Start", "Start game")]),
				evidence([manifestEntry("OldStart", "Start game", place("Start"))], [])
			);
			expect(result.status).toBe("passed");
			expect(result.checks.key_changed).toBe(0);
			expect(result.items.map((item) => [item.check, item.severity])).toEqual([
				["not_gathered", "warn"]
			]);
		})
	);

	it.live("fails text changed after translation and warns about untranslated changes", () =>
		Effect.gen(function* () {
			const result = yield* gate(
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
		})
	);

	it.live("fails one key with two texts", () =>
		Effect.gen(function* () {
			const result = yield* gate(
				scanned([cell("Title", "Main menu"), cell("Title", "Main Menu", "unit:Title:2")]),
				evidence([manifestEntry("Title", "Main menu", place("Title"))], [])
			);
			expect(result.status).toBe("failed");
			expect(result.checks.conflicting_source).toBe(1);
		})
	);

	it.live("warns about removed text and text gathered from changed source files", () =>
		Effect.gen(function* () {
			const result = yield* gate(
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
		})
	);

	it.live("ignores text in files the change does not touch", () =>
		Effect.gen(function* () {
			const result = yield* gate(
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
		})
	);

	it.live("follows a project's policy", () =>
		Effect.gen(function* () {
			expect(localizationGateFailures()).toEqual(DEFAULT_GATE_FAILURES);
			const failOn = localizationGateFailures(["not_gathered"], ["key_changed"]);
			expect(failOn).toEqual([
				"conflicting_source",
				"translated_text_changed",
				"not_gathered"
			]);
			const result = yield* gate(
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
		})
	);

	it.live("names the listed file when a line lives in several", () =>
		Effect.gen(function* () {
			const shared = Schema.decodeUnknownSync(TextUnit)({
				...Schema.encodeSync(TextUnit)(cell("Hello", "Hello there")),
				occurrences: [
					...Schema.encodeSync(TextUnit)(cell("Hello", "Hello there")).occurrences,
					{
						...Schema.encodeSync(TextUnit)(cell("Hello", "Hello there")).occurrences[0],
						id: "occurrence:other",
						packageFile: "Content/Text/Other.uasset"
					}
				]
			});
			const result = yield* gate(
				scanned([shared]),
				evidence(
					[manifestEntry("Hello", "Hello", place("Hello"))],
					[archiveEntry("Hello", "Hello", "Hallo")]
				),
				["Content/Text/Other.uasset"]
			);
			expect(result.items[0]).toMatchObject({
				check: "translated_text_changed",
				file: "Content/Text/Other"
			});
		})
	);

	it("treats unreadable evidence and unread packages as unknown, never as absent", () => {
		const base = evidence([manifestEntry("Hello", "Hello", place("Hello"))]);
		const culture = base.cultures[1];
		if (culture === undefined) throw new Error("The evidence helper produced one culture.");
		const unreadable = {
			...base,
			cultures: [
				...base.cultures.slice(0, 1),
				{
					...culture,
					archive: {
						status: "failed" as const,
						relativePath: "Content/Localization/Test/de/Test.archive",
						error: new LocalizationError({
							code: "malformed_json",
							message: "The archive is not JSON.",
							recovery: "Restore it.",
							retrySafe: true,
							nextStep: "fix_input"
						})
					},
					po: {
						status: "failed" as const,
						relativePath: null,
						error: new LocalizationError({
							code: "file_missing",
							message: "No PO file.",
							recovery: "Export one.",
							retrySafe: true,
							nextStep: "fix_input"
						})
					}
				}
			]
		};
		// A missing PO file is no translation; an unreadable archive is unknown.
		expect(localizationGateUnreadEvidence(base)).toEqual([]);
		expect(localizationGateUnreadEvidence(unreadable)).toEqual([
			"Content/Localization/Test/de/Test.archive (malformed_json)"
		]);
		const partial: TextCorpus = {
			...scanned([]),
			packageCoverage: [
				{ packageFile: MENU, status: "failed" },
				{ packageFile: "Content/Text/Table.uasset", status: "partial" },
				{ packageFile: "Content/Text/Untouched.uasset", status: "failed" },
				// Unreal's gather does not select it, so it holds no gathered text to check.
				{ packageFile: "Content/Art/M_Glow.uasset", status: "not_gatherable" }
			]
		};
		const listed = [MENU, "Content/Text/Table.uasset", "Content/Art/M_Glow.uasset"];
		// Only a package the scan could not read at all stops the check.
		expect(localizationGateUnreadPackages(partial, listed)).toEqual([
			"Content/Text/DT_Menu (failed)"
		]);
		// One read in part is listed with what was not read, from its diagnostic.
		const diagnosed: TextCorpus = {
			...partial,
			diagnostics: [
				{
					code: "package_partially_decoded",
					message:
						"67 properties were not decoded: 67 unavailable for this engine version.",
					packageFile: "Content\\Text\\Table.uasset",
					propertyPath: "Pins",
					coverageGapCounts: {
						unsupported_text_history: 2,
						legacy_container_element_without_type_information: 0,
						feature_unavailable_for_engine_version: 65,
						property_decoder_rejected: 0
					}
				}
			]
		};
		expect(localizationGatePartialPackages(diagnosed, listed)).toEqual([
			{
				file: "Content/Text/Table",
				guidance:
					"67 properties were not read, such as `Pins`: a kind of text the reader does not support (2), not decoded for this engine version (65). Text there is not checked; the package's other text is. Review those parts in Unreal."
			}
		]);
		const single: TextCorpus = {
			...partial,
			diagnostics: [
				{
					code: "package_partially_decoded",
					message: "1 property was not decoded.",
					packageFile: "Content/Text/Table.uasset",
					propertyPath: "Pins",
					coverageGapCounts: {
						unsupported_text_history: 0,
						legacy_container_element_without_type_information: 0,
						feature_unavailable_for_engine_version: 0,
						property_decoder_rejected: 1
					}
				}
			]
		};
		expect(localizationGatePartialPackages(single, listed)[0]?.guidance).toBe(
			"1 property was not read (`Pins`): rejected by the reader's decoder. Text there is not checked; the package's other text is. Review those parts in Unreal."
		);
		expect(localizationGatePartialPackages(partial, listed)[0]?.guidance).toBe(
			"Part of this package could not be read. Text there is not checked; the package's other text is. Review those parts in Unreal."
		);
		// It warns unless the project makes it fail.
		const policies: readonly (readonly LocalizationGateCheck[])[] = [
			DEFAULT_GATE_FAILURES,
			[...DEFAULT_GATE_FAILURES, "partial_read"]
		];
		for (const failOn of policies) {
			const target = localizationGateTarget({
				lines: [],
				join: {
					target: Schema.decodeUnknownSync(LocalizationTargetName)("Test"),
					nativeCulture: cultureCode("en")
				},
				files: listed,
				failOn,
				partial: localizationGatePartialPackages(diagnosed, listed)
			});
			const failing = failOn.includes("partial_read");
			expect(target).toMatchObject({
				status: failing ? "failed" : "passed",
				checks: { partial_read: 1 },
				items: [{ check: "partial_read", severity: failing ? "fail" : "warn", key: null }]
			});
		}
		expect(localizationGateUnreadPackages(scanned([]), [MENU])).toEqual([]);
	});

	it.live("lists a bounded number of lines and counts the rest", () =>
		Effect.gen(function* () {
			const units = Array.from({ length: 230 }, (_, index) =>
				cell(`New${index}`, `Line ${index}`)
			);
			const result = yield* gate(scanned(units), evidence([], []));
			expect(result.checks.not_gathered).toBe(230);
			expect(result.items).toHaveLength(200);
			expect(result.omitted).toBe(30);
		})
	);
});

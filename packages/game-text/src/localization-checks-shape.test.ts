import { indexedTestReports } from "./indexed-reports.test-support.js";
import { Effect, Schema } from "effect";
import { parsePO } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence as sharedEvidence,
	ftextUnit,
	manifestEntry,
	success,
	target,
	unit
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { localizationCheckCatalogue } from "./localization-check-catalogue.js";
import {
	type LocalizationCheckOptions,
	type LocalizationQualityFinding,
	LocalizationQualityReport
} from "./localization-quality-schema.js";
import {
	WorkspaceQualityPage,
	localizationQuality,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf,
	workspaceQualityCsv
} from "./localization-workspace.js";
import { STARTER_CHECK_RULES, STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import type { BuiltInCheckId } from "./localization-check-ids.js";
import {
	type BuiltInCheckEntry,
	GameTextRuleDocument,
	isBuiltInCheckEntry
} from "./game-text-rules.js";
import { TextUnit, type TextCorpus } from "./schema.js";
const noPO = () => success(parsePO(new TextEncoder().encode("")));
const provenance = {
	relativePath: "Content/Localization/Test",
	size: 1,
	modifiedTime: "2026-01-01T00:00:00Z",
	contentHash: "hash"
};
/** Shape cases use an unchanged native source; foreign translations vary independently. */
function evidence(...args: Parameters<typeof sharedEvidence>): ReturnType<typeof sharedEvidence> {
	const [manifests = [manifestEntry()], archives, po] = args;
	return sharedEvidence(
		manifests,
		archives,
		po,
		manifests.map((entry) =>
			archiveEntry(entry.key, entry.source.Text, entry.source.Text, entry.namespace)
		)
	);
}
function report(
	text: TextCorpus,
	files: ReturnType<typeof evidence>,
	options: LocalizationCheckOptions = {},
	rules: GameTextRuleDocument = STARTER_CHECK_RULES
) {
	const joined = joinLocalizationTarget(text, files, files.target);
	return {
		joined,
		report: indexedTestReports(text, files).localization(rules, options)
	};
}
/** One gathered line with an unchanged native source and a foreign translation. */
function line(
	source: string,
	translation: string,
	options: LocalizationCheckOptions = {},
	rules: GameTextRuleDocument = STARTER_CHECK_RULES
) {
	const text = corpus([unit("K", source)]);
	return report(
		text,
		evidence([manifestEntry("K", source)], [archiveEntry("K", source, translation)], noPO()),
		options,
		rules
	).report;
}
/** Parameters for some built-in checks, as a rules file writes them. */
type CheckParams = {
	readonly [Id in BuiltInCheckId]?: Extract<
		typeof BuiltInCheckEntry.Encoded,
		{ readonly kind: Id }
	>["params"];
};
/** The starter file, with these checks' parameters; a check it doesn't list is added. */
const starter = (params: CheckParams = {}) =>
	Schema.decodeUnknownSync(GameTextRuleDocument)({
		...STARTER_GAME_TEXT_RULES,
		rules: [
			...STARTER_GAME_TEXT_RULES.rules.map((entry) =>
				isBuiltInCheckEntry(entry) && entry.kind in params
					? { ...entry, params: params[entry.kind] }
					: entry
			),
			...Object.entries(params)
				.filter(
					([kind]) => !STARTER_GAME_TEXT_RULES.rules.some((entry) => entry.kind === kind)
				)
				.map(([kind, value]) => ({ kind, params: value }))
		]
	});
/** The kinds a line's German translation gets. */
const kinds = (value: LocalizationQualityReport) =>
	findings(value)
		.filter((finding) => finding.culture === "de")
		.map((finding) => finding.kind);
function findings(value: LocalizationQualityReport): readonly LocalizationQualityFinding[] {
	return value.findings.filter(
		(finding): finding is LocalizationQualityFinding => "culture" in finding
	);
}
function kind<K extends LocalizationQualityFinding["kind"]>(
	value: LocalizationQualityReport,
	wanted: K,
	culture?: string
) {
	return findings(value).filter(
		(
			finding
		): finding is Extract<
			LocalizationQualityFinding,
			{
				kind: K;
			}
		> => finding.kind === wanted && (culture === undefined || finding.culture === culture)
	);
}
/** A second saved unit for an existing key, in another asset. */
function another(key: string, source: string, objectPath: string): TextUnit {
	const base = unit(key, source);
	return Schema.decodeUnknownSync(TextUnit)({
		...base,
		id: `unit:${key}:${objectPath}`,
		occurrences: base.occurrences.map((occurrence) => ({
			...occurrence,
			id: `occurrence:${key}:${objectPath}`,
			location: { ...occurrence.location, objectPath }
		}))
	});
}
describe("translation shape checks", () => {
	it("lets a translation add optional arguments, their tags and optional tags", () => {
		const optionalArguments = ["ParentLabel"],
			optionalTags = ["italic"];
		const optional = starter({
			format_arguments: { optionalArguments },
			format_argument_renamed: { optionalArguments },
			rich_text_tag_case: { optionalArguments },
			rich_text_tags: { optionalTags, optionalArguments },
			rich_text_tags_added: { optionalTags, optionalArguments }
		});
		const added = "<PlayerName>{ParentLabel}</>, cookie! Yummy nummy!";
		expect(kinds(line("Cookie! Yummy nummy!", added))).toEqual(
			expect.arrayContaining(["format_arguments", "rich_text_tags_added"])
		);
		expect(kinds(line("Cookie! Yummy nummy!", added, {}, optional))).toEqual([]);
		// Dropping a source's optional argument is still reported.
		expect(
			kinds(line("<PlayerName>{ParentLabel}</>, cookie!", "Keks!", {}, optional))
		).toContain("format_arguments");
		// An optional argument never pairs with a dropped one as a rename.
		const renamed = line("Hi {BabyNameAuto}", "Hallo {BabyName1} {ParentLabel}", {}, optional);
		expect(kind(renamed, "format_argument_renamed", "de")[0]?.actual.renamed).toEqual([
			{ from: "BabyName1", to: "BabyNameAuto" }
		]);
		expect(kind(renamed, "format_arguments")).toEqual([]);
		// Optional tags may be added or left out.
		expect(kinds(line("A <Italic>note</> here", "Eine Notiz hier", {}, optional))).toEqual([]);
		expect(kinds(line("A note here", "Eine <Italic>Notiz</> hier", {}, optional))).toEqual([]);
	});
	it("checks the rule file's segment separator only when it names one", () => {
		const text = corpus([unit("K", "Yes // No")]);
		const files = evidence(
			[manifestEntry("K", "Yes // No")],
			[archiveEntry("K", "Yes // No", "Ja Nein")],
			noPO()
		);
		expect(kind(report(text, files).report, "segment_separator")).toEqual([]);
		const rules = starter({ segment_separator: { separator: "//" } });
		const checked = report(text, files, {}, rules).report;
		expect(kind(checked, "segment_separator", "de")[0]).toMatchObject({
			actual: { separator: "//", count: 0 },
			expectation: { separator: "//", count: 1 }
		});
		expect(checked.rules.map((rule) => rule.ruleId)).toContain(
			"localization.segment_separator"
		);
	});
});
describe("translated inconsistently", () => {
	const shared = (translations: readonly string[], source = "Open the map") => {
		const keys = translations.map((_, index) => `K${index}`);
		const text = corpus(keys.map((key) => unit(key, source)));
		return report(
			text,
			evidence(
				keys.map((key) => manifestEntry(key, source)),
				keys.map((key, index) => archiveEntry(key, source, translations[index]!)),
				noPO()
			),
			{ culture: cultureCode("de") }
		).report;
	};
	it("reports the keys that leave the culture's usual translation", () => {
		const value = kind(
			shared(["Karte öffnen", "Karte öffnen", "Karte zeigen"]),
			"inconsistent_translation"
		);
		expect(value.map((finding) => finding.identity?.key)).toEqual(["K2"]);
		expect(value[0]?.actual).toEqual({
			translation: "Karte zeigen",
			variants: [
				{ translation: "Karte öffnen", lines: 2 },
				{ translation: "Karte zeigen", lines: 1 }
			],
			variantCount: 2
		});
	});
	it("skips ties, sentences, short or number-only text and the native culture", () => {
		expect(kind(shared(["Karte öffnen", "Karte zeigen"]), "inconsistent_translation")).toEqual(
			[]
		);
		expect(kind(shared(["Ja", "Jawohl"], "OK"), "inconsistent_translation")).toEqual([]);
		expect(kind(shared(["100", "1.000"], "100"), "inconsistent_translation")).toEqual([]);
		// More than four words: sentences are often worded to fit their scene.
		expect(
			kind(
				shared(
					["Gern geschehen, Kleiner.", "Gern geschehen, Kleiner.", "Kein Problem, Kind."],
					"No problem at all, kiddo."
				),
				"inconsistent_translation"
			)
		).toEqual([]);
		// The native culture's "translations" are its source text, edited or not.
		const keys = ["K0", "K1", "K2"];
		const files = evidence(
			keys.map((key) => manifestEntry(key, "Milk")),
			[],
			noPO()
		);
		const native = report(corpus(keys.map((key) => unit(key, "Milk"))), {
			...files,
			cultures: files.cultures.map((culture) => ({
				...culture,
				archive: {
					status: "read" as const,
					provenance: { ...provenance, relativePath: culture.culture },
					value: {
						formatVersion: 2,
						diagnostics: [],
						entries: keys.map((key, index) =>
							archiveEntry(
								key,
								"Milk",
								culture.culture === "en" ? (index ? "Milk" : "Fresh milk") : "Milch"
							)
						)
					}
				}
			}))
		}).report;
		expect(kind(native, "inconsistent_translation")).toEqual([]);
	});
	it("groups translations without case, whitespace and punctuation", () => {
		expect(
			kind(shared(["danke!", "Danke", "danke "], "thanks"), "inconsistent_translation")
		).toEqual([]);
		const value = kind(
			shared(["Danke!", "danke", "Vielen Dank"], "thanks"),
			"inconsistent_translation"
		);
		expect(value.map((finding) => finding.identity?.key)).toEqual(["K2"]);
		expect(value[0]?.actual.variants).toEqual([
			{ translation: "Danke!", lines: 2 },
			{ translation: "Vielen Dank", lines: 1 }
		]);
	});
	it("reports the untranslated lines when most lines ship the source", () => {
		const value = kind(
			shared(["Yellowtail", "Yellowtail", "Gelbschwanz"], "Yellowtail"),
			"inconsistent_translation"
		);
		expect(
			value.map((finding) => [finding.identity?.key, finding.actual.untranslated])
		).toEqual([
			["K0", true],
			["K1", true]
		]);
		// Lines that leave an internal label untranslated far outnumber those that translate it:
		// the culture keeps it untranslated on purpose.
		expect(
			kind(
				shared(
					[
						"FinalDialogueOnly",
						"FinalDialogueOnly",
						"FinalDialogueOnly",
						"Ab dem zweiten Jahr"
					],
					"FinalDialogueOnly"
				),
				"inconsistent_translation"
			)
		).toEqual([]);
		// An untranslated line among translated ones is marked too.
		expect(
			kind(
				shared(["Gelbschwanz", "Gelbschwanz", "Yellowtail"], "Yellowtail"),
				"inconsistent_translation"
			).map((finding) => [finding.identity?.key, finding.actual.untranslated])
		).toEqual([["K2", true]]);
	});
});
describe("built-in source checks", () => {
	it("lists a placeholder once where the workspace also shows the rule file's source findings", () => {
		const document = starter();
		const hydrated: number[] = [];
		const unreported: unknown[] = [];
		const workspace = (source: string, document: GameTextRuleDocument) => {
			const text = corpus([unit("K", source)]);
			const files = evidence(
				[manifestEntry("K", source)],
				[archiveEntry("K", source, source)],
				noPO()
			);
			const { joined, report: value } = report(text, files, {}, document);
			unreported.push(
				kind(value, "placeholder_text").map((finding) => finding.unreportedMatches)
			);
			// The checks recorded which placeholders the source terminology reports: building
			// the workspace reads findings' facts, never the findings themselves.
			const quality = localizationQuality(value, joined);
			let items = 0;
			const built = localizationQualityWorkspaceOf(
				indexedTestReports(text, files).source(document),
				{
					...quality,
					findings: {
						...quality.findings,
						items: (positions) => {
							items += positions.length;
							return quality.findings.items(positions);
						}
					}
				}
			);
			hydrated.push(items);
			return built;
		};
		const problems = (value: ReturnType<typeof workspace>) =>
			Effect.runSync(value.export({ target: target.name, filter: "all" }))
				.findings.filter(
					(finding) =>
						finding.filter === "placeholder_text" || finding.filter === "terminology"
				)
				.map((finding) => [finding.filter, finding.problem]);
		// Every placeholder is a forbidden term's finding: the built-in's is left out.
		const covered = workspace("Choose a placeholder name", document);
		expect(problems(covered).map(([filter]) => filter)).toEqual(["terminology"]);
		const page = Effect.runSync(covered.search({ target: target.name, filter: "all" }));
		expect(page.counts.placeholder_text).toBe(0);
		expect(page.total).toBe(page.findings.length);
		// Some are: the built-in names only the others.
		expect(problems(workspace("TODO: placeholder name", document))).toContainEqual([
			"placeholder_text",
			"en · Placeholder “TODO”"
		]);
		// A role that does not select the line's place leaves the placeholder to the built-in.
		const elsewhere = Schema.decodeUnknownSync(GameTextRuleDocument)({
			...STARTER_GAME_TEXT_RULES,
			roles: [
				...STARTER_GAME_TEXT_RULES.roles,
				{
					id: "elsewhere",
					scopes: [
						{
							matchers: [
								{ kind: "object_path", operator: "prefix", value: "/Other/" }
							]
						}
					]
				}
			],
			rules: [
				...STARTER_CHECK_RULES.rules,
				{
					id: "elsewhere-terms",
					kind: "terminology",
					role: "elsewhere",
					caseSensitive: true,
					terms: [{ kind: "forbidden", term: "TODO" }],
					recovery: "Finish the text."
				}
			]
		});
		expect(problems(workspace("TODO: name", elsewhere))).toEqual([
			["placeholder_text", "en · Placeholder “TODO”"]
		]);
		expect(hydrated).toEqual([0, 0, 0]);
		// The report keeps every placeholder, and notes which the source terminology leaves.
		expect(unreported).toEqual([[[]], [["TODO"]], [undefined]]);
	});
	it("skips bytecode fragments and ungathered lines in the source checks", () => {
		const fragment = "Ada: I'm about ";
		const text = corpus([]);
		const files = evidence(
			[
				{
					...manifestEntry("K", fragment),
					path: "/Game/Cutscene/Heart_10.SequenceDirector_C:SequenceEvent__ENTRYPOINTSequenceDirector_4 [Script Bytecode]"
				},
				{
					...manifestEntry("N", "> 75"),
					path: "/Game/Cutscene/Heart_10.SequenceDirector_C:SequenceEvent_1 [Script Bytecode]"
				}
			],
			[archiveEntry("K", fragment, fragment), archiveEntry("N", "> 75", "> 75")],
			noPO()
		);
		const value = report(text, files).report;
		expect(kind(value, "source_whitespace")).toEqual([]);
		expect(kind(value, "number_only_text")).toEqual([]);
		const ungathered = report(
			corpus([unit("K", "For my birthday? Eww.\t")]),
			evidence([], [], noPO())
		).report;
		expect(kind(ungathered, "source_whitespace")).toEqual([]);
	});
	it("reports culture-invariant text, low, only where its property is localizable elsewhere", () => {
		const invariantUnit = (
			id: string,
			source: string,
			location: Record<string, string>,
			audience?: string
		) => {
			const base = ftextUnit(id, source);
			return Schema.decodeUnknownSync(TextUnit)({
				...base,
				id: `unit:${id}`,
				identity: { status: "unresolved", reason: "culture_invariant" },
				occurrences: base.occurrences.map((occurrence) => ({
					...occurrence,
					id: `occurrence:${id}`,
					identity: { status: "unresolved", reason: "culture_invariant" },
					location: { ...occurrence.location, ...location },
					...(audience ? { audience, audienceReason: "editor_property" } : undefined)
				}))
			});
		};
		const textBlock = {
			objectPath: "/Game/UI/Shop/WBP_PotionStall.WBP_PotionStall_C.WidgetTree.BlessingText",
			classPath: "/Script/UMG.TextBlock",
			propertyPath: "Text"
		};
		const keyed = ftextUnit("Title", "Shop");
		const localized = TextUnit.make({
			...keyed,
			occurrences: keyed.occurrences.map((occurrence) => ({
				...occurrence,
				location: {
					...occurrence.location,
					...textBlock,
					objectPath: "/Game/UI/Title.Title"
				}
			}))
		});
		const backers = (row: string) => ({
			kind: "data_table_cell" as const,
			objectPath: "/Game/UI/Credit/DT_CreditBackers.DT_CreditBackers",
			row,
			propertyPath: "title"
		});
		const units = [
			localized,
			invariantUnit("a", "Blessing Description", textBlock),
			// A property mostly invariant: a credits column of backer names with one localized
			// heading.
			...["Ada Example", "Ben Sample"].map((name, index) =>
				invariantUnit(`b${index}`, name, backers(`${11860 + index}`))
			),
			TextUnit.make({
				...ftextUnit("Heading", "Backers", undefined, undefined, "data_table_cell"),
				occurrences: ftextUnit(
					"Heading",
					"Backers",
					undefined,
					undefined,
					"data_table_cell"
				).occurrences.map((occurrence) => ({
					...occurrence,
					location: backers("1")
				}))
			}),
			// Debug widgets and saves.
			invariantUnit("c", "Skip Teleport", {
				...textBlock,
				objectPath:
					"/Game/UI/Debug/WBP_NpcDebugPanel.WBP_NpcDebugPanel_C.WidgetTree.TextBlock_5"
			}),
			// Text renders placed in a level, a sequence or a Blueprint template.
			invariantUnit("d", "Bird Feeder Spot", {
				objectPath:
					"/Game/Maps/Waypoints.Waypoints.PersistentLevel.C_AnimationWaypoint_198.Text",
				classPath: "/Script/Engine.TextRenderComponent",
				propertyPath: "Text"
			}),
			invariantUnit("e", "C : 1 N : 0 Distance : 792.288", {
				objectPath:
					"/Game/Cutscene/Heart_7.Heart_7.MovieScene_0.BP_Cutscene_Waypoint_1.TextComponent",
				classPath: "/Script/Engine.TextRenderComponent",
				propertyPath: "Text"
			}),
			invariantUnit("g", "Wild Life Spawner", {
				objectPath: "/Game/Mining/BP_MonsterSpawner.Default__BP_MonsterSpawner_C.Text",
				classPath: "/Script/Engine.TextRenderComponent",
				propertyPath: "Text"
			}),
			// Editor text, by its audience.
			invariantUnit(
				"f",
				"Cloak kawaii",
				{
					...textBlock,
					objectPath: "/Game/Developers/Me/Panel.Panel",
					propertyPath: "Text"
				},
				"editor"
			)
		];
		const value = report(
			corpus(units),
			evidence(
				[manifestEntry("Title", "Shop")],
				[archiveEntry("Title", "Shop", "Laden")],
				noPO()
			)
		).report;
		const found = kind(value, "culture_invariant_text");
		expect(
			found.map((finding) => [
				finding.actual.source,
				finding.identity,
				finding.culture,
				finding.severity
			])
		).toEqual([["Blessing Description", null, "en", "low"]]);
		expect(
			Schema.decodeUnknownSync(LocalizationQualityReport)(JSON.parse(JSON.stringify(value)))
		).toEqual(value);
	});
	it("lists conflicting sources apart and never compares or groups their joined text", () => {
		const text = corpus([
			unit("K", "Start"),
			another("K", "Begin", "/Game/Text/Other.Other"),
			unit("L", "Start Begin")
		]);
		const files = evidence(
			[manifestEntry("L", "Start Begin")],
			[archiveEntry("K", "Start Begin", "{Wrong}"), archiveEntry("L", "Start Begin", "x")],
			noPO()
		);
		const { joined, report: value } = report(text, files);
		const conflicting = findings(value).filter((finding) => finding.identity?.key === "K");
		expect(conflicting.length).toBeGreaterThan(0);
		for (const finding of conflicting)
			expect(finding.sourceVariants).toEqual(["Begin", "Start"]);
		// Without a manifest there is no one source to compare the translation with.
		expect(conflicting.some((finding) => finding.kind === "format_arguments")).toBe(false);
		// The joined text "Start Begin" is not shared with key L.
		expect(kind(value, "duplicate_source")).toEqual([]);
		const workspace = localizationQualityWorkspace(undefined, value, joined);
		const page = workspace.search({ target: joined.target, filter: "all" });
		const summary = page.findings.find((finding) => finding.sourceVariants);
		expect(summary?.sourceVariants).toEqual(["Begin", "Start"]);
		expect(summary?.source).toBe("Begin");
	});
});
describe("severity", () => {
	it("rates every built-in check and lists blocking findings first", () => {
		expect(localizationCheckCatalogue.culture_invariant_text.severity).toBe("low");
		expect(localizationCheckCatalogue.outdated_translation.severity).toBe("blocking");
		expect(localizationCheckCatalogue.source_line_endings_changed.severity).toBe("low");
		expect(localizationCheckCatalogue.duplicate_source.severity).toBe("low");
		const text = corpus([unit("A", "Alpha"), unit("Z", "Zulu text")]);
		const files = evidence(
			[manifestEntry("A", "Alpha"), manifestEntry("Z", "Zulu text")],
			[archiveEntry("A", "Alpha", "Alfa "), archiveEntry("Z", "Old zulu", "Zulu")],
			noPO()
		);
		const { joined, report: value } = report(text, files);
		for (const finding of findings(value))
			expect(finding.severity).toBe(localizationCheckCatalogue[finding.kind].severity);
		const workspace = localizationQualityWorkspace(undefined, value, joined);
		const page = workspace.search({ target: joined.target, filter: "all" });
		expect(Schema.decodeUnknownSync(WorkspaceQualityPage)(page)).toEqual(page);
		const severities = page.findings.map((finding) => finding.severity);
		expect(severities[0]).toBe("blocking");
		const rank = { blocking: 0, normal: 1, low: 2 };
		expect(severities.map((severity) => rank[severity])).toEqual(
			severities.map((severity) => rank[severity]).sort((a, b) => a - b)
		);
		expect(page.severityCounts).toEqual({
			blocking: severities.filter((severity) => severity === "blocking").length,
			normal: severities.filter((severity) => severity === "normal").length,
			low: severities.filter((severity) => severity === "low").length
		});
		// Offsets page through the same severity order.
		const second = workspace.search({ target: joined.target, filter: "all", offset: 1 });
		expect(second.findings.map((finding) => finding.id)).toEqual(
			page.findings.slice(1).map((finding) => finding.id)
		);
		const csv = workspaceQualityCsv(workspace.export({ target: joined.target, filter: "all" }));
		expect(csv.split("\r\n")[0]).toContain("Severity");
	});
});

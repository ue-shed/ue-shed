import { effectiveRuleDocument, enabledRuleDocument } from "./rules/effective.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
import { LocalizationReviewFile } from "@ue-shed/localization";
import { expect } from "vitest";
import type { GameTextIndexRefreshResult } from "./index-contract.js";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import {
	LocalizationQualityReport,
	type LocalizationCheckOptions,
	type LocalizationCustomFinding,
	type LocalizationPolicyFinding,
	type LocalizationQualityFinding
} from "./localization-quality-schema.js";
import { acceptReview } from "./native-findings.js";
import { localizationLineFingerprint } from "./localization-review.js";
import { type BuiltInCheckId, SourceCheckId } from "./localization-check-ids.js";
import {
	BuiltInQualityFilter,
	WorkspaceQualityFilter,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf,
	type WorkspaceQualityRequest
} from "./localization-workspace.js";
import { TextQualityFindingId } from "./quality-query.js";
import { type BuiltInCheckEntry, GameTextRuleDocument } from "./game-text-rules.js";
import { STARTER_CHECK_RULES, STARTER_CHECKS } from "./starter-rules.js";

/**
 * A quality scan's progress in rules: nothing run first, every rule run last with the findings,
 * and between them, as the engine paces them, rising counts of rules run.
 */
const expectRuleProgress = (
	events: readonly GameTextIndexProgress[],
	phase: GameTextIndexProgress["phase"],
	rules: number,
	findings: number
) => {
	// The evaluation ends ready, so the host stops showing it as running.
	expect(events.at(-1)).toEqual({ phase: "ready", completed: 0, total: 0 });
	const quality = events.slice(0, -1);
	expect(quality[0]).toEqual({ phase, completed: 0, total: rules, findings: 0 });
	expect(quality.at(-1)).toEqual({ phase, completed: rules, total: rules, findings });
	const between = quality.slice(1, -1);
	for (const [index, event] of between.entries()) {
		expect(event).toEqual({ phase, completed: event.completed, total: rules });
		expect(event.completed).toBeGreaterThan(
			index === 0 ? 0 : between[index - 1]!.completed - 1
		);
		expect(event.completed).toBeLessThanOrEqual(rules);
	}
};
/**
 * One problem per key pattern; German carries the translation problems. `deSource` is the source
 * German's archive entry records, when it was translated from older text; `dePO` is a pending PO
 * translation that differs from the archive.
 */
const patterns: ReadonlyArray<{
	source: string;
	de: string;
	deSource?: string;
	dePO?: string;
}> = [
	{ source: "Hello {PlayerName}", de: "Hallo {Name}" },
	{ source: "<Bold>Gold</>", de: "<Bold>Gold" },
	{ source: "Ready ", de: "Bereit" },
	{ source: "Line one", de: "Zeile\\neins" },
	{ source: "{Count} {Count}|plural(one=item,other=items)", de: "{Count} Dinge" },
	{ source: "Exit", de: "Beenden" },
	{ source: "Empty me", de: "" },
	{ source: "Fine text", de: "Feiner Text" },
	{ source: "Exit", de: "Verlassen" },
	{ source: "Take {Count} {Item}", de: "Nimm {Count}" },
	{ source: "Press <Key>Space</> now", de: "Jetzt Leertaste drücken" },
	{ source: "<Italic>Note</>", de: "<italic>Hinweis</>" },
	{ source: "First\nSecond", de: "Erste Zweite" },
	{ source: "Yes // No", de: "Ja Nein" },
	{ source: "A fairly long sentence about the harbour", de: "Hafen" },
	{ source: "Open the door", de: "Öffne die Tür", deSource: "Open the gate" },
	{ source: "TODO: final name", de: "TODO: Name" },
	{ source: "Unclosed <Em>tag", de: "Offenes <Em>Tag" },
	{ source: "100", de: "100" },
	{ source: "Save game", de: "Spiel speichern" },
	{ source: "Save game", de: "Spiel speichern", dePO: "Spiel sichern" },
	// Groups with "Spiel speichern": case, whitespace and punctuation do not count.
	{ source: "Save game", de: "Spiel speichern!" },
	{ source: "Plain words here", de: "<b>Schlichte</> Worte" },
	{
		source: "Torn Pages\nA scrap",
		de: "Seiten\r\nEin Fetzen",
		deSource: "Torn Pages\r\nA scrap"
	},
	{ source: "The rows are like a composition.", de: "script lama" },
	// The rule file lets a translation add {ParentLabel} and its name tag.
	{ source: "Thanks for the cookie!", de: "Danke für den Keks, <PlayerName>{ParentLabel}</>!" }
];
const keys = Array.from({ length: 45 }, (_, index) => ({
	key: `K${String(index).padStart(2, "0")}`,
	...patterns[index % patterns.length]!
}));
/** Gathered keys; the last few keys exist only in the localization files. */
const gathered = keys.slice(0, 42);
const po = (text: string) =>
	text
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\r", "\\r")
		.replaceAll("\n", "\\n");
const occurrence = (key: string, source: string, index: number) => ({
	source,
	dev_notes: index % patterns.length === 7 ? "Shown on the main menu." : "",
	identity: { status: "resolved" as const, namespace: "UI", key },
	location: {
		kind: "asset_property" as const,
		object_path: index % 4 === 0 ? "/Game/UI/Menu.Menu" : "/Game/Text/Table.Table",
		class_path: "/Script/Engine.DataAsset",
		property_path: `Label${index}`
	},
	edit_capability: "read_only" as const
});
const optionalArguments = ["ParentLabel"],
	optionalTags = ["npcname"];
/** Parameters for some built-in checks, as a rules file writes them. */
type CheckParams = {
	readonly [Id in BuiltInCheckId]?: Extract<
		typeof BuiltInCheckEntry.Encoded,
		{ readonly kind: Id }
	>["params"];
};
/** Parameters of the starter's checks this file sets. */
const checkParams: CheckParams = {
	format_arguments: { optionalArguments },
	format_argument_renamed: { optionalArguments },
	rich_text_tag_case: { optionalArguments },
	rich_text_tags: { optionalTags, optionalArguments },
	rich_text_tags_added: { optionalTags, optionalArguments }
};
const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
	schemaVersion: 1,
	roles: [
		{
			id: "menu",
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/UI/" }] }
			]
		}
	],
	rules: [
		...STARTER_CHECKS.map((kind) =>
			kind in checkParams ? { kind, params: checkParams[kind] } : { kind }
		),
		{ kind: "segment_separator", params: { separator: "//" } },
		{
			id: "source.limit",
			kind: "character_budget",
			role: "menu",
			maximumCharacters: 8,
			recovery: "Shorten the line."
		},
		// Reports TODO in menu text, where placeholder_text leaves it out.
		{
			id: "source.terms",
			kind: "terminology",
			role: "menu",
			caseSensitive: true,
			terms: [{ kind: "forbidden", term: "TODO" }],
			recovery: "Finish the text."
		},
		{
			id: "translation.limit",
			kind: "localization_character_budget",
			role: "menu",
			cultures: { de: 6 },
			recovery: "Shorten the translation."
		},
		{
			id: "translation.terms",
			kind: "localization_terminology",
			role: "menu",
			cultures: { de: [{ kind: "preferred", term: "Willkommen", alternatives: ["Hallo"] }] },
			caseSensitive: false,
			recovery: "Use Willkommen."
		}
	]
});
/** Writes the target's manifest, archives and PO files for these keys. */
async function writeLocalization(projectRoot: string, entries: typeof keys) {
	const manifest = {
		FormatVersion: 1,
		Namespace: "UI",
		Children: entries.map(({ key, source }, index) => ({
			Source: { Text: source },
			Keys: [{ Key: key, Path: `/Game/Text/Table.Table.Label${index}` }]
		}))
	};
	const archive = (culture: "en" | "de") => ({
		FormatVersion: 2,
		Namespace: "UI",
		Children: entries.map(({ key, source, de, deSource }) => ({
			Key: key,
			Source: { Text: culture === "de" ? (deSource ?? source) : source },
			Translation: { Text: culture === "en" ? source : de }
		}))
	});
	// German ships the escape from its archive: Unreal's PO import would unescape it.
	const portable = (culture: "en" | "de") =>
		entries
			.filter(({ source }) => culture === "en" || source !== "Line one")
			.map(
				({ key, source, de, dePO }) =>
					`msgctxt "UI,${key}"\nmsgid "${po(source)}"\nmsgstr "${po(culture === "en" ? source : (dePO ?? de))}"\n`
			)
			.join("\n");
	await writeFile(join(projectRoot, "Review.manifest"), JSON.stringify(manifest));
	for (const culture of ["en", "de"] as const) {
		await writeFile(join(projectRoot, `${culture}.archive`), JSON.stringify(archive(culture)));
		await writeFile(join(projectRoot, `${culture}.po`), portable(culture));
	}
}
it.live(
	"indexed quality pages, focus and proposals equal the in-memory workspace",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			yield* Effect.promise(() => writeLocalization(fixture.projectRoot, keys));
			fixture.update([
				...gathered.map(({ key, source }, index) => occurrence(key, source, index)),
				// A second location for one key, an ungathered key and a culture-invariant text.
				occurrence("K00", "Hello {PlayerName}", 1),
				occurrence("K90", "Only in the asset", 2),
				// Saved text without a key that is not culture invariant.
				{
					...occurrence("", "No key yet", 6),
					identity: { status: "unresolved" as const, reason: "missing_key" as const }
				},
				// Two String Tables declaring one namespace and key.
				...["/Game/Text/TableA.TableA", "/Game/Text/TableB.TableB"].map((path) => ({
					...occurrence("Shared", "Shared entry", 5),
					location: {
						kind: "string_table_entry" as const,
						object_path: path,
						entry_key: "Shared"
					}
				})),
				// A reference to an entry TableA, a known table, does not have.
				{
					...occurrence("Absent", "Missing entry text", 8),
					identity: {
						status: "string_table" as const,
						table_id: "/Game/Text/TableA.TableA",
						key: "Absent"
					}
				},
				{
					...occurrence("", "Invariant", 3),
					identity: {
						status: "unresolved" as const,
						reason: "culture_invariant" as const
					}
				},
				// Culture-invariant text where it is meant to be: a property no keyed text uses,
				// and debug content.
				...[
					{ source: "Backer Name", object: "/Game/Text/Table.Table", property: "Backer" },
					{
						source: "Debug label",
						object: "/Game/Debug/Panel.Panel",
						property: "Label3"
					},
					// Editor text by its audience: a developer folder.
					{
						source: "My test label",
						object: "/Game/Developers/Me/Panel.Panel",
						property: "Label3"
					}
				].map(({ source, object, property }) => ({
					...occurrence("", source, 3),
					identity: {
						status: "unresolved" as const,
						reason: "culture_invariant" as const
					},
					location: {
						kind: "asset_property" as const,
						object_path: object,
						class_path: "/Script/Engine.DataAsset",
						property_path: property
					}
				}))
			]);
			yield* Effect.gen(function* () {
				const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const join = yield* result.localizationJoin;
				const line = join.lines.find((item) => item.identity?.key === "K02")!;
				const review = Schema.decodeUnknownSync(LocalizationReviewFile)({
					schemaVersion: 1,
					target: join.target,
					records: [],
					acceptedFindings: [
						{
							check: "localization.whitespace",
							culture: "de",
							namespace: "UI",
							key: "K02",
							fingerprint: localizationLineFingerprint(
								line,
								line.cultures.find((culture) => culture.culture === "de")!
							),
							by: "Reviewer",
							at: "2026-10-14T00:00:00Z"
						},
						{
							check: "localization.rich_text",
							culture: "de",
							namespace: "UI",
							key: "K01",
							fingerprint: "0".repeat(64),
							by: "Reviewer",
							at: "2026-10-14T00:00:00Z"
						}
					]
				});
				const whitespace: number[] = [];
				for (const options of [{}, { review }]) {
					const source = yield* (yield* result.sourceQuality(document)).export("all");
					const legacy = localizationQualityWorkspace(
						source,
						yield* result.localizationCheck(document, options),
						join
					);
					const indexed = localizationQualityWorkspaceOf(
						source,
						yield* result.localizationQuality(document, options)
					);
					const all = legacy.search({ target: join.target, filter: "all" });
					// The file doesn't list the opt-in checks.
					for (const filter of BuiltInQualityFilter.literals)
						if (filter !== "shared" && filter !== "long")
							expect([filter, all.counts[filter]]).not.toEqual([filter, 0]);
					expect(all.suggestedFixCount).toBeGreaterThan(0);
					whitespace.push(all.counts.whitespace);
					// Source-level checks: one finding per line, under the native culture only.
					const other = join.cultures.find((culture) => culture !== join.nativeCulture)!;
					const translated = legacy.search({
						target: join.target,
						filter: "all",
						culture: other
					});
					const sourceLevel = [
						"duplicate_source",
						"missing_translator_notes",
						...SourceCheckId.literals
					] as const;
					expect(sourceLevel.map((filter) => translated.counts[filter])).toEqual(
						sourceLevel.map(() => 0)
					);
					// Blocking findings lead every page; counts by severity add up.
					const severities = legacy
						.export({ target: join.target, filter: "all" })
						.findings.map(({ severity }) => severity);
					expect(severities).toEqual([
						...severities.filter((severity) => severity === "blocking"),
						...severities.filter((severity) => severity === "normal"),
						...severities.filter((severity) => severity === "low")
					]);
					expect(all.severityCounts.blocking).toBeGreaterThan(0);
					// Pending PO text counts as the shipped translation in the translation pass.
					expect(
						legacy
							.export({ target: join.target, filter: "inconsistent_translation" })
							.findings.filter(({ source }) => source === "Save game")
							.map(({ problem }) => problem)
					).toEqual([
						"de · Translated inconsistently · 2 translations, most use “Spiel speichern”"
					]);
					// Invariant text in a property no keyed text uses, or in debug content, is meant
					// to be invariant.
					expect(
						legacy
							.export({ target: join.target, filter: "culture_invariant_text" })
							.findings.map(({ source }) => source)
					).toEqual(["Invariant"]);
					// TODO in menu text is the terminology rule's finding, not placeholder_text's.
					const contexts = (filter: WorkspaceQualityFilter) =>
						legacy
							.export({ target: join.target, filter })
							.findings.map(({ problem, context }) => problem + " @ " + context);
					expect(contexts("placeholder_text").length).toBeGreaterThan(0);
					expect(
						contexts("placeholder_text").some((text) => text.includes("@ Menu "))
					).toBe(false);
					expect(
						contexts("terminology").some(
							(text) => text.includes("TODO") && text.includes("@ Menu ")
						)
					).toBe(true);
					for (const filter of sourceLevel) {
						if (filter === "shared" || filter === "long") continue;
						const found = legacy.export({ target: join.target, filter }).findings;
						expect(new Set(found.map(({ culture }) => culture))).toEqual(
							new Set([join.nativeCulture])
						);
						expect(new Set(found.map(({ context }) => context)).size).toBe(
							found.length
						);
					}
					for (const culture of [undefined, ...join.cultures])
						for (const filter of BuiltInQualityFilter.literals) {
							const request: WorkspaceQualityRequest = {
								target: join.target,
								filter,
								...(culture ? { culture } : undefined)
							};
							for (const offset of [0, 50])
								expect(yield* indexed.search({ ...request, offset })).toEqual(
									legacy.search({ ...request, offset })
								);
							expect(yield* indexed.export(request)).toEqual(legacy.export(request));
							expect(yield* indexed.changes(request)).toEqual(
								legacy.changes(request)
							);
							// Every finding once; later occurrence pages for a sample.
							if (filter !== "all" || culture) continue;
							for (const [index, { id }] of legacy
								.export(request)
								.findings.entries()) {
								for (const occurrenceOffset of index % 10 === 0 ? [0, 1] : [0])
									expect(
										yield* indexed.focus({ ...request, id, occurrenceOffset })
									).toEqual(legacy.focus({ ...request, id, occurrenceOffset }));
							}
						}
					const unknown = TextQualityFindingId.make(
						all.findings[0]!.id.replace(/.$/u, "x")
					);
					expect(yield* indexed.focus({ target: join.target, id: unknown })).toEqual({
						status: "not_found"
					});
				}
				// The current acceptance hides one finding; the stale one hides nothing.
				expect(whitespace[1]).toBe(whitespace[0]! - 1);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	120000
);
/**
 * The host's report writer before the engine wrote findings: a finding with the members the
 * report kept, which the report's schema then put in its order.
 */
type ReportedFinding =
	| LocalizationQualityFinding
	| LocalizationPolicyFinding
	| LocalizationCustomFinding;
function reportedFinding(finding: ReportedFinding): ReportedFinding {
	const affectedOccurrences = finding.affectedOccurrences.map(
		({ id, location, packageFile }) => ({
			id,
			location:
				location.kind === "asset_property"
					? {
							kind: location.kind,
							objectPath: location.objectPath,
							classPath: location.classPath,
							propertyPath: location.propertyPath
						}
					: location.kind === "data_table_cell"
						? {
								kind: location.kind,
								objectPath: location.objectPath,
								row: location.row,
								propertyPath: location.propertyPath
							}
						: {
								kind: location.kind,
								objectPath: location.objectPath,
								entryKey: location.entryKey
							},
			packageFile
		})
	);
	const {
		lineId,
		target,
		culture,
		identity,
		ruleId,
		kind,
		actual,
		expectation,
		recovery,
		severity,
		manifestLocations,
		translationOrigin
	} = finding;
	const shared = {
		lineId,
		target,
		culture,
		identity,
		ruleId,
		recovery,
		affectedOccurrences,
		manifestLocations,
		translationOrigin,
		severity,
		actual,
		expectation
	};
	if (kind === "custom")
		// SAFETY: the custom discriminant and its paired evidence come from one finding.
		// Verified by: the report's schema decodes the report this oracle builds.
		return {
			...shared,
			kind,
			check: finding.check,
			label: finding.label,
			subject: finding.subject
		} as ReportedFinding;
	if (kind === "localization_character_budget" || kind === "localization_terminology")
		// SAFETY: the policy kind and its evidence come from one finding.
		// Verified by: the report's schema decodes the report this oracle builds.
		return { ...shared, role: finding.role, kind } as ReportedFinding;
	// SAFETY: the built-in kind and its evidence come from one finding.
	// Verified by: the report's schema decodes the report this oracle builds.
	return {
		...shared,
		kind,
		...(finding.sourceVariants ? { sourceVariants: finding.sourceVariants } : undefined),
		...(kind === "placeholder_text" && finding.unreportedMatches !== undefined
			? { unreportedMatches: finding.unreportedMatches }
			: undefined),
		...(kind === "format_argument_renamed" && finding.suggestedChange
			? { suggestedChange: finding.suggestedChange }
			: undefined)
	} as ReportedFinding;
}

/**
 * `loc check`'s report, written with the engine's findings, has the bytes the host wrote from
 * the report's findings pages: `JSON.stringify(report, null, "\t")` and a line break.
 */
const expectReportBytes = Effect.fn("Test.GameText.reportBytes")(function* (
	result: GameTextIndexRefreshResult,
	rules: GameTextRuleDocument | undefined,
	options: LocalizationCheckOptions
) {
	const prepared = yield* result.prepareLocalizationCheck(rules, options);
	let text = "";
	yield* prepared.write((piece) => Effect.sync(() => void (text += piece)));
	const native = result.query;
	const { key } = yield* native.findingsEvaluate(effectiveRuleDocument(rules, options));
	const acceptance = yield* acceptReview(native, key, options.review);
	const findings: ReportedFinding[] = [];
	for (let offset = 0; ; offset += 5000) {
		const page = yield* native.findingsQuery({
			key,
			view: "report",
			...(options.culture ? { culture: options.culture } : undefined),
			order: "report",
			...(acceptance ? { acceptance } : undefined),
			offset,
			limit: 5000
		});
		// SAFETY: the report view returns line findings only.
		// Verified by: the report's schema decodes the report this oracle builds.
		findings.push(...(page.findings as readonly ReportedFinding[]).map(reportedFinding));
		if (page.findings.length < 5000) break;
	}
	expect(prepared.findings).toBe(findings.length);
	const written = Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationQualityReport))(
		text
	);
	expect(text).toBe(
		`${JSON.stringify(LocalizationQualityReport.make({ ...written, findings }), null, "\t")}\n`
	);
});

/** Every filter, culture, page, export and focus of both workspaces, with and without the rules. */
const expectSameQuality = Effect.fn("Test.GameText.sameQuality")(function* (
	result: GameTextIndexRefreshResult,
	optionSets: readonly LocalizationCheckOptions[] = [{}]
) {
	const join = yield* result.localizationJoin;
	for (const rules of [STARTER_CHECK_RULES, document])
		for (const options of optionSets) {
			const source = rules
				? yield* (yield* result.sourceQuality(rules)).export("all")
				: undefined;
			const legacy = localizationQualityWorkspace(
				source,
				yield* result.localizationCheck(rules, options),
				join
			);
			yield* expectReportBytes(result, rules, options);
			const indexed = localizationQualityWorkspaceOf(
				source,
				yield* result.localizationQuality(rules, options)
			);
			for (const culture of [undefined, ...join.cultures])
				for (const filter of BuiltInQualityFilter.literals) {
					const request: WorkspaceQualityRequest = {
						target: join.target,
						filter,
						...(culture ? { culture } : undefined)
					};
					expect(yield* indexed.search(request)).toEqual(legacy.search(request));
					const exported = legacy.export(request);
					expect(yield* indexed.export(request)).toEqual(exported);
					for (const { id } of exported.findings.filter((_, index) => index % 10 === 0))
						expect(yield* indexed.focus({ ...request, id })).toEqual(
							legacy.focus({ ...request, id })
						);
				}
		}
});
it.live("checks report each place once, its compiled Blueprint copies folded in", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		// The fixture's package as a Widget Blueprint whose compile saved copies of its widgets.
		const pkg = "/Game/Text/Table";
		const place = (object: string, key: string | null, source: string) => ({
			source,
			dev_notes: "",
			identity:
				key === null
					? { status: "unresolved" as const, reason: "culture_invariant" as const }
					: { status: "resolved" as const, namespace: "UI", key },
			location: {
				kind: "asset_property" as const,
				object_path: `${pkg}.${object}`,
				class_path: "/Script/UMG.TextBlock",
				property_path: "Text"
			},
			edit_capability: "read_only" as const
		});
		yield* Effect.promise(() =>
			writeLocalization(fixture.projectRoot, [
				{ key: "Title", source: "Play now", de: "Jetzt spielen" },
				{ key: "Label", source: "Shop", de: "<b>Laden</>" }
			])
		);
		fixture.update(
			[
				// Keyed text without a copy, so TextBlock text is localizable once.
				place("Table.WidgetTree.Title", "Title", "Play now"),
				place("Table.WidgetTree.Label", "Label", "Shop"),
				place("Table_C.WidgetTree.Label", "Label", "Shop"),
				// Invariant text and its copy: one place, so as common as keyed text.
				place("Table.WidgetTree.Name", null, "Shop name"),
				place("Table_C.WidgetTree.Name", null, "Shop name")
			],
			[
				{
					blueprint: `${pkg}.Table`,
					generatedClass: `${pkg}.Table_C`,
					classDefault: `${pkg}.Default__Table_C`
				}
			]
		);
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const report = yield* result.localizationCheck(STARTER_CHECK_RULES, undefined);
			const found = (kind: string) =>
				report.findings.filter((finding) => finding.kind === kind);
			for (const kind of ["culture_invariant_text", "rich_text_tags_added"]) {
				expect(found(kind), kind).toHaveLength(1);
				expect(
					found(kind)[0]!.affectedOccurrences.map(
						(occurrence) => occurrence.location.objectPath
					),
					kind
				).toEqual([
					`${pkg}.Table.WidgetTree.${kind === "culture_invariant_text" ? "Name" : "Label"}`
				]);
			}
			yield* expectSameQuality(result);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("rows the query hides are neither checked nor counted in the limits", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		// Blank sources are not visible lines; the last key exists only in the localization files.
		// With the archives unreadable, every culture of every line would add a diagnostic.
		const entries = [
			{ key: "K", source: "Source", de: "Quelle" },
			{ key: "Empty", source: "", de: "" },
			{ key: "Blank", source: " \t ", de: " " },
			{ key: "Unused", source: "", de: "" }
		];
		yield* Effect.promise(async () => {
			await writeLocalization(fixture.projectRoot, entries);
			for (const culture of ["en", "de"])
				await writeFile(join(fixture.projectRoot, `${culture}.archive`), "not an archive");
		});
		fixture.update(
			entries.slice(0, 3).map(({ key, source }, index) => occurrence(key, source, index))
		);
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			expect(join.lines.map((line) => line.identity?.key)).toEqual(["K"]);
			const legacy = localizationQualityWorkspace(
				undefined,
				yield* result.localizationCheck(STARTER_CHECK_RULES, undefined),
				join
			);
			expect(legacy.search({ target: join.target, filter: "all" }).limits).toContainEqual({
				code: "missing_archive",
				count: 2
			});
			yield* expectSameQuality(result);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("lines whose IDs compare equal keep the in-memory report's order", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		// Canonically equivalent keys: distinct identities that collation cannot tell apart.
		const entries = [
			{ key: "\u00e9", source: "Source", de: "Quelltext" },
			{ key: "e\u0301", source: "Source", de: "Quelltexte" },
			{ key: "f", source: "Exit", de: "Beenden" }
		];
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, entries));
		fixture.update(entries.map(({ key, source }, index) => occurrence(key, source, index * 4)));
		yield* Effect.gen(function* () {
			// Quality progress goes to the reporter provided when the index opened.
			let last: GameTextIndexProgress | undefined;
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request).pipe(
				Effect.provideService(GameTextIndexProgressReporter, (step) => {
					// The last quality event; the evaluation then ends ready.
					if (step.phase === "localization_quality") last = step;
				})
			);
			const join = yield* result.localizationJoin;
			expect(join.lines[0]!.id).not.toBe(join.lines[1]!.id);
			expect(join.lines[0]!.id.localeCompare(join.lines[1]!.id)).toBe(0);
			// One accepted finding on each line; the other line's text has another fingerprint.
			const accept = (key: string, check: string, culture: string = "de") => {
				const line = join.lines.find((item) => item.identity?.key === key)!;
				return {
					check,
					culture,
					namespace: "UI",
					key,
					fingerprint: localizationLineFingerprint(
						line,
						line.cultures.find((item) => item.culture === culture)!
					),
					by: "Reviewer",
					at: "2026-10-14T00:00:00Z"
				};
			};
			const review = Schema.decodeUnknownSync(LocalizationReviewFile)({
				schemaVersion: 1,
				target: join.target,
				records: [],
				acceptedFindings: [
					accept("\u00e9", "translation.limit"),
					// Source-level findings are reported under the native culture.
					accept("e\u0301", "localization.duplicate_source", join.nativeCulture!)
				]
			});
			const total = (options: LocalizationCheckOptions) =>
				Effect.gen(function* () {
					return localizationQualityWorkspace(
						undefined,
						yield* result.localizationCheck(document, options),
						join
					).search({ target: join.target, filter: "all" }).total;
				});
			expect(yield* total({ review })).toBe((yield* total({})) - 2);
			yield* expectSameQuality(result, [{}, { review }]);
			// Lines whose IDs compare equal are each checked once; progress counts what the
			// checks found, before the review hides any.
			yield* result.localizationQuality(STARTER_CHECK_RULES, { review });
			const rules = enabledRuleDocument(effectiveRuleDocument(STARTER_CHECK_RULES)).rules
				.length;
			expect(last).toEqual({
				phase: "localization_quality",
				completed: rules,
				total: rules,
				findings: (yield* result.localizationCheck(STARTER_CHECK_RULES, {})).findings.length
			});
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("queried quality over more lines than a page equals the in-memory checks", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const many = Array.from({ length: 600 }, (_, index) => ({
			key: `M${String(index).padStart(3, "0")}`,
			...patterns[index % patterns.length]!
		}));
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, many));
		fixture.update(
			many.slice(0, 590).map(({ key, source }, index) => occurrence(key, source, index))
		);
		yield* Effect.gen(function* () {
			// Quality progress goes to the reporter provided when the index opened.
			const progress: GameTextIndexProgress[] = [];
			const result = yield* (yield* GameTextIndexRefresh)
				.refresh(fixture.request)
				.pipe(
					Effect.provideService(GameTextIndexProgressReporter, (step) =>
						progress.push(step)
					)
				);
			const join = yield* result.localizationJoin;
			expect(join.lines.length).toBeGreaterThan(512);
			const legacy = localizationQualityWorkspace(
				undefined,
				yield* result.localizationCheck(STARTER_CHECK_RULES, undefined),
				join
			);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality(STARTER_CHECK_RULES)
			);
			for (const culture of [undefined, ...join.cultures]) {
				const request = {
					target: join.target,
					filter: "all" as const,
					...(culture ? { culture } : undefined)
				};
				expect(yield* indexed.export(request)).toEqual(legacy.export(request));
				expect(yield* indexed.search({ ...request, offset: 500 })).toEqual(
					legacy.search({ ...request, offset: 500 })
				);
			}
			// Progress in rules: before the engine runs, as it runs each rule, and after.
			progress.length = 0;
			const reported = yield* result.localizationQuality(STARTER_CHECK_RULES);
			const request = { target: join.target, filter: "all" as const };
			const exported = yield* reported.workspace.export(request);
			expectRuleProgress(
				progress,
				"localization_quality",
				enabledRuleDocument(effectiveRuleDocument(STARTER_CHECK_RULES)).rules.length,
				exported.total
			);
			// The callback changes nothing: the same findings, order and IDs.
			const plain = yield* result.localizationQuality(STARTER_CHECK_RULES);
			expect(yield* plain.workspace.export(request)).toEqual(exported);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("queried quality rates each finding as the rule file does", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, keys));
		fixture.update(gathered.map(({ key, source }, index) => occurrence(key, source, index)));
		const rated = Schema.decodeUnknownSync(GameTextRuleDocument)({
			...document,
			rules: document.rules.map((entry) =>
				"id" in entry && entry.id === "translation.limit"
					? { ...entry, severity: "blocking" }
					: entry.kind === "length_outlier"
						? { ...entry, severity: "blocking" }
						: entry.kind === "outdated_translation"
							? { ...entry, severity: "low" }
							: // Scoped out of German: missing tags leave added tags to their own check.
								entry.kind === "rich_text_tags"
								? { ...entry, scope: { cultures: ["fr"] } }
								: entry
			)
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const legacy = localizationQualityWorkspace(
				yield* (yield* result.sourceQuality(rated)).export("all"),
				yield* result.localizationCheck(rated, {}),
				join
			);
			const quality = yield* result.localizationQuality(rated);
			const indexed = localizationQualityWorkspaceOf(undefined, quality);
			const request = { target: join.target, filter: "all" as const };
			expect(yield* indexed.export(request)).toEqual(legacy.export(request));
			const page = yield* indexed.search(request);
			expect(page).toEqual(legacy.search(request));
			const severities = (filter: WorkspaceQualityFilter) =>
				indexed
					.search({ ...request, filter })
					.pipe(
						Effect.map(
							(page) => new Set(page.findings.map((finding) => finding.severity))
						)
					);
			expect(yield* severities("length_outlier")).toEqual(new Set(["blocking"]));
			expect(yield* severities("outdated_translation")).toEqual(new Set(["low"]));
			expect(yield* severities("character_budget")).toContain("blocking");
			expect(page.counts.rich_text_tags).toBe(0);
			expect(page.counts.rich_text_tags_added).toBeGreaterThan(0);
			// Only the two re-rated kinds are blocking now; outdated translations are low.
			// The source budget shares the filter; its findings keep the kind's severity.
			expect(page.severityCounts.blocking).toBe(
				page.counts.length_outlier +
					page.rules.find((rule) => rule.ruleId === "translation.limit")!.findingCount
			);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("custom checks query as the in-memory checks do, past the old filter and rule bits", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, keys));
		fixture.update(gathered.map(({ key, source }, index) => occurrence(key, source, index)));
		// More custom filters than six filter bits held, each with its own rule.
		const lengths = Array.from({ length: 80 }, (_, index) => ({
			id: `length.${index}`,
			label: `Length ${index}`,
			kind: "length",
			subject: index % 2 ? "translation" : "source",
			measure: "characters",
			maximum: 4 + (index % 12),
			severity: index % 3 ? "low" : "blocking",
			recovery: "Shorten it.",
			...(index % 5 === 0 ? { scope: { roles: ["menu"] } } : undefined)
		}));
		const custom = Schema.decodeUnknownSync(GameTextRuleDocument)({
			...document,
			rules: [
				...document.rules,
				...lengths,
				{
					id: "no-hallo",
					label: "No Hallo",
					kind: "forbidden_term",
					subject: "translation",
					terms: ["Hallo"],
					caseSensitive: false,
					recovery: "Use the glossary."
				},
				{
					id: "braces",
					label: "Braces",
					kind: "pattern",
					subject: "source",
					pattern: "\\{[A-Za-z]+\\}",
					recovery: "Check the argument."
				}
			]
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const report = yield* result.localizationCheck(custom, {});
			const legacy = localizationQualityWorkspace(
				yield* (yield* result.sourceQuality(custom)).export("all"),
				report,
				join
			);
			const quality = yield* result.localizationQuality(custom);
			const indexed = localizationQualityWorkspaceOf(undefined, quality);
			for (const culture of [undefined, ...join.cultures]) {
				const request = {
					target: join.target,
					filter: "all" as const,
					...(culture ? { culture } : undefined)
				};
				const page = yield* indexed.search(request);
				expect(page).toEqual(legacy.search(request));
				expect(yield* indexed.export(request)).toEqual(legacy.export(request));
				expect(page.customFilters).toHaveLength(82);
				for (const filter of [
					"custom.length.79",
					"custom.no-hallo",
					"custom.braces"
				] as const) {
					expect(yield* indexed.search({ ...request, filter })).toEqual(
						legacy.search({ ...request, filter })
					);
				}
			}
			const all = yield* indexed.search({ target: join.target, filter: "all" });
			expect(all.counts["custom.no-hallo"]).toBeGreaterThan(0);
			expect(all.counts["custom.braces"]).toBeGreaterThan(0);
			expect(all.counts["custom.length.79"]).toBeGreaterThan(0);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("custom regex checks preserve whitespace and zero-width truth in queried quality", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const entries = [
			{ key: "Space", source: "Whitespace translation", de: "  " },
			{ key: "Empty", source: "Empty translation", de: "" },
			{ key: "Todo", source: "TODO", de: "TODO" }
		];
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, entries));
		fixture.update(entries.map(({ key, source }, index) => occurrence(key, source, index)));
		const checks = Schema.decodeUnknownSync(GameTextRuleDocument)({
			schemaVersion: 1,
			roles: [],
			rules: [
				...STARTER_CHECK_RULES.rules,
				...["source", "translation"].flatMap((subject) =>
					[
						{ id: `${subject}-space`, pattern: "^\\s*$" },
						{ id: `${subject}-lookahead`, pattern: "(?=TODO)" },
						{ id: `${subject}-no-match`, pattern: "(?=TODO)", report: "no_match" }
					].map((check) => ({
						...check,
						subject,
						kind: "pattern",
						label: check.id,
						recovery: "Review text."
					}))
				)
			]
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const report = yield* result.localizationCheck(checks, {});
			const legacy = localizationQualityWorkspace(undefined, report, join);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality(checks)
			);
			const request = { target: join.target, filter: "all" as const };
			expect(yield* indexed.search(request)).toEqual(legacy.search(request));
			expect(yield* indexed.export(request)).toEqual(legacy.export(request));
			const counts = (yield* indexed.search(request)).counts;
			for (const subject of ["source", "translation"] as const) {
				expect(counts[`custom.${subject}-space`]).toBe(subject === "translation" ? 2 : 0);
				expect(counts[`custom.${subject}-lookahead`]).toBe(1);
				expect(counts[`custom.${subject}-no-match`]).toBe(2);
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("queried quality lets other fibers run and stops when interrupted", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			let turns = 0,
				done = false;
			const other = yield* Effect.forkChild(
				Effect.whileLoop({
					while: () => !done,
					body: () => Effect.sync(() => turns++).pipe(Effect.andThen(Effect.yieldNow)),
					step: () => undefined
				})
			);
			const quality = yield* result.localizationQuality(STARTER_CHECK_RULES);
			done = true;
			yield* Fiber.join(other);
			const page = yield* quality.workspace.search({
				target: result.localization.target,
				filter: "all"
			});
			expect(page.total).toBeGreaterThan(0);
			// Another fiber ran while the engine checked.
			expect(turns).toBeGreaterThan(1);
			const scan = yield* Effect.forkChild(result.localizationQuality(STARTER_CHECK_RULES));
			yield* Fiber.interrupt(scan);
			const exit = yield* Fiber.await(scan);
			expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
it.live("proposals past the first 100 count the rest without reading their lines", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const fixable = Array.from({ length: 130 }, (_, index) => ({
			key: `F${String(index).padStart(3, "0")}`,
			source: "Hello {PlayerName}",
			de: "Hallo {Name}"
		}));
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, fixable));
		fixture.update(fixable.map(({ key, source }, index) => occurrence(key, source, index)));
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const legacy = localizationQualityWorkspace(
				undefined,
				yield* result.localizationCheck(STARTER_CHECK_RULES, undefined),
				join
			);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality(STARTER_CHECK_RULES)
			);
			for (const request of [
				{ target: join.target, filter: "all" as const },
				{
					target: join.target,
					filter: "format_argument_renamed" as const,
					culture: join.cultures[1]!
				}
			]) {
				const proposed = yield* indexed.changes(request);
				expect(proposed).toEqual(legacy.changes(request));
				expect(proposed.status === "ready" && proposed.document.changes.length).toBe(100);
				expect(proposed.status === "ready" && proposed.remaining).toBe(30);
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

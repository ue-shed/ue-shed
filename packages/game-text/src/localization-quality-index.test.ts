import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Schema } from "effect";
import { LocalizationReviewFile } from "@ue-shed/localization";
import { expect } from "vitest";
import type { GameTextIndexRefreshResult } from "./index-contract.js";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import type { LocalizationCheckOptions } from "./localization-quality-schema.js";
import { localizationLineFingerprint } from "./localization-review.js";
import { SourceCheckId } from "./localization-check-ids.js";
import {
	BuiltInQualityFilter,
	WorkspaceQualityFilter,
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf,
	type WorkspaceQualityRequest
} from "./localization-workspace.js";
import { TextQualityFindingId } from "./quality-query.js";
import {
	GameTextRuleDocument,
	evaluateGameTextSourceQuality,
	migrateGameTextRuleDocument
} from "./game-text-rules.js";

/**
 * One problem per key pattern; German carries the translation problems. `deSource` is the source
 * German's archive entry records, when it was translated from older text; `dePO` is a pending PO
 * translation that differs from the archive.
 */
const patterns: ReadonlyArray<{ source: string; de: string; deSource?: string; dePO?: string }> = [
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

const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
	schemaVersion: 2,
	segmentSeparator: "//",
	optionalArguments: ["ParentLabel"],
	optionalTags: ["npcname"],
	roles: [
		{
			id: "menu",
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/UI/" }] }
			]
		}
	],
	rules: [
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
		}
	],
	localizationRules: [
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
					const source = evaluateGameTextSourceQuality(yield* result.corpus, document);
					const legacy = localizationQualityWorkspace(
						source,
						checkLocalizationTarget(
							yield* result.corpus,
							join,
							result.evidence,
							options,
							document
						),
						join
					);
					// Placeholders the source terminology reports are left out from the scan's
					// facts: building the workspace hydrates no finding.
					const quality = yield* result.localizationQuality(document, options);
					let hydrated = 0;
					const indexed = localizationQualityWorkspaceOf(source, {
						...quality,
						findings: {
							...quality.findings,
							items: (positions) => {
								hydrated += positions.length;
								return quality.findings.items(positions);
							}
						}
					});
					expect(hydrated).toBe(0);
					const all = legacy.search({ target: join.target, filter: "all" });
					for (const filter of BuiltInQualityFilter.literals)
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
								expect(indexed.search({ ...request, offset })).toEqual(
									legacy.search({ ...request, offset })
								);
							expect(indexed.export(request)).toEqual(legacy.export(request));
							expect(indexed.changes(request)).toEqual(legacy.changes(request));
							// Every finding once; later occurrence pages for a sample.
							if (filter !== "all" || culture) continue;
							legacy.export(request).findings.forEach(({ id }, index) => {
								for (const occurrenceOffset of index % 10 === 0 ? [0, 1] : [0])
									expect(
										indexed.focus({ ...request, id, occurrenceOffset })
									).toEqual(legacy.focus({ ...request, id, occurrenceOffset }));
							});
						}
					const unknown = TextQualityFindingId.make(
						all.findings[0]!.id.replace(/.$/u, "x")
					);
					expect(indexed.focus({ target: join.target, id: unknown })).toEqual({
						status: "not_found"
					});
				}
				// The current acceptance hides one finding; the stale one hides nothing.
				expect(whitespace[1]).toBe(whitespace[0]! - 1);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	120_000
);

/** Every filter, culture, page, export and focus of both workspaces, with and without the rules. */
const expectSameQuality = Effect.fn("Test.GameText.sameQuality")(function* (
	result: GameTextIndexRefreshResult,
	optionSets: readonly LocalizationCheckOptions[] = [{}]
) {
	const join = yield* result.localizationJoin;
	for (const rules of [undefined, document])
		for (const options of optionSets) {
			const source = rules
				? evaluateGameTextSourceQuality(yield* result.corpus, rules)
				: undefined;
			const legacy = localizationQualityWorkspace(
				source,
				checkLocalizationTarget(
					yield* result.corpus,
					join,
					result.evidence,
					options,
					rules
				),
				join
			);
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
					expect(indexed.search(request)).toEqual(legacy.search(request));
					const exported = legacy.export(request);
					expect(indexed.export(request)).toEqual(exported);
					for (const { id } of exported.findings.filter((_, index) => index % 10 === 0))
						expect(indexed.focus({ ...request, id })).toEqual(
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
			const join = yield* result.localizationJoin;
			const report = checkLocalizationTarget(yield* result.corpus, join, result.evidence);
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
				checkLocalizationTarget(yield* result.corpus, join, result.evidence),
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
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
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
			const corpusForOracle = yield* result.corpus;
			const total = (options: LocalizationCheckOptions) =>
				localizationQualityWorkspace(
					undefined,
					checkLocalizationTarget(
						corpusForOracle,
						join,
						result.evidence,
						options,
						document
					),
					join
				).search({ target: join.target, filter: "all" }).total;
			expect(total({ review })).toBe(total({}) - 2);
			yield* expectSameQuality(result, [{}, { review }]);
			// Lines checked as one block count once each.
			let last: GameTextIndexProgress | undefined;
			const quality = yield* result
				.localizationQuality(undefined, { review })
				.pipe(
					Effect.provideService(GameTextIndexProgressReporter, (step) => (last = step))
				);
			expect(last).toEqual({
				phase: "localization_quality",
				completed: join.lines.length,
				total: join.lines.length,
				findings: quality.findings.length
			});
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("a scan across many pages equals the in-memory checks", () =>
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
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			expect(join.lines.length).toBeGreaterThan(512);
			const legacy = localizationQualityWorkspace(
				undefined,
				checkLocalizationTarget(yield* result.corpus, join, result.evidence),
				join
			);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality()
			);
			for (const culture of [undefined, ...join.cultures]) {
				const request = {
					target: join.target,
					filter: "all" as const,
					...(culture ? { culture } : undefined)
				};
				expect(indexed.export(request)).toEqual(legacy.export(request));
				expect(indexed.search({ ...request, offset: 500 })).toEqual(
					legacy.search({ ...request, offset: 500 })
				);
			}

			// Progress: once before the scan, then per page, ending at every line and finding.
			const progress: GameTextIndexProgress[] = [];
			const reported = yield* result
				.localizationQuality()
				.pipe(
					Effect.provideService(GameTextIndexProgressReporter, (step) =>
						progress.push(step)
					)
				);
			const totalLines = join.lines.length;
			const phase = "localization_quality";
			expect(progress[0]).toEqual({ phase, completed: 0, total: totalLines, findings: 0 });
			expect(progress.length).toBeGreaterThan(3);
			for (const [index, step] of progress.entries()) {
				expect(step.phase).toBe(phase);
				expect(step.total).toBe(totalLines);
				if (index === 0) continue;
				expect(step.completed).toBeGreaterThan(progress[index - 1]!.completed);
				expect(step.findings!).toBeGreaterThanOrEqual(progress[index - 1]!.findings!);
			}
			expect(progress.at(-1)).toEqual({
				phase,
				completed: totalLines,
				total: totalLines,
				findings: reported.findings.length
			});
			// The callback changes nothing: the same findings, order and IDs.
			const plain = yield* result.localizationQuality();
			expect(reported.findings.length).toBe(plain.findings.length);
			const everyPosition = Array.from(
				{ length: plain.findings.length },
				(_, position) => position
			);
			expect(reported.findings.items(everyPosition)).toEqual(
				plain.findings.items(everyPosition)
			);
			expect(reported.findings.limits(undefined)).toEqual(plain.findings.limits(undefined));
			expect(reported.metadata.rules).toEqual(plain.metadata.rules);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("the indexed scan stores each finding's severity as the rule file rates it", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, keys));
		fixture.update(gathered.map(({ key, source }, index) => occurrence(key, source, index)));
		const migrated = migrateGameTextRuleDocument(document);
		const rated = Schema.decodeUnknownSync(GameTextRuleDocument)({
			...migrated,
			localizationRules: (migrated.localizationRules ?? []).map((rule) =>
				rule.id === "translation.limit" ? { ...rule, severity: "blocking" } : rule
			),
			checks: {
				...migrated.checks,
				length_outlier: { severity: "blocking" },
				outdated_translation: { severity: "low" },
				// Scoped out of German: missing tags leave added tags to their own check.
				rich_text_tags: { ...migrated.checks?.rich_text_tags, scope: { cultures: ["fr"] } }
			}
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const legacy = localizationQualityWorkspace(
				undefined,
				checkLocalizationTarget(yield* result.corpus, join, result.evidence, {}, rated),
				join
			);
			const quality = yield* result.localizationQuality(rated);
			const indexed = localizationQualityWorkspaceOf(undefined, quality);
			const request = { target: join.target, filter: "all" as const };
			expect(indexed.export(request)).toEqual(legacy.export(request));
			const page = indexed.search(request);
			expect(page).toEqual(legacy.search(request));
			const severities = (filter: WorkspaceQualityFilter) =>
				new Set(
					indexed
						.search({ ...request, filter })
						.findings.map((finding) => finding.severity)
				);
			expect(severities("length_outlier")).toEqual(new Set(["blocking"]));
			expect(severities("outdated_translation")).toEqual(new Set(["low"]));
			expect(severities("character_budget")).toContain("blocking");
			expect(page.counts.rich_text_tags).toBe(0);
			expect(page.counts.rich_text_tags_added).toBeGreaterThan(0);
			// Groups and positions agree on the stored severity.
			for (const group of quality.findings.groups ?? [])
				for (const position of group.positions)
					expect(quality.findings.severity(position)).toBe(group.severity);
			// Only the two re-rated kinds are blocking now; outdated translations are low.
			expect(page.severityCounts.blocking).toBe(
				page.counts.length_outlier + page.counts.character_budget
			);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("custom checks scan as the in-memory checks do, past the old filter and rule bits", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot, keys));
		fixture.update(gathered.map(({ key, source }, index) => occurrence(key, source, index)));
		const migrated = migrateGameTextRuleDocument(document);
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
			...migrated,
			customChecks: [
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
			const report = checkLocalizationTarget(
				yield* result.corpus,
				join,
				result.evidence,
				{},
				custom
			);
			const legacy = localizationQualityWorkspace(undefined, report, join);
			const quality = yield* result.localizationQuality(custom);
			const indexed = localizationQualityWorkspaceOf(undefined, quality);
			expect(quality.metadata.rules).toEqual(report.rules.map((rule) => rule.ruleId));
			for (const culture of [undefined, ...join.cultures]) {
				const request = {
					target: join.target,
					filter: "all" as const,
					...(culture ? { culture } : undefined)
				};
				const page = indexed.search(request);
				expect(page).toEqual(legacy.search(request));
				expect(indexed.export(request)).toEqual(legacy.export(request));
				expect(page.customFilters).toHaveLength(82);
				for (const filter of [
					"custom.length.79",
					"custom.no-hallo",
					"custom.braces"
				] as const) {
					expect(indexed.search({ ...request, filter })).toEqual(
						legacy.search({ ...request, filter })
					);
				}
			}
			const all = indexed.search({ target: join.target, filter: "all" });
			expect(all.counts["custom.no-hallo"]).toBeGreaterThan(0);
			expect(all.counts["custom.braces"]).toBeGreaterThan(0);
			expect(all.counts["custom.length.79"]).toBeGreaterThan(0);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("custom regex checks preserve whitespace and zero-width truth in indexed scans", () =>
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
			schemaVersion: 3,
			roles: [],
			rules: [],
			customChecks: ["source", "translation"].flatMap((subject) =>
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
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const join = yield* result.localizationJoin;
			const report = checkLocalizationTarget(
				yield* result.corpus,
				join,
				result.evidence,
				{},
				checks
			);
			const legacy = localizationQualityWorkspace(undefined, report, join);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality(checks)
			);
			const request = { target: join.target, filter: "all" as const };
			expect(indexed.search(request)).toEqual(legacy.search(request));
			expect(indexed.export(request)).toEqual(legacy.export(request));
			const counts = indexed.search(request).counts;
			for (const subject of ["source", "translation"] as const) {
				expect(counts[`custom.${subject}-space`]).toBe(subject === "translation" ? 2 : 0);
				expect(counts[`custom.${subject}-lookahead`]).toBe(1);
				expect(counts[`custom.${subject}-no-match`]).toBe(2);
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live("the indexed scan yields between pages and stops when interrupted", () =>
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
			const quality = yield* result.localizationQuality();
			done = true;
			yield* Fiber.join(other);
			expect(quality.findings.length).toBeGreaterThan(0);
			// Another fiber ran while the scan was in progress.
			expect(turns).toBeGreaterThan(1);
			const scan = yield* Effect.forkChild(result.localizationQuality());
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
				checkLocalizationTarget(yield* result.corpus, join, result.evidence),
				join
			);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality()
			);
			for (const request of [
				{ target: join.target, filter: "all" as const },
				{
					target: join.target,
					filter: "format_argument_renamed" as const,
					culture: join.cultures[1]!
				}
			]) {
				const proposed = indexed.changes(request);
				expect(proposed).toEqual(legacy.changes(request));
				expect(proposed.status === "ready" && proposed.document.changes.length).toBe(100);
				expect(proposed.status === "ready" && proposed.remaining).toBe(30);
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

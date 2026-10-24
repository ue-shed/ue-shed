import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { expect } from "vitest";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextRuleDocument, decodeGameTextRuleDocumentJson } from "./game-text-rules.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import { expectSameSourceQuality } from "./source-quality-index.test-support.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

const asset = (
	key: string | null,
	source: string,
	object: string,
	property: string,
	classPath = "/Script/Engine.DataAsset"
): Occurrence => ({
	source,
	dev_notes: "",
	identity:
		key === null
			? { status: "unresolved", reason: "culture_invariant" }
			: { status: "resolved", namespace: "UI", key },
	location: {
		kind: "asset_property",
		object_path: object,
		class_path: classPath,
		property_path: property
	},
	edit_capability: "read_only"
});
const cell = (key: string, source: string, row: string, property: string): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace: "Items", key },
	location: {
		kind: "data_table_cell",
		object_path: "/Game/Text/DT_Items.DT_Items",
		row,
		property_path: property
	},
	edit_capability: "source_editable"
});
const entry = (key: string, source: string): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "string_table", table_id: "/Game/Text/ST_Game.ST_Game", key },
	location: {
		kind: "string_table_entry",
		object_path: "/Game/Text/ST_Game.ST_Game",
		entry_key: key
	},
	edit_capability: "source_editable"
});

const sources = [
	"Press the old button now",
	"Click to continue",
	"Ölkanne öffnen, ÖL nachfüllen",
	"Select",
	"A much longer line that goes past every character budget in these rules",
	"Old old OLD",
	"Rocket 🚀 launch",
	"Fine text"
];

/** Units of every location kind, shared and conflicting keys, blank text and invariant text. */
function occurrences(count: number): Occurrence[] {
	const result: Occurrence[] = [];
	for (let index = 0; index < count; index++) {
		const source = sources[index % sources.length]!;
		const key = `K${String(index).padStart(4, "0")}`;
		if (index % 5 === 0)
			result.push(cell(key, source, `Row_${index}`, index % 2 ? "Name" : "Description"));
		else if (index % 5 === 1) result.push(entry(`Prompt${index}`, source));
		else
			result.push(
				asset(
					key,
					source,
					index % 3 === 0 ? "/Game/UI/Menu.Menu" : "/Game/Text/Table.Table",
					`Label${index}`,
					index % 4 === 0 ? "/Script/UMG.TextBlock" : "/Script/Engine.DataAsset"
				)
			);
	}
	return [
		...result,
		// One key at two places with one text, and one key at two places with two texts.
		asset("Shared", "Press old keys", "/Game/UI/Menu.Menu", "Shared"),
		asset("Shared", "Press old keys", "/Game/Text/Table.Table", "Shared"),
		asset("Conflict", "Old text", "/Game/UI/Menu.Menu", "Conflict"),
		asset("Conflict", "Old text that is now much longer", "/Game/UI/Menu.Menu", "Conflict2"),
		// Text the rules never check: empty and whitespace-only sources.
		asset("Empty", "", "/Game/UI/Menu.Menu", "Empty"),
		asset("Blank", " \t ", "/Game/UI/Menu.Menu", "Blank"),
		asset(null, "Invariant old text", "/Game/UI/Menu.Menu", "Invariant")
	];
}

const decode = Schema.decodeUnknownSync(GameTextRuleDocument);
const recovery = "Revise the line.";
const matcherRoles = [
	{
		id: "cells",
		scopes: [
			{
				matchers: [
					{ kind: "location_kind", value: "data_table_cell" },
					{ kind: "row", operator: "prefix", value: "Row_1" }
				]
			},
			{ matchers: [{ kind: "property_path", operator: "exact", value: "Name" }] }
		]
	},
	{
		id: "entries",
		scopes: [
			{ matchers: [{ kind: "string_table_entry", operator: "prefix", value: "Prompt1" }] }
		]
	},
	{
		id: "menu",
		scopes: [
			{ matchers: [{ kind: "object_path", operator: "exact", value: "/Game/UI/Menu.Menu" }] }
		]
	},
	{
		id: "text_blocks",
		scopes: [
			{
				matchers: [
					{ kind: "class_path", operator: "prefix", value: "/Script/UMG." },
					{ kind: "object_path", operator: "prefix", value: "/Game/Text/" }
				]
			}
		]
	},
	{
		id: "rows_exact",
		scopes: [{ matchers: [{ kind: "row", operator: "exact", value: "Row_10" }] }]
	},
	{
		id: "everything",
		scopes: [
			{ matchers: [{ kind: "location_kind", value: "asset_property" }] },
			{ matchers: [{ kind: "location_kind", value: "data_table_cell" }] },
			{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }
		]
	},
	{
		id: "unused",
		scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Nowhere/" }] }]
	}
];

/** Rule documents over the occurrences above, each kind of matcher and rule. */
const documents = {
	matchers: decode({
		schemaVersion: 1,
		roles: matcherRoles,
		rules: [
			{
				kind: "character_budget",
				id: "b.cells",
				role: "cells",
				maximumCharacters: 12,
				recovery
			},
			{
				kind: "character_budget",
				id: "a.menu",
				role: "menu",
				maximumCharacters: 20,
				recovery
			},
			{
				kind: "character_budget",
				id: "c.entries",
				role: "entries",
				maximumCharacters: 5,
				recovery
			},
			{
				kind: "character_budget",
				id: "d.blocks",
				role: "text_blocks",
				maximumCharacters: 8,
				recovery
			},
			{
				kind: "character_budget",
				id: "e.rows",
				role: "rows_exact",
				maximumCharacters: 1,
				recovery
			},
			{
				kind: "terminology",
				id: "t.insensitive",
				role: "everything",
				caseSensitive: false,
				terms: [
					{ kind: "forbidden", term: "old" },
					{ kind: "forbidden", term: "öl" },
					{ kind: "preferred", term: "Select", alternatives: ["press", "click"] }
				],
				recovery
			},
			{
				kind: "terminology",
				id: "t.sensitive",
				role: "menu",
				caseSensitive: true,
				terms: [
					{ kind: "forbidden", term: "Old" },
					{ kind: "preferred", term: "rocket", alternatives: ["Rocket", "🚀"] }
				],
				recovery
			},
			{
				kind: "character_budget",
				id: "z.unused",
				role: "unused",
				maximumCharacters: 1,
				recovery
			}
		]
	}),
	everything: decode({
		schemaVersion: 1,
		roles: [matcherRoles[5]],
		rules: [
			{
				kind: "character_budget",
				id: "everything.limit",
				role: "everything",
				maximumCharacters: 1,
				recovery
			},
			{
				id: "translation.limit",
				kind: "localization_character_budget",
				role: "everything",
				cultures: { de: 6 },
				recovery
			}
		]
	}),
	none: decode({
		schemaVersion: 1,
		roles: [matcherRoles[6]],
		rules: [
			{ kind: "character_budget", id: "none", role: "unused", maximumCharacters: 1, recovery }
		]
	})
} satisfies Record<string, GameTextRuleDocument>;

/** The checked-in example documents, which hosts start from. */
const exampleDocuments = Effect.promise(async () => {
	const read = async (name: string) =>
		Effect.runSync(
			decodeGameTextRuleDocumentJson(
				await readFile(
					fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
					"utf8"
				)
			)
		);
	return [await read("quality-rules.source.json"), await read("quality-rules.localization.json")];
});

it.live(
	"indexed source quality equals the in-memory report and query for each rule document",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			fixture.update(occurrences(40));
			yield* Effect.gen(function* () {
				const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const findingCounts: Record<string, number> = {};
				for (const [name, document] of [
					...Object.entries(documents),
					...(yield* exampleDocuments).map(
						(document, index) => [`example${index + 1}`, document] as const
					)
				]) {
					const { report } = yield* expectSameSourceQuality(result, document);
					findingCounts[name] = report.findings.length;
					if (name === "matchers") {
						// Every role but the unused one selects something; both rule kinds report.
						expect(
							report.roles
								.filter((role) => role.matchedTextUnits === 0)
								.map((role) => role.role)
						).toEqual(["unused"]);
						expect(new Set(report.findings.map((finding) => finding.ruleId))).toEqual(
							new Set([
								"a.menu",
								"b.cells",
								"c.entries",
								"d.blocks",
								"e.rows",
								"t.insensitive",
								"t.sensitive"
							])
						);
						// A shared key's text reports once, naming both places.
						expect(
							report.findings.some(
								(finding) =>
									finding.actual.source === "Press old keys" &&
									finding.affectedOccurrences.length === 2
							)
						).toBe(true);
					}
				}
				expect(findingCounts.none).toBe(0);
				// Each unit with text, both texts of the conflicting key, and nothing blank.
				expect(findingCounts.everything).toBe(40 + 1 + 2 + 1);
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	120_000
);

it.live("a partial package's diagnostics and coverage reach the indexed report", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		fixture.update(occurrences(12));
		fixture.patchRecord({
			status: "partial",
			gapCounts: {
				unsupported_text_history: 2,
				legacy_container_element_without_type_information: 0,
				feature_unavailable_for_engine_version: 0,
				property_decoder_rejected: 0
			},
			gapSamples: [
				{
					object_path: "/Game/Text/Table.Table",
					property_path: "Nested.Unsupported",
					reason: "unsupported_text_history"
				}
			]
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const { report } = yield* expectSameSourceQuality(result, documents.matchers);
			expect(report.status).toBe("partial");
			expect(report.diagnosticCount).toBeGreaterThan(0);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

it.live(
	"the scan reports progress page by page, yields between pages and keeps every unit",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			// Over two pages of units; every unit reports under the `everything` document.
			fixture.update(occurrences(700));
			yield* Effect.gen(function* () {
				const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				yield* expectSameSourceQuality(result, documents.everything);
				const calls: GameTextIndexProgress[] = [];
				// A fiber that counts while the scan runs: it advances only when the scan yields.
				let ticks = 0;
				const ticked: number[] = [];
				const counter = yield* Effect.forkChild(
					Effect.forever(Effect.sync(() => ticks++).pipe(Effect.andThen(Effect.yieldNow)))
				);
				const indexed = yield* result.sourceQuality(documents.everything).pipe(
					Effect.provideService(GameTextIndexProgressReporter, (progress) => {
						calls.push(progress);
						ticked.push(ticks);
					})
				);
				yield* Fiber.interrupt(counter);
				// The generated keys, the shared key, the conflicting key and the invariant text.
				const total = 700 + 1 + 1 + 1;
				const phase = "source_quality";
				expect(calls[0]).toEqual({ phase, completed: 0, total, findings: 0 });
				expect(calls.length).toBeGreaterThanOrEqual(4);
				expect(calls.at(-1)).toEqual({
					phase,
					completed: total,
					total,
					findings: indexed.summary().findingCount
				});
				for (let index = 1; index < calls.length; index++) {
					expect(calls[index]!.total).toBe(total);
					expect(calls[index]!.completed).toBeGreaterThan(calls[index - 1]!.completed);
					expect(calls[index]!.findings!).toBeGreaterThanOrEqual(
						calls[index - 1]!.findings!
					);
				}
				// The counter ran between pages.
				expect(ticked.at(-1)!).toBeGreaterThan(ticked[1]!);
				// No rule reads nothing: progress still starts and ends.
				const empty: GameTextIndexProgress[] = [];
				yield* result
					.sourceQuality(documents.none)
					.pipe(
						Effect.provideService(GameTextIndexProgressReporter, (progress) =>
							empty.push(progress)
						)
					);
				expect(empty[0]).toEqual({ phase, completed: 0, total, findings: 0 });
				expect(empty.at(-1)).toEqual({ phase, completed: total, total, findings: 0 });
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped),
	120_000
);

// The fixture's package is Content/Text/Table.uasset, mounted at /Game/Text/Table: a Widget
// Blueprint with the copies a compile saves (see indexed-copies.test.ts).
const pkg = "/Game/Text/Table";
const classes = [
	{
		blueprint: `${pkg}.Table`,
		generatedClass: `${pkg}.Table_C`,
		classDefault: `${pkg}.Default__Table_C`,
		skeletonClass: `${pkg}.SKEL_Table_C`
	}
];
const widget = (object: string, key: string, source: string, property = "Text") =>
	asset(key, source, `${pkg}.${object}`, property, "/Script/UMG.TextBlock");
const blueprint: Occurrence[] = [
	// Edited, not compiled: the generated class still holds the old text.
	widget("Table_C.WidgetTree.Title", "Title", "Play the old game"),
	widget("Table.WidgetTree.Title", "Title", "Play the new game"),
	widget("Table.WidgetTree.Options", "Options", "Old options"),
	widget("Table_C.WidgetTree.Options", "Options", "Old options"),
	widget("SKEL_Table_C.WidgetTree.Options", "Options", "Older options"),
	// Saved only under the generated class: a place at its own path.
	widget(
		"Table_C.SimpleConstructionScript_0.SCS_Node_0",
		"Category",
		"Old category",
		"CategoryName"
	)
];

it.live("roles match a folded place by its authored path, never by its copies' paths", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		fixture.update(blueprint, classes);
		const role = (id: string, value: string) => ({
			id,
			scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value }] }]
		});
		const document = decode({
			schemaVersion: 1,
			roles: [
				role("authored", `${pkg}.Table.WidgetTree.`),
				role("compiled", `${pkg}.Table_C.`),
				role("skeleton", `${pkg}.SKEL_Table_C.`)
			],
			rules: ["authored", "compiled", "skeleton"].map((id) => ({
				kind: "terminology",
				id: `${id}.old`,
				role: id,
				caseSensitive: false,
				terms: [{ kind: "forbidden", term: "old" }],
				recovery
			}))
		});
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const { report } = yield* expectSameSourceQuality(result, document);
			expect(report.roles).toEqual([
				{ role: "authored", matchedOccurrences: 2, matchedTextUnits: 2 },
				// Only the construction-script node, which has no authored site.
				{ role: "compiled", matchedOccurrences: 1, matchedTextUnits: 1 },
				{ role: "skeleton", matchedOccurrences: 0, matchedTextUnits: 0 }
			]);
			// The title's place has the new text; its stale compiled copy's "old" is not checked.
			expect(
				report.findings.map((finding) => [finding.ruleId, finding.actual.source]).sort()
			).toEqual([
				["authored.old", "Old options"],
				["compiled.old", "Old category"]
			]);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);

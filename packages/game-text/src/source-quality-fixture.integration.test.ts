import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { assetReaderLayer, extractProjectTextPackages } from "@ue-shed/unreal-assets";
import { Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexRefresh, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { GameTextRuleDocument, decodeGameTextRuleDocumentJson } from "./game-text-rules.js";
import type { TextCorpus } from "./schema.js";
import { expectSameSourceQuality } from "./source-quality-index.test-support.js";
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
const recovery = "Revise the line.";
const scope = (kind: string, operator: "exact" | "prefix", value: string) => ({
	matchers: [{ kind, operator, value }]
});
/**
 * Roles over the saved fixture's own evidence, read from its corpus: each matcher kind, exact and
 * prefix, on values the fixture has.
 */
function matcherDocument(corpus: TextCorpus) {
	const locations = corpus.units.flatMap((unit) => unit.occurrences.map((item) => item.location));
	const cell = locations.find((location) => location.kind === "data_table_cell");
	const entry = locations.find((location) => location.kind === "string_table_entry");
	const property = locations.find((location) => location.kind === "asset_property");
	if (!cell || !entry || !property) throw new Error("The fixture lacks a location kind.");
	return Schema.decodeUnknownSync(GameTextRuleDocument)({
		schemaVersion: 1,
		roles: [
			{
				id: "everything",
				scopes: ["asset_property", "data_table_cell", "string_table_entry"].map(
					(value) => ({ matchers: [{ kind: "location_kind", value }] })
				)
			},
			{
				id: "localization",
				scopes: [scope("object_path", "prefix", "/Game/Fixture/Localization/")]
			},
			{
				id: "classes",
				scopes: [
					scope("class_path", "exact", property.classPath),
					scope("class_path", "prefix", "/Script/UMG")
				]
			},
			{
				id: "rows",
				scopes: [
					scope("row", "prefix", cell.row.slice(0, 3)),
					scope("row", "exact", cell.row)
				]
			},
			{
				id: "properties",
				scopes: [
					{
						matchers: [
							{
								kind: "property_path",
								operator: "exact",
								value: property.propertyPath
							},
							{ kind: "object_path", operator: "exact", value: property.objectPath }
						]
					},
					scope("property_path", "prefix", cell.propertyPath.slice(0, 2))
				]
			},
			{
				id: "entries",
				scopes: [scope("string_table_entry", "prefix", entry.entryKey.slice(0, 3))]
			},
			// Sites saved only under the review Blueprint's generated class stay places there.
			{
				id: "compiled",
				scopes: [
					scope(
						"object_path",
						"prefix",
						"/Game/Fixture/Blueprints/BP_ReviewFixture.BP_ReviewFixture_C."
					)
				]
			}
		],
		rules: [
			...["everything", "classes", "rows", "properties", "entries", "compiled"].map(
				(role, index) => ({
					kind: "character_budget",
					id: `${role}.limit`,
					role,
					maximumCharacters: 1 + index * 3,
					recovery
				})
			),
			{
				kind: "terminology",
				id: "everything.terms",
				role: "everything",
				caseSensitive: false,
				terms: [
					{ kind: "forbidden", term: "e" },
					{
						kind: "preferred",
						term: "Select",
						alternatives: ["press", "confirm", "skip"]
					}
				],
				recovery
			},
			{
				kind: "terminology",
				id: "localization.terms",
				role: "localization",
				caseSensitive: true,
				terms: [{ kind: "forbidden", term: "Welcome" }],
				recovery
			}
		]
	});
}
describe.skipIf(!executable)("source quality over the saved fixture's index", () => {
	it("equals the in-memory report and query for the example and matcher documents", async () => {
		const cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-source-quality-"));
		const examples = await Promise.all(
			["quality-rules.source.json", "quality-rules.localization.json"].map(async (name) =>
				Effect.runSync(
					decodeGameTextRuleDocumentJson(
						await readFile(
							fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
							"utf8"
						)
					)
				)
			)
		);
		try {
			const findings = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						// Package records, as the index reads them: Blueprint compiled copies fold into
						// their places. `scanTextCorpus` reads occurrences and keeps them apart.
						const memory = textCorpusFromExtractionEvents({
							projectRoot: fixture.root,
							events: yield* Stream.runCollect(
								extractProjectTextPackages({ projectRoot: fixture.root })
							)
						});
						const result = yield* (yield* GameTextIndexRefresh).refresh({
							projectRoot: fixture.root
						});
						const counts: number[] = [];
						const matchers = matcherDocument(memory);
						for (const document of [...examples, matchers]) {
							const { report } = yield* expectSameSourceQuality(result, document);
							counts.push(report.findings.length);
							if (document === matchers)
								expect(
									report.roles.filter((role) => role.matchedTextUnits === 0)
								).toEqual([]);
						}
						return counts;
					})
				).pipe(
					Effect.provide(
						gameTextIndexRefreshLayer(cacheRoot).pipe(
							Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
							Layer.provide(typeScriptIndexBuilderLayer),
							Layer.provide(LocalizationEvidenceNodeLive)
						)
					),
					Effect.provide(assetReaderLayer({ executable: executable! }))
				)
			);
			// The example rules find the fixture's long prompts and their terms.
			expect(findings[0]).toBeGreaterThan(0);
			expect(findings[2]).toBeGreaterThan(findings[0]!);
		} finally {
			await rm(cacheRoot, { recursive: true, force: true });
		}
	}, 120000);
});

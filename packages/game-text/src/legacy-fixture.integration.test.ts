import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { SavedAssetTextOccurrence, assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	expectedLegacyOccurrences,
	legacyVersions,
	readLegacyEvidence
} from "../../../fixtures/legacy-unreal-project/evidence.js";
import { scanTextCorpus } from "./corpus.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexRefresh, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import type { TextOccurrence } from "./schema.js";
import { hasSearchableSource } from "./search.js";
const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const generated = fileURLToPath(
	new URL("../../../fixtures/legacy-unreal-project/Generated/", import.meta.url)
);
const decodeOccurrence = Schema.decodeUnknownSync(SavedAssetTextOccurrence);
/** The reader's wire spelling, to compare with Unreal's evidence. */
function wireOccurrence(occurrence: TextOccurrence) {
	if (occurrence.location.kind === "code_place")
		throw new Error("A code place has no saved package.");
	return {
		source: occurrence.source,
		dev_notes: occurrence.devNotes,
		identity:
			occurrence.identity.status === "string_table"
				? {
						status: "string_table",
						table_id: occurrence.identity.tableId,
						key: occurrence.identity.key
					}
				: occurrence.identity,
		location:
			occurrence.location.kind === "string_table_entry"
				? {
						kind: "string_table_entry",
						object_path: occurrence.location.objectPath,
						entry_key: occurrence.location.entryKey
					}
				: occurrence.location.kind === "data_table_cell"
					? {
							kind: "data_table_cell",
							object_path: occurrence.location.objectPath,
							row: occurrence.location.row,
							property_path: occurrence.location.propertyPath
						}
					: {
							kind: "asset_property",
							object_path: occurrence.location.objectPath,
							class_path: occurrence.location.classPath,
							property_path: occurrence.location.propertyPath
						},
		edit_capability: occurrence.editCapability
	};
}
for (const version of legacyVersions) {
	describe.skipIf(!executable)(`UE ${version} legacy game text corpus`, () => {
		const root = join(generated, version);
		// UE 4.27 saves `None` as the package name; Game Text completes the path Unreal recorded.
		const expected = () =>
			expectedLegacyOccurrences(readLegacyEvidence(root), (asset) => asset.object_path).map(
				(occurrence) => decodeOccurrence(occurrence)
			);
		it("preserves Unreal text occurrences and keeps the native map gap out of coverage", async () => {
			const corpus = await Effect.runPromise(
				scanTextCorpus({ projectRoot: root }).pipe(
					Effect.provide(assetReaderLayer({ executable: executable! }))
				)
			);
			// NativeVectors cannot be decoded, but it holds no text: every gathered line was read.
			expect(corpus.status).toBe("complete");
			expect(corpus.coverage).toMatchObject({
				discoveredPackages: 3,
				inspectedPackages: 3,
				failedPackages: 0,
				partialPackages: 0,
				unsupportedTextProperties: 0,
				textOccurrences: expected().length
			});
			const actual = corpus.units.flatMap((unit) => unit.occurrences).map(wireOccurrence);
			expect(actual).toHaveLength(expected().length);
			expect(actual).toEqual(expect.arrayContaining(expected()));
			expect(corpus.diagnostics).toEqual([]);
		});
		it("indexes the same object paths, which object path roles then match", async () => {
			const cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-legacy-index-"));
			const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
				schemaVersion: 1,
				roles: [
					{
						id: "legacy",
						scopes: [
							{
								matchers: [
									{
										kind: "object_path",
										operator: "prefix",
										value: "/Game/Legacy/"
									}
								]
							}
						]
					}
				],
				rules: [
					...STARTER_CHECK_RULES.rules,
					{
						id: "legacy.limit",
						kind: "character_budget",
						role: "legacy",
						maximumCharacters: 1000,
						recovery: "Shorten the line."
					}
				]
			});
			try {
				const indexed = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const result = yield* (yield* GameTextIndexRefresh).refresh({
								projectRoot: root
							});
							// Rules check only units with source text; every one is under /Game/Legacy/.
							const checked = (yield* result.corpus).units.filter(
								hasSearchableSource
							);
							return {
								occurrences: (yield* result.corpus).units
									.flatMap((unit) => unit.occurrences)
									.map(wireOccurrence),
								checkedUnits: checked.length,
								checkedOccurrences: checked.flatMap((unit) => unit.occurrences)
									.length,
								roles: (yield* (yield* result.sourceQuality(document)).export(
									"all"
								)).roles
							};
						})
					).pipe(
						Effect.provide(
							gameTextIndexRefreshLayer(cacheRoot).pipe(
								Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
								Layer.provide(typeScriptIndexBuilderLayer),
								Layer.provide(assetReaderLayer({ executable: executable! })),
								Layer.provide(LocalizationEvidenceNodeLive)
							)
						)
					)
				);
				expect(indexed.occurrences).toHaveLength(expected().length);
				expect(indexed.occurrences).toEqual(expect.arrayContaining(expected()));
				expect(indexed.checkedUnits).toBeGreaterThan(0);
				expect(indexed.roles).toEqual([
					{
						role: "legacy",
						matchedOccurrences: indexed.checkedOccurrences,
						matchedTextUnits: indexed.checkedUnits
					}
				]);
			} finally {
				await rm(cacheRoot, { recursive: true, force: true });
			}
		}, 60000);
	});
}

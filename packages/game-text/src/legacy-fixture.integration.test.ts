import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SavedAssetTextOccurrence, assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	expectedLegacyOccurrences,
	legacySerializedObjectPath,
	legacyVersions,
	readLegacyEvidence
} from "../../../fixtures/legacy-unreal-project/evidence.js";
import { scanTextCorpus } from "./corpus.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const generated = fileURLToPath(
	new URL("../../../fixtures/legacy-unreal-project/Generated/", import.meta.url)
);

for (const version of legacyVersions) {
	describe.skipIf(!executable)(`UE ${version} legacy game text corpus`, () => {
		it("preserves Unreal text occurrences and reports the native map gap", async () => {
			const root = join(generated, version);
			const evidence = readLegacyEvidence(root);
			const tablePath = legacySerializedObjectPath(
				evidence.packages.find((asset) => asset.asset_name === "DT_LegacyText")!
			);
			const decodeOccurrence = Schema.decodeUnknownSync(SavedAssetTextOccurrence);
			const expected = expectedLegacyOccurrences(evidence).map((occurrence) =>
				decodeOccurrence(occurrence)
			);
			const corpus = await Effect.runPromise(
				scanTextCorpus({ projectRoot: root }).pipe(
					Effect.provide(assetReaderLayer({ executable: executable! }))
				)
			);
			expect(corpus.status).toBe("partial");
			expect(corpus.coverage).toMatchObject({
				discoveredPackages: 3,
				inspectedPackages: 3,
				failedPackages: 0,
				partialPackages: 1,
				unsupportedTextProperties: 1,
				textOccurrences: expected.length
			});
			const occurrences = corpus.units.flatMap((unit) => unit.occurrences);
			const actual = occurrences.map((occurrence) => ({
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
			}));
			expect(actual).toHaveLength(expected.length);
			expect(actual).toEqual(expect.arrayContaining(expected));
			expect(corpus.diagnostics).toContainEqual(
				expect.objectContaining({
					objectPath: tablePath,
					propertyPath: "NativeVectors"
				})
			);
		});
	});
}

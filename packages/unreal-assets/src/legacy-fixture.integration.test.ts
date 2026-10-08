import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	expectedLegacyOccurrences,
	legacySerializedObjectPath,
	legacyVersions,
	readLegacyEvidence,
	type LegacyTextEvidence
} from "../../../fixtures/legacy-unreal-project/evidence.js";
import {
	AssetReader,
	assetReaderLayer,
	extractProjectText,
	readSavedAsset,
	type SavedProperty,
	type SavedPropertyValue
} from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const generated = fileURLToPath(
	new URL("../../../fixtures/legacy-unreal-project/Generated/", import.meta.url)
);
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

function textsIn(properties: readonly SavedProperty[]) {
	const texts = new Map<string, Extract<SavedPropertyValue, { value_kind: "text" }>>();
	const visit = (value: SavedPropertyValue, path: string): void => {
		if (value.value_kind === "text") {
			expect(texts.has(path)).toBe(false);
			texts.set(path, value);
		} else if (value.value_kind === "struct") {
			for (const property of value.properties) visit(property, `${path}.${property.name}`);
		} else if (value.value_kind === "array" || value.value_kind === "set") {
			value.values.forEach((element, index) => visit(element, `${path}[${index}]`));
		} else if (value.value_kind === "map") {
			value.entries.forEach((entry, index) => {
				visit(entry.key, `${path}{${index}}.key`);
				visit(entry.value, `${path}{${index}}.value`);
			});
		} else if (value.value_kind === "raw") {
			expect(path).toBe("NativeVectors");
			expect(value.reason).toBe("legacy container struct element has no type information");
		}
	};
	for (const property of properties) visit(property, property.name);
	return texts;
}

function assertTexts(
	properties: readonly SavedProperty[],
	evidence: readonly LegacyTextEvidence[],
	sources: ReadonlyMap<string, string>,
	tableId: string
) {
	const actual = textsIn(properties);
	expect(actual.size).toBe(evidence.length);
	for (const text of evidence) {
		const saved = actual.get(text.property_path);
		expect(saved, text.property_path).toBeDefined();
		if (saved === undefined) throw new Error(`Missing text: ${text.property_path}`);
		expect(saved.history).toBe(
			text.history === "string_table_entry" ? "string_table" : text.history
		);
		if (saved.history === "base") {
			expect(saved.namespace).toBe(text.namespace);
			expect(saved.key).toBe(text.key);
			expect(saved.value).toBe(text.source);
			expect(text.culture_invariant).toBe(false);
		} else if (saved.history === "none") {
			expect(saved.value).toBe(text.source);
			expect(text.culture_invariant).toBe(text.source.length > 0);
		} else {
			expect(saved.table_id).toBe(tableId);
			expect(saved.table_id).toBe(text.table_id);
			expect(saved.key).toBe(text.key);
			expect(saved.value).toBe("");
			expect(sources.get(saved.key)).toBe(text.source);
			expect(text.culture_invariant).toBe(false);
		}
	}
}

for (const version of legacyVersions) {
	describe.skipIf(!executable)(`UE ${version} committed legacy fixture conformance`, () => {
		it("matches Unreal text, metadata, versions, and native gaps", async () => {
			const root = join(generated, version);
			const evidence = readLegacyEvidence(root);
			const tablePath = legacySerializedObjectPath(
				evidence.packages.find((asset) => asset.asset_name === "DT_LegacyText")!
			);
			expect(evidence.engine_version).toBe(version);
			const strings = evidence.packages.find((asset) => asset.asset_name === "ST_LegacyText");
			if (strings?.asset_name !== "ST_LegacyText") {
				throw new Error("Missing StringTable oracle.");
			}
			const stringsInspection = await runReader(
				readSavedAsset({ assetPath: join(root, "Content/Legacy/ST_LegacyText.uasset") })
			);
			const parsedStrings = stringsInspection.assets.find(
				(asset) => asset.object_path === legacySerializedObjectPath(strings)
			);
			if (parsedStrings?.kind !== "StringTable") {
				throw new Error("StringTable did not decode.");
			}
			expect(parsedStrings.string_table_namespace).toBe(strings.namespace);
			expect(
				parsedStrings.string_table_entries
					.map(({ key, source }) => ({ key, source }))
					.toSorted((a, b) => a.key.localeCompare(b.key))
			).toEqual(strings.entries.map(({ key, source }) => ({ key, source })));
			expect(parsedStrings.string_table_metadata).toEqual(
				Object.fromEntries(strings.entries.map((entry) => [entry.key, entry.metadata]))
			);
			const sources = new Map(
				parsedStrings.string_table_entries.map((entry) => [entry.key, entry.source])
			);
			for (const oracle of evidence.packages) {
				expect(oracle.object_path).toBe(
					`/Game/Legacy/${oracle.asset_name}.${oracle.asset_name}`
				);
				const inspection = await runReader(
					readSavedAsset({
						assetPath: join(root, "Content/Legacy", `${oracle.asset_name}.uasset`)
					})
				);
				expect(inspection.decode_errors).toEqual([]);
				expect(inspection.package.name).toBe(oracle.serialized_package_name);
				expect(inspection.package.version).toMatchObject({
					...oracle.versions,
					ue5: oracle.versions.ue5 ?? 0
				});
				const asset = inspection.assets.find(
					(asset) => asset.object_path === legacySerializedObjectPath(oracle)
				);
				if (oracle.asset_name === "DA_LegacyText") {
					if (!asset || !("properties" in asset)) {
						throw new Error("DataAsset did not decode.");
					}
					assertTexts(asset.properties, oracle.texts, sources, strings.object_path);
				} else if (oracle.asset_name === "DT_LegacyText") {
					if (!asset || !("rows" in asset)) throw new Error("DataTable did not decode.");
					expect(asset.rows.map((row) => row.name).toSorted()).toEqual([
						"EmptyContainers",
						"Full"
					]);
					for (const row of asset.rows) {
						const expected = oracle.rows.find(
							(candidate) => candidate.name === row.name
						)!;
						assertTexts(row.properties, expected.texts, sources, strings.object_path);
						const vectors = row.properties.find(
							(property) => property.name === "Vectors"
						);
						if (vectors?.value_kind !== "array") {
							throw new Error("Vector array did not decode.");
						}
						expect(
							vectors.values.map((value) => {
								if (value.value_kind !== "vector") {
									throw new Error("Native vector was misread.");
								}
								return [value.x, value.y, value.z];
							})
						).toEqual(expected.vectors);
						const native = row.properties.find(
							(property) => property.name === "NativeVectors"
						);
						if (row.name === "Full") {
							expect(native).toMatchObject({
								value_kind: "raw",
								reason: "legacy container struct element has no type information"
							});
						} else {
							expect(native).toMatchObject({ value_kind: "map", entries: [] });
						}
					}
				}
			}
			const events = await runReader(
				Stream.runCollect(
					extractProjectText({
						projectRoot: root,
						paths: evidence.packages.map((asset) =>
							join(root, "Content/Legacy", `${asset.asset_name}.uasset`)
						)
					})
				)
			);
			expect(events.filter((event) => event.event === "error")).toEqual([]);
			const actual = events.flatMap((event) =>
				event.event === "text_occurrence" ? [event.occurrence] : []
			);
			const expected: ReadonlyArray<unknown> = expectedLegacyOccurrences(evidence);
			expect(actual).toHaveLength(expected.length);
			expect(actual).toEqual(expect.arrayContaining<unknown>([...expected]));
			expect(
				events.flatMap((event) =>
					event.event === "text_coverage_gap" ? [event.coverage_gap] : []
				)
			).toEqual([
				{
					object_path: tablePath,
					property_path: "NativeVectors",
					reason: "legacy_container_element_without_type_information"
				}
			]);
			const packages = events.filter((event) => event.event === "text_package");
			expect(packages).toHaveLength(3);
			for (const event of packages) {
				expect(event.status).toBe(
					event.path.endsWith("DT_LegacyText.uasset") ? "partial" : "complete"
				);
			}
		});
	});
}

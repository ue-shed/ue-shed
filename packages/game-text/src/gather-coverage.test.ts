import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { textCorpusFromExtractionEvents } from "./corpus.js";
import { textCorpusDiagnosticSummary } from "./corpus-summary.js";
import {
	packageTextShard,
	refreshPackageTextLayer,
	type PackageTextInventoryEntry
} from "./package-text-layer.js";
import { decodePackageTextColumns, packageTextColumns } from "./package-text-columns.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";

const nativeGaps = {
	unsupported_text_history: 0,
	legacy_container_element_without_type_information: 0,
	feature_unavailable_for_engine_version: 0,
	property_decoder_rejected: 1_074
};

/** A Niagara-like package: many undecodable properties, every gatherable line decoded. */
function completeWithGaps(path: string): SavedAssetPackageTextRecord {
	return {
		...emptyPackageTextRecord(path),
		gapCounts: nativeGaps,
		gapSamples: [
			{
				object_path: "/Game/FX/NS_Burst.NS_Burst",
				property_path: "VariableToScriptVariable",
				reason: "property_decoder_rejected"
			}
		],
		gatherCoverage: { runtimeSites: 2, missing: 0, missingSamples: [] }
	};
}

function missingEnumNames(path: string): SavedAssetPackageTextRecord {
	return {
		...emptyPackageTextRecord(path),
		status: "partial",
		gatherCoverage: {
			runtimeSites: 4,
			missing: 4,
			missingSamples: ["White", "Green", "Red"].map((source, index) => ({
				namespace: "",
				key: `KEY${index}`,
				source,
				site: `/Game/UI/E_Style.E_Style.DisplayNameMap(${index} - Value).DisplayNameMap`
			}))
		}
	};
}

describe("gather coverage", () => {
	it("reports runtime gather entries that were not read and keeps other gaps as detail", () => {
		const corpus = textCorpusFromExtractionEvents({
			projectRoot: "C:/Project",
			events: [
				completeWithGaps("C:/Project/Content/FX/NS_Burst.uasset"),
				missingEnumNames("C:/Project/Content/UI/E_Style.uasset")
			]
		});
		expect(corpus.status).toBe("partial");
		expect(corpus.coverage.partialPackages).toBe(1);
		expect(corpus.coverage.unsupportedTextProperties).toBe(0);
		expect(corpus.coverage.missingGatherableText).toBe(4);
		expect(corpus.diagnostics.some((item) => item.packageFile.includes("NS_Burst"))).toBe(
			false
		);
		const partial = corpus.diagnostics.find(
			(item) => item.code === "package_partially_decoded"
		);
		expect(partial?.message).toMatch(
			/^4 of 4 runtime text entries in this package's gather table were not decoded\./
		);
		const missing = corpus.diagnostics.filter(
			(item) => item.code === "gatherable_text_not_decoded"
		);
		expect(missing.map((item) => item.objectPath)).toEqual([
			"/Game/UI/E_Style.E_Style.DisplayNameMap(0 - Value).DisplayNameMap",
			"/Game/UI/E_Style.E_Style.DisplayNameMap(1 - Value).DisplayNameMap",
			"/Game/UI/E_Style.E_Style.DisplayNameMap(2 - Value).DisplayNameMap"
		]);
		expect(missing[0]?.message).toContain('"White"');
		expect(textCorpusDiagnosticSummary(corpus.diagnostics).diagnosticCounts).toEqual({
			package_inspection_failed: 0,
			package_partially_decoded: 1,
			unsupported_text_history: 0,
			gatherable_text_not_decoded: 3
		});
	});

	it("is complete when only properties without gatherable text were undecodable", () => {
		const corpus = textCorpusFromExtractionEvents({
			projectRoot: "C:/Project",
			events: [completeWithGaps("C:/Project/Content/FX/NS_Burst.uasset")]
		});
		expect(corpus.status).toBe("complete");
		expect(corpus.coverage.partialPackages).toBe(0);
		expect(corpus.coverage.missingGatherableText).toBeUndefined();
		expect(corpus.diagnostics).toEqual([]);
	});

	it("round-trips gather evidence through the package text columns", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-gather-coverage-"));
		const headerData = {
			packageFlags: 0x40000,
			gatherableTextDataCount: 1,
			gatherableTextDataOffset: 1,
			hasTextProperty: true
		};
		const inventory: PackageTextInventoryEntry[] = [
			{ path: "Content/FX/NS_Burst.uasset", signature: "a", headerData },
			{ path: "Content/Legacy.uasset", signature: "b", headerData },
			{ path: "Content/UI/E_Style.uasset", signature: "c", headerData }
		];
		const records = new Map<string, SavedAssetPackageTextRecord>([
			["Content/FX/NS_Burst.uasset", completeWithGaps("Content/FX/NS_Burst.uasset")],
			["Content/Legacy.uasset", emptyPackageTextRecord("Content/Legacy.uasset")],
			["Content/UI/E_Style.uasset", missingEnumNames("Content/UI/E_Style.uasset")]
		]);
		try {
			const decoded = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* Effect.scoped(
							refreshPackageTextLayer({
								inventory,
								read: (paths) =>
									Stream.fromIterable(paths.map((path) => records.get(path)!))
							})
						);
						const reader = yield* (yield* SharedIndex).open();
						const result = [];
						for (const name of Object.keys(reader.manifest.active))
							if (name.startsWith("package-text."))
								result.push(
									...(yield* decodePackageTextColumns(yield* reader.layer(name)))
								);
						return result;
					})
				).pipe(
					Effect.provide(
						sharedIndexNodeLayer({
							cacheRoot: root,
							projectKey: root,
							targetKey: "gather"
						})
					)
				)
			);
			for (const stored of decoded) expect(stored.evidence).toEqual(records.get(stored.path));
			expect(decoded).toHaveLength(3);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 15000);

	it.each([
		"package-text-v1",
		"package-text-v2",
		"package-text-v3",
		"package-text-v4",
		"package-text-v5",
		"package-text-v6",
		"package-text-v7"
	])(
		"reads packages again when the cache holds %s shards",
		async (format) => {
			const root = await mkdtemp(join(tmpdir(), "ue-shed-gather-upgrade-"));
			const path = "Content/UI/E_Style.uasset";
			const entry: PackageTextInventoryEntry = {
				path,
				signature: "unchanged",
				headerData: {
					packageFlags: 0x40000,
					gatherableTextDataCount: 1,
					gatherableTextDataOffset: 1,
					hasTextProperty: true
				}
			};
			// The same package as an older format stored it.
			const previous = packageTextColumns([
				{
					path,
					signature: "unchanged",
					evidence: {
						...emptyPackageTextRecord(path),
						// v2 kept the package-relative object paths UE 4.27 packages are read with.
						occurrences: [
							{
								source: "White",
								dev_notes: "",
								identity: { status: "resolved", namespace: "", key: "KEY0" },
								location: {
									kind: "asset_property",
									object_path: "E_Style",
									class_path: "/Script/Engine.UserDefinedEnum",
									property_path: "DisplayNameMap{0}.value"
								},
								edit_capability: "read_only"
							}
						]
					}
				}
			]);
			// v1 shards were written before the gather columns existed, v1 to v3 before the
			// occurrence audience columns, and v1 to v7 before the serialized package name.
			const stale = {
				columns: previous.columns.filter(
					(column) =>
						!/^occurrence\.(?:gather|audience)$/u.test(column.name) &&
						column.name !== "package.name" &&
						(format !== "package-text-v1" ||
							!/^(?:package\.gather|package\.missing_start|missing\.)/u.test(
								column.name
							))
				)
			};
			const reads: string[] = [];
			try {
				const stored = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const index = yield* SharedIndex;
							yield* Effect.scoped(
								Effect.gen(function* () {
									const writer = yield* index.writer();
									yield* writer.publishCold([
										{
											name: `package-text.${packageTextShard(path)}`,
											key: `${format}:${packageTextShard(path)}:old`,
											source: stale
										}
									]);
								})
							);
							yield* Effect.scoped(
								refreshPackageTextLayer({
									inventory: [entry],
									read: (paths) => {
										reads.push(...paths);
										return Stream.fromIterable(
											paths.map(() => missingEnumNames(path))
										);
									}
								})
							);
							const reader = yield* index.open();
							return yield* decodePackageTextColumns(
								yield* reader.layer(`package-text.${packageTextShard(path)}`)
							);
						})
					).pipe(
						Effect.provide(
							sharedIndexNodeLayer({
								cacheRoot: root,
								projectKey: root,
								targetKey: "upgrade"
							})
						)
					)
				);
				expect(reads).toEqual([path]);
				expect(stored.map((record) => record.evidence)).toEqual([missingEnumNames(path)]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		15000
	);
});

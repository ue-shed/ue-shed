import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Schema, Stream, type Scope } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationError,
	LocalizationTarget,
	LocalizationTargetName,
	CultureCode,
	parseManifest,
	parseArchive,
	parsePO,
	projectPOEvidence,
	type LocalizationTargetEvidence
} from "../packages/localization/dist/index.js";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import {
	refreshPackageTextLayer,
	type PackageTextInventoryEntry
} from "../packages/game-text/src/package-text-layer.ts";
import { packageTextRecordsFromEvents } from "../packages/game-text/src/package-text-record.ts";
import {
	gameTextScaleEvents,
	gameTextScaleRecipe,
	gameTextScaleEntry,
	localizationScaleEntry
} from "./localization-scale-data.ts";
import {
	target,
	success,
	evidence as emptyEvidence
} from "../packages/game-text/src/localization.test-support.ts";
import { emptyPackageTextRecord } from "../packages/game-text/src/package-text-record.ts";
import type {
	SavedAssetPackageTextRecord,
	SavedAssetTextOccurrence
} from "../packages/unreal-assets/dist/index.js";
import { expectLocalizationImportMatchesParser } from "./localization-import-oracle.test-support.ts";

export async function withJoinCache(run: (cache: string) => Promise<void>) {
	const cache = await mkdtemp(join(tmpdir(), "ue-shed-columnar-join-"));
	try {
		await run(cache);
	} finally {
		await rm(cache, { recursive: true, force: true });
	}
}
export const joinStoreOptions = (projectRoot: string, cacheRoot: string, targetKey: string) => ({
	projectKey: resolve(projectRoot),
	cacheRoot,
	targetKey
});
export const runJoinIn = <A, E>(
	project: string,
	cache: string,
	targetKey: string,
	effect: Effect.Effect<A, E, SharedIndex | Scope.Scope>
) =>
	Effect.runPromise(
		Effect.scoped(effect).pipe(
			Effect.provide(sharedIndexNodeLayer(joinStoreOptions(project, cache, targetKey)))
		)
	);

export async function importJoinEvidence(
	projectRoot: string,
	cacheRoot: string,
	evidence: LocalizationTargetEvidence
) {
	for (const [format, file] of [
		["manifest", evidence.manifest],
		...evidence.cultures.flatMap(
			(culture) =>
				[
					["archive", culture.archive],
					["po", culture.po]
				] as const
		)
	] as const)
		if (file.status === "read")
			await expectLocalizationImportMatchesParser({
				projectRoot,
				cacheRoot,
				relativePath: file.provenance.relativePath,
				format,
				poFormat: evidence.target.poFormat,
				collapseMode: evidence.target.collapseMode,
				sharedTargetKey: evidence.target.name
			});
}
export function joinFileErrors(evidence: LocalizationTargetEvidence) {
	return Object.fromEntries(
		[
			evidence.manifest,
			...evidence.cultures.flatMap((culture) => [culture.archive, culture.po])
		].flatMap((file) =>
			file.status === "failed" ? [[file.relativePath, file.error.code]] : []
		)
	);
}
export async function fixtureJoinEvidence(projectRoot: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* LocalizationEvidence,
				discovery = yield* service.discover({ projectRoot });
			const evidence: LocalizationTargetEvidence[] = [];
			for (const target of discovery.targets)
				evidence.push(yield* service.read({ projectRoot, target }));
			if (evidence.length) return evidence;
			const fallback = LocalizationTarget.make({
				...target,
				name: LocalizationTargetName.make("SavedFixture"),
				configs: []
			});
			const fail = (relativePath: string) => ({
				status: "failed" as const,
				relativePath,
				error: new LocalizationError({
					code: "file_missing",
					message: "No authored localization file.",
					recovery: "Supply a target."
				})
			});
			return [
				{
					...emptyEvidence(),
					target: fallback,
					manifest: fail(fallback.outputPaths.manifest!),
					cultures: fallback.cultures.map((culture) => ({
						culture,
						archive: fail(fallback.outputPaths.archives[culture]!),
						po: fail(fallback.outputPaths.portableObjects[culture]!)
					}))
				}
			] satisfies LocalizationTargetEvidence[];
		}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	);
}

/** Tiny test data comes from the seeded construction; no retained project/asset is regenerated. */
export async function tinyJoinInput(cache: string, scale: number, seed = 57) {
	const provenance = (relativePath: string, size: number) => ({
		relativePath,
		size,
		modifiedTime: "2026-01-01T00:00:00Z",
		contentHash: "tiny-seeded"
	});
	const recipe = gameTextScaleRecipe(scale),
		projectRoot = join(cache, "tiny");
	await mkdir(projectRoot);
	const generatedTarget = Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		name: "Generated",
		cultures: recipe.cultures,
		nativeCulture: "en",
		configs: target.configs.map((config) => ({
			...config,
			steps: config.steps.map((step) => ({
				...step,
				fields: {
					...step.fields,
					IncludePathFilters: ["%LOCPROJECTROOT%Content/*"],
					ExcludePathFilters: ["%LOCPROJECTROOT%Content/L10N/*"]
				}
			}))
		})),
		outputPaths: {
			...target.outputPaths,
			manifest: "Generated.manifest",
			archives: Object.fromEntries(
				recipe.cultures.map((culture) => [culture, `${culture}.archive`])
			),
			portableObjects: Object.fromEntries(
				recipe.cultures.map((culture) => [culture, `${culture}.po`])
			)
		}
	});
	const entries = Array.from({ length: recipe.keys }, (_, index) =>
		gameTextScaleEntry(index, recipe, seed)
	);
	const manifestBytes = Buffer.from(
		"\uFEFF" +
			JSON.stringify({
				FormatVersion: 1,
				Namespace: "",
				Subnamespaces: entries.map((entry) => ({
					Namespace: entry.namespace,
					Children: [
						{
							Source: { Text: entry.source },
							Keys: [
								{
									Key: entry.key,
									Path: entry.path,
									MetaData: { Info: { DevNotes: "Velora nimblet" } }
								}
							]
						}
					]
				}))
			}),
		"utf16le"
	);
	await writeFile(join(projectRoot, "Generated.manifest"), manifestBytes);
	const cultures: LocalizationTargetEvidence["cultures"][number][] = [];
	for (const culture of recipe.cultures) {
		const archiveBytes = Buffer.from(
			"\uFEFF" +
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "",
					Subnamespaces: entries.map((entry, index) => ({
						Namespace: entry.namespace,
						Children: [
							{
								Source: { Text: entry.source },
								Translation: {
									Text:
										index % 97 === 1
											? ""
											: culture === "en"
												? entry.source
												: `${culture} ${entry.translation}`
								},
								Key: entry.key
							}
						]
					}))
				}),
			"utf16le"
		);
		const poBytes = Buffer.from(
			'\uFEFFmsgid ""\r\nmsgstr ""\r\n\r\n' +
				entries
					.map((entry, index) => {
						const translation =
							index % 97 === 1
								? ""
								: culture === "en"
									? entry.source
									: `${culture} ${entry.translation}`;
						return localizationScaleEntry(index, {
							...entry,
							translation: index % 89 === 2 ? translation + " mirava" : translation
						}).po;
					})
					.join("")
		);
		await writeFile(join(projectRoot, `${culture}.archive`), archiveBytes);
		await writeFile(join(projectRoot, `${culture}.po`), poBytes);
		cultures.push({
			culture: CultureCode.make(culture),
			archive: {
				status: "read",
				provenance: provenance(`${culture}.archive`, archiveBytes.length),
				value: success(parseArchive(archiveBytes))
			},
			po: {
				status: "read",
				provenance: provenance(`${culture}.po`, poBytes.length),
				value: projectPOEvidence(success(parsePO(poBytes)))
			}
		});
	}
	const evidence: LocalizationTargetEvidence = {
		...emptyEvidence(),
		target: generatedTarget,
		manifest: {
			status: "read",
			provenance: provenance("Generated.manifest", manifestBytes.length),
			value: success(parseManifest(manifestBytes))
		},
		cultures
	};
	const events = [...gameTextScaleEvents(recipe, seed)];
	const records = [...packageTextRecordsFromEvents(events)].filter(
		(event) => event.event === "text_package_record"
	);
	const inventory: PackageTextInventoryEntry[] = records
		.map((record) => {
			const index = Number(/Package(\d+)\./u.exec(record.path)?.[1]);
			return {
				path: record.path,
				signature: "seed:57",
				headerData: {
					packageFlags: index < recipe.textPackages ? 0x00040000 : 0,
					gatherableTextDataCount: 0,
					gatherableTextDataOffset: 0,
					hasTextProperty: false
				}
			};
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	await importJoinEvidence(projectRoot, cache, evidence);
	await runJoinIn(
		projectRoot,
		cache,
		"Generated",
		refreshPackageTextLayer({
			inventory,
			read: (paths) =>
				Stream.fromIterable(records.filter((record) => paths.includes(record.path)))
		})
	);
	return { projectRoot, evidence, events, inventory, recipe };
}

export async function semanticJoinInput(cache: string) {
	const projectRoot = join(cache, "cases");
	await mkdir(projectRoot);
	const cases = [
		["Old", "Old text", "/Game/Text/Table.Table.Label", "UI"],
		["Base", "Base text", "/Game/Text/Table.Table.Base", "UI"],
		["T", "Table text", "/Game/Text/ST.ST", "UI [literal]"],
		["M", "Missing text", "/Game/Text/Missing.Missing.Label", "UI"],
		["P", "Partial text", "/Game/Text/Partial.Partial.Label", "UI"],
		["X", "Excluded text", "/Game/Text/Excluded.Excluded.Label", "UI"],
		["G", "Code text", "Source/Module/File.cpp:7", "UI"],
		["O", "Outside text", "/Game/L10N/Outside.Outside.Label", "UI"],
		["U", "Source", "/Game/Text/Table.Table.Update", "UI"],
		["N", "No translation", "/Game/Text/Table.Table.Empty", "UI"],
		["S", "Pending source", "/Game/Text/Table.Table.Pending", "UI"],
		["I", "Same in package", "/Game/Text/Table.Table.Previous", "UI"],
		["F", "Unique project text", "/Game/Text/Other.Other.Previous", "UI"],
		["A1", "Ambiguous", "/Game/Text/Other.Other.A1", "UI"],
		["A2", "Ambiguous", "/Game/Text/Other.Other.A2", "UI"]
	] as const;
	const authored = Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		name: "Cases",
		configs: target.configs.map((config) => ({
			...config,
			steps: config.steps.map((step) => ({
				...step,
				fields: {
					...step.fields,
					IncludePathFilters: ["%LOCPROJECTROOT%Content/*"],
					ExcludePathFilters: ["%LOCPROJECTROOT%Content/L10N/*"]
				}
			}))
		})),
		outputPaths: {
			...target.outputPaths,
			manifest: "Cases.manifest",
			archives: { en: "en.archive", de: "de.archive" },
			portableObjects: { en: "en.po", de: "de.po" }
		}
	});
	const extra = (key: string, archive: boolean) =>
		key === "U" ? { Context: archive ? { b: 2, a: 1 } : { a: 1, b: 3 } } : {};
	const manifestBytes = Buffer.from(
		"\uFEFF" +
			JSON.stringify({
				FormatVersion: 1,
				Namespace: "",
				Subnamespaces: cases.map(([key, source, path, namespace]) => ({
					Namespace: namespace,
					Children: [
						{
							Source: { Text: source, ...extra(key, false) },
							Keys: [
								{
									Key: key,
									Path: path,
									Optional: false,
									DevNotes: "fixture note",
									MetaData: { Info: { Comment: "Comment" } }
								}
							]
						}
					]
				}))
			}),
		"utf16le"
	);
	await writeFile(join(projectRoot, "Cases.manifest"), manifestBytes);
	const provenance = (relativePath: string, bytes: Uint8Array) => ({
		relativePath,
		size: bytes.length,
		modifiedTime: "2026-01-01T00:00:00Z",
		contentHash: "cases"
	});
	const cultures: LocalizationTargetEvidence["cultures"][number][] = [];
	for (const culture of authored.cultures) {
		const translation = (key: string, source: string) =>
			key === "N" ? "" : culture === "en" ? source : `de Translation ${key}`;
		const archiveBytes = Buffer.from(
			"\uFEFF" +
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "",
					Subnamespaces: cases.map(([key, source, _path, namespace]) => ({
						Namespace: namespace,
						Children: [
							{
								Source: { Text: source, ...extra(key, true) },
								Translation: { Text: translation(key, source) },
								Key: key,
								Optional: false
							}
						]
					}))
				}),
			"utf16le"
		);
		const poBytes = Buffer.from(
			'\uFEFFmsgid ""\r\nmsgstr ""\r\n\r\n' +
				cases
					.map(
						([key, source, path, namespace], index) =>
							localizationScaleEntry(index, {
								key,
								source,
								path,
								namespace,
								translation:
									key === "S" ? "Pending translation" : translation(key, source)
							}).po
					)
					.join("")
		);
		await writeFile(join(projectRoot, `${culture}.archive`), archiveBytes);
		await writeFile(join(projectRoot, `${culture}.po`), poBytes);
		cultures.push({
			culture,
			archive: {
				status: "read",
				provenance: provenance(`${culture}.archive`, archiveBytes),
				value: success(parseArchive(archiveBytes))
			},
			po: {
				status: "read",
				provenance: provenance(`${culture}.po`, poBytes),
				value: projectPOEvidence(success(parsePO(poBytes)))
			}
		});
	}
	const evidence: LocalizationTargetEvidence = {
		...emptyEvidence(),
		target: authored,
		manifest: {
			status: "read",
			provenance: provenance("Cases.manifest", manifestBytes),
			value: success(parseManifest(manifestBytes))
		},
		cultures
	};
	const occurrence = (
		key: string,
		source: string,
		property_path: string
	): SavedAssetTextOccurrence => ({
		source,
		dev_notes: "",
		identity: { status: "resolved", namespace: "UI [package]", key },
		location: {
			kind: "asset_property",
			object_path: "/Game/Text/Table.Table",
			class_path: "/Script/Engine.DataAsset",
			property_path
		},
		edit_capability: "read_only"
	});
	const records: SavedAssetPackageTextRecord[] = [
		{
			...emptyPackageTextRecord("Content/Text/Table.uasset"),
			occurrences: [
				occurrence("New", "New text", "Label"),
				occurrence("Base", "Base text", "Base"),
				occurrence("U", "Source", "Update"),
				occurrence("N", "No translation", "Empty"),
				occurrence("S", "Pending source", "Pending"),
				occurrence("NewI", "Same in package", "Fresh"),
				occurrence("NewF", "Unique project text", "Fresh2"),
				occurrence("NewA", "Ambiguous", "Fresh3"),
				{
					...occurrence("", "Keyless text", "Keyless"),
					identity: { status: "unresolved", reason: "culture_invariant" }
				},
				{
					...occurrence("T", "", "Reference"),
					identity: { status: "string_table", table_id: "/Game/Text/ST.ST", key: "T" }
				},
				{
					...occurrence("Z", "", "MissingReference"),
					identity: {
						status: "string_table",
						table_id: "/Game/Text/Absent.Absent",
						key: "Z"
					}
				}
			]
		},
		{
			...emptyPackageTextRecord("Content/Text/ST.uasset"),
			occurrences: [
				{
					source: "Table text",
					dev_notes: "",
					identity: { status: "resolved", namespace: "UI [literal]", key: "T" },
					location: {
						kind: "string_table_entry",
						object_path: "/Game/Text/ST.ST",
						entry_key: "T"
					},
					edit_capability: "source_editable"
				}
			]
		},
		{
			...emptyPackageTextRecord("Content/Other/Split.uasset"),
			occurrences: [
				{
					...occurrence("T", "Table text", "Split"),
					dev_notes: "Split note",
					identity: { status: "resolved", namespace: "UI [literal]", key: "T" },
					location: {
						kind: "asset_property",
						object_path: "/Game/Other/Split.Split",
						property_path: "Split",
						class_path: "/Script/Engine.DataAsset"
					}
				}
			]
		},
		{
			...emptyPackageTextRecord("Content/L10N/Outside.uasset"),
			occurrences: [
				{
					...occurrence("O", "Outside text", "Label"),
					location: {
						kind: "asset_property",
						object_path: "/Game/L10N/Outside.Outside",
						property_path: "Label",
						class_path: "/Script/Engine.DataAsset"
					}
				}
			]
		},
		emptyPackageTextRecord("Content/Text/Other.uasset"),
		emptyPackageTextRecord("Content/Text/Missing.uasset"),
		{ ...emptyPackageTextRecord("Content/Text/Partial.uasset"), status: "partial" }
	];
	const inventory: PackageTextInventoryEntry[] = [
		...records.map((record) => ({
			path: record.path,
			signature: "1",
			headerData: {
				packageFlags: 0x00040000,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		})),
		{
			path: "Content/Text/Excluded.uasset",
			signature: "1",
			headerData: {
				packageFlags: 0,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		}
	].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	await importJoinEvidence(projectRoot, cache, evidence);
	await runJoinIn(
		projectRoot,
		cache,
		"Cases",
		refreshPackageTextLayer({
			inventory,
			read: (paths) =>
				Stream.fromIterable(records.filter((record) => paths.includes(record.path)))
		})
	);
	return { projectRoot, evidence, records, inventory };
}

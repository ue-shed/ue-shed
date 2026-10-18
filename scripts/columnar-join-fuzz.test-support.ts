import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { JoinedQueryData } from "../packages/game-text/src/joined-query-data.test-support.ts";
import { columnarTextCorpusQuery } from "../packages/game-text/src/columnar-query.test-support.ts";
import { Effect, Option, Schema, Stream } from "effect";
import {
	LocalizationTarget,
	parseManifest,
	parseArchive,
	parsePO,
	projectPOEvidence,
	LocalizationReviewFile,
	localizationReviewFingerprint,
	type LocalizationTargetEvidence
} from "../packages/localization/dist/index.js";
import { SavedAssetPackageTextRecord } from "../packages/unreal-assets/dist/index.js";
import { emptyPackageTextRecord } from "../packages/game-text/src/package-text-record.ts";
import {
	refreshPackageTextLayer,
	textCorpusFromPackageTextLayer
} from "../packages/game-text/src/package-text-layer.ts";
import { refreshJoinedTarget } from "../packages/game-text/src/joined-target-reference.test-support.ts";
import {
	openJoinedTarget,
	hydrateJoinedTarget,
	inspectJoinedTarget
} from "../packages/game-text/src/joined-target-reader.ts";
import { u32 } from "../packages/game-text/src/joined-target-input.ts";
import {
	joinLocalizationTarget,
	applyLocalizationKeyChanges,
	localizationKeyChanges,
	applyLocalizationReview
} from "../packages/game-text/src/index.ts";
import { indexedLocalizationStatusReport } from "../packages/game-text/src/index-context.ts";
import { localizationStatusReport } from "../packages/game-text/src/localization-status.ts";
import { textCorpusQuery } from "../packages/game-text/src/query.test-support.ts";
import { TextProblem, TextCorpusSearchRequest } from "../packages/game-text/src/schema.ts";
import { localizationStates } from "../packages/game-text/src/localization-schema.ts";
import {
	target,
	evidence as emptyEvidence,
	success
} from "../packages/game-text/src/localization.test-support.ts";
import { candidateCorpusFromEvents } from "./package-text-layer-oracle.test-support.ts";
import { compareLocalizationJoins } from "./localization-join-oracle.test-support.ts";
import { importJoinEvidence, runJoinIn } from "./columnar-join.test-support.ts";
import { localizationScaleEntry } from "./localization-scale-data.ts";
import { joinMemoryLayer } from "./columnar-join-memory.test-support.ts";
import { localizationColumnsBuilder } from "../packages/game-text/src/localization-columns.ts";
import { defaultLocalizationImportLimits } from "../packages/game-text/src/localization-stream.ts";
import { SharedIndex } from "../packages/game-text/src/shared-index.ts";
import { snapshotColumnsSource } from "../packages/game-text/src/snapshot-file.ts";

const Entry = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	source: Schema.String,
	path: Schema.String,
	notes: Schema.String
});
type Entry = typeof Entry.Type;
const Translation = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	source: Schema.String,
	translation: Schema.String
});
export const JoinFuzzInput = Schema.Struct({
	seed: Schema.Int,
	cultures: Schema.Array(Schema.String),
	records: Schema.Array(SavedAssetPackageTextRecord),
	excluded: Schema.Array(Schema.String),
	manifest: Schema.Array(Entry),
	archives: Schema.Array(Schema.Array(Translation)),
	pos: Schema.Array(Schema.Array(Translation.pipe(Schema.fieldsAssign({ path: Schema.String })))),
	review: Schema.optionalKey(LocalizationReviewFile)
});
export type JoinFuzzInput = typeof JoinFuzzInput.Type;

/** Keep independent structural/parser failures separate in the discovery ledger. */
export function joinFuzzException(cause: unknown) {
	const parsed = Schema.decodeUnknownOption(
		Schema.Struct({
			_tag: Schema.optionalKey(Schema.String),
			section: Schema.optionalKey(Schema.String),
			code: Schema.optionalKey(Schema.String)
		})
	)(cause);
	const section = Option.isSome(parsed)
		? (parsed.value.section ?? parsed.value.code ?? "unclassified")
		: "unclassified";
	const kind = Option.isSome(parsed) ? (parsed.value._tag ?? "error") : "error";
	return [{ field: `join.exception.${kind}.${section}`, detail: String(cause) }];
}

/** Mulberry32: the complete input depends on the seed, never clocks or the host. */
export function joinFuzzInput(seed: number): JoinFuzzInput {
	let state = seed >>> 0;
	const random = () => {
		state += 0x6d2b79f5;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	const int = (limit: number) => Math.floor(random() * limit);
	const pick = <A>(values: readonly A[]): A => values[int(values.length)]!;
	const sources = [
		"",
		" ",
		"Alpha",
		"Beta",
		"same source",
		"A".repeat(39),
		"B".repeat(40),
		"C".repeat(41),
		"m".repeat(19) + "\n" + "n".repeat(19),
		"m".repeat(19) + "\u2028" + "n".repeat(20),
		"m".repeat(20) + "\n" + "n".repeat(20),
		"😀".repeat(19) + "x",
		"😀".repeat(20),
		"😀".repeat(20) + "x",
		"İstanbul\né",
		"Alpha source twenty four",
		"Beta source twenty four",
		"first\nsecond",
		"first\u2028second",
		"\ufeffAlpha",
		"alpha\u0000beta",
		"\ue000",
		"𐀀",
		"x".repeat(120)
	];
	const loneSources = ["lead\ud800", "trail\udfff", "\udfff\ud800", "a".repeat(39) + "\ud800"];
	const count = 2 + int(19);
	const records = Array.from({ length: count }, (_, row) => ({
		...emptyPackageTextRecord(
			`Content/${row % 7 === 6 ? "L10N" : "Text"}/Package${String(row).padStart(2, "0")}.uasset`
		),
		status: int(8) === 0 ? ("partial" as const) : ("complete" as const),
		// SAFETY: This empty mutable collection is populated only with schema-owned occurrences below.
		occurrences: [] as SavedAssetPackageTextRecord["occurrences"][number][]
	}));
	const excluded = records.filter(() => int(10) === 0).map((record) => record.path);
	const occurrences = 1 + int(40);
	for (let row = 0; row < occurrences; row++) {
		const record = pick(records),
			key = `K${int(6)}`,
			kind = int(6);
		const namespace = pick(["UI", "UI [package]", "UI [literal]", "Other"]);
		const object = `/Game/${record.path.slice(8, -7)}.Object`;
		record.occurrences.push({
			source: int(100) < 3 ? pick(loneSources) : pick(sources),
			dev_notes: pick(["", " ", "note\u2028line"]),
			identity:
				kind === 4
					? { status: "string_table", table_id: "/Game/Text/Table.Table", key }
					: kind === 5
						? {
								status: "unresolved",
								reason: pick(["culture_invariant", "missing_key"] as const)
							}
						: { status: "resolved", namespace, key: int(15) === 0 ? "" : key },
			location:
				kind === 0
					? {
							kind: "string_table_entry",
							object_path: "/Game/Text/Table.Table",
							entry_key: key
						}
					: kind === 1
						? {
								kind: "data_table_cell",
								object_path: object,
								row: `Row${int(3)}`,
								property_path: `Label${row}`
							}
						: {
								kind: "asset_property",
								object_path: object,
								class_path: "/Script/Engine.DataAsset",
								property_path: `Label${row}`
							},
			edit_capability: pick(["read_only", "source_editable"] as const)
		});
	}
	const manifest: Entry[] = Array.from({ length: 1 + int(12) }, () => ({
		namespace: pick(["UI", "UI [literal]", "Other"]),
		key: `K${int(8)}`,
		source: pick(sources),
		notes: pick(["", "note"]),
		path: pick([
			"Source/Module/File.cpp:7",
			"Config/Game.ini",
			`/Game/Text/Package${String(int(count)).padStart(2, "0")}.Object.Label0`,
			"/Game/L10N/Outside.Object.Label",
			"D:/Outside/File.cpp:3"
		])
	}));
	const cultures = ["en", "de", "fr", "ja"].slice(0, 1 + int(4));
	const archives = cultures.map((culture) =>
		manifest
			.filter(() => int(5) > 0)
			.map((entry) => ({
				namespace: entry.namespace,
				key: entry.key,
				source: int(5) === 0 ? pick(sources) : entry.source,
				translation: pick([
					"",
					entry.source,
					`${culture} translated`,
					"translation\n\u2028line"
				])
			}))
	);
	const pos = cultures.map((culture) =>
		manifest
			.filter(() => int(5) > 0)
			.map((entry) => ({
				...entry,
				translation: pick(["", entry.source, `${culture} translated`, "pending"])
			}))
	);
	const review =
		int(3) === 0
			? undefined
			: Schema.decodeUnknownSync(LocalizationReviewFile)({
					schemaVersion: 1,
					target: "Fuzz",
					acceptedFindings: [],
					records: [
						...new Map(
							manifest.map((entry) => [
								JSON.stringify([entry.namespace, entry.key]),
								entry
							])
						).values()
					].flatMap((entry) =>
						cultures
							.filter(() => int(2) === 0)
							.map((culture) => ({
								culture,
								namespace: entry.namespace,
								key: entry.key,
								flags: [
									pick([
										"reviewed",
										"proofread",
										"approved",
										"machine_translated"
									])
								],
								fingerprint: localizationReviewFingerprint(
									entry.source,
									int(2) ? "changed" : entry.source
								),
								by: "Fuzz reviewer",
								at: "2026-01-01T00:00:00Z"
							}))
					)
				});
	const result: JoinFuzzInput = {
		seed,
		cultures,
		records,
		excluded,
		manifest,
		archives,
		pos
	};
	if (review) Object.assign(result, { review });
	return result;
}

export interface FuzzDifference {
	field: string;
	detail: string;
}

/** Runtime schemas can include an explicitly undefined optional property before wire encoding. */
type OracleValue =
	| Schema.Json
	| undefined
	| readonly OracleValue[]
	| { readonly [key: string]: OracleValue };
const oracleRecord = Schema.Record(Schema.String, Schema.Unknown);
function isOracleRecord(value: OracleValue): value is { readonly [key: string]: OracleValue } {
	return Schema.is(oracleRecord)(value);
}

/** Bounded delta debugging: keep only reductions that still expose the selected field. */
export async function shrinkJoinFuzzInput(
	input: JoinFuzzInput,
	fails: (candidate: JoinFuzzInput) => Promise<boolean>,
	maximumAttempts = 80
) {
	let current = structuredClone(input),
		attempts = 0;
	const reduce = async (candidates: (value: JoinFuzzInput) => JoinFuzzInput[]) => {
		let changed = true;
		while (changed && attempts < maximumAttempts) {
			changed = false;
			for (const candidate of candidates(current)) {
				if (++attempts > maximumAttempts) break;
				if (await fails(candidate)) {
					current = candidate;
					changed = true;
					break;
				}
			}
		}
	};
	await reduce((value) =>
		value.records.map((_, index) => ({
			...value,
			records: value.records.filter((_, row) => row !== index)
		}))
	);
	await reduce((value) =>
		value.records.flatMap((record, index) =>
			record.occurrences.map((_, occurrence) => ({
				...value,
				records: value.records.map((record, row) =>
					row === index
						? {
								...record,
								occurrences: record.occurrences.filter(
									(_, item) => item !== occurrence
								)
							}
						: record
				)
			}))
		)
	);
	for (const field of ["manifest", "archives", "pos"] as const)
		await reduce((value) => {
			if (field === "manifest")
				return value.manifest.map((_, index) => ({
					...value,
					manifest: value.manifest.filter((_, row) => row !== index)
				}));
			return value[field].flatMap((rows, culture) =>
				rows.map((_, index) => ({
					...value,
					[field]: value[field].map((rows, ci) =>
						ci === culture ? rows.filter((_, row) => row !== index) : rows
					)
				}))
			);
		});
	return { input: current, attempts, bounded: attempts >= maximumAttempts };
}

/** Actual persisted layers, original event oracle, all join fields and query result fields. */
export async function compareJoinFuzzInput(
	input: JoinFuzzInput,
	cache: string,
	persisted = false,
	buildJoined?: (
		configuration: ReturnType<
			typeof import("./columnar-join.test-support.ts").joinStoreOptions
		>,
		input: import("../packages/game-text/src/joined-target.ts").JoinedTargetInput
	) => Promise<void>,
	nativeSearch?: (
		configuration: ReturnType<
			typeof import("./columnar-join.test-support.ts").joinStoreOptions
		>,
		requests: readonly TextCorpusSearchRequest[],
		lines: readonly string[],
		focus: readonly import("../packages/game-text/src/schema.ts").TextCorpusFocusRequest[],
		exports: readonly TextCorpusSearchRequest[],
		details: readonly import("../packages/game-text/src/localization-view.ts").LocalizationFocusRequest[]
	) => Promise<{
		readonly searches: readonly import("../packages/game-text/src/schema.ts").TextCorpusSearchPage[];
		readonly lines: readonly (
			| import("../packages/game-text/src/localization-schema.ts").LocalizationLine
			| undefined
		)[];
		readonly summary: import("../packages/game-text/src/schema.ts").TextCorpusQuerySummary;
		readonly corpusLines: readonly import("../packages/game-text/src/localization-schema.ts").LocalizationLine[];
		readonly exports: readonly import("../packages/game-text/src/schema.ts").TextCorpus[];
		readonly focus: readonly (
			| import("../packages/game-text/src/schema.ts").TextCorpusFocus
			| null
		)[];
		readonly details: readonly (
			| import("../packages/game-text/src/localization-view.ts").LocalizationFocus
			| undefined
		)[];
	}>,
	seedDictionary = false
): Promise<FuzzDifference[]> {
	const projectRoot = join(cache, "project");
	if (persisted) await mkdir(projectRoot, { recursive: true });
	const memoryLayer = joinMemoryLayer();
	const run = <A, E>(effect: Parameters<typeof runJoinIn<A, E>>[3]) =>
		persisted
			? runJoinIn(projectRoot, cache, "Fuzz", effect)
			: Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(memoryLayer)));
	if (seedDictionary)
		await run(
			Effect.gen(function* () {
				const writer = yield* (yield* SharedIndex).writer();
				const key = yield* writer.intern("identity", ["K0"]);
				const empty = yield* writer.intern("identity", [""]);
				if (key[0] !== 0 || empty[0] !== 1)
					throw new Error("Shifted dictionary fixture did not retain its intended IDs");
				yield* writer.publish(
					"dictionary-seed",
					"dictionary-seed",
					snapshotColumnsSource([{ name: "seed", kind: "u32", values: key }])
				);
			})
		);
	const importMemory = async (
		name: string,
		data: Buffer,
		format: "manifest" | "archive" | "po"
	) => {
		const spill = join(cache, `${name}.spill`);
		const builder = localizationColumnsBuilder(
			name,
			spill,
			{ format, poFormat: target.poFormat, collapseMode: target.collapseMode },
			defaultLocalizationImportLimits
		);
		try {
			builder.feed(data.toString(format === "po" ? "utf8" : "utf16le").slice(1));
			const source = await builder.finish();
			await run(
				Effect.gen(function* () {
					return yield* (yield* (yield* SharedIndex).writer()).publish(
						name,
						name,
						source
					);
				})
			);
		} finally {
			builder.close();
			await unlink(spill);
		}
	};
	const authored = Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		name: "Fuzz",
		cultures: input.cultures,
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
			manifest: "Fuzz.manifest",
			archives: Object.fromEntries(
				input.cultures.map((culture) => [culture, `${culture}.archive`])
			),
			portableObjects: Object.fromEntries(
				input.cultures.map((culture) => [culture, `${culture}.po`])
			)
		}
	});
	const bytes = (
		entries: readonly Entry[] | JoinFuzzInput["archives"][number],
		archive = false
	) =>
		Buffer.from(
			"\uFEFF" +
				JSON.stringify({
					FormatVersion: archive ? 2 : 1,
					Namespace: "",
					Subnamespaces: entries.map((entry) => ({
						Namespace: entry.namespace,
						Children: [
							archive && "translation" in entry
								? {
										Key: entry.key,
										Source: { Text: entry.source },
										Translation: { Text: entry.translation }
									}
								: {
										Source: { Text: entry.source },
										Keys: [
											{
												Key: entry.key,
												Path: "path" in entry ? entry.path : "",
												DevNotes: "notes" in entry ? entry.notes : ""
											}
										]
									}
						]
					}))
				}),
			"utf16le"
		);
	const provenance = (relativePath: string, data: Buffer) => ({
		relativePath,
		size: data.length,
		modifiedTime: "2026-01-01T00:00:00Z",
		contentHash: "fuzz"
	});
	const manifest = bytes(input.manifest);
	if (persisted) await writeFile(join(projectRoot, "Fuzz.manifest"), manifest);
	else await importMemory("Fuzz.manifest", manifest, "manifest");
	const cultures: LocalizationTargetEvidence["cultures"][number][] = [];
	for (let ci = 0; ci < authored.cultures.length; ci++) {
		const culture = authored.cultures[ci]!,
			archive = bytes(input.archives[ci]!, true);
		const po = Buffer.from(
			'\uFEFFmsgid ""\r\nmsgstr ""\r\n\r\n' +
				input.pos[ci]!.map((entry, index) => localizationScaleEntry(index, entry).po).join(
					""
				)
		);
		if (persisted) {
			await writeFile(join(projectRoot, `${culture}.archive`), archive);
			await writeFile(join(projectRoot, `${culture}.po`), po);
		} else {
			await importMemory(`${culture}.archive`, archive, "archive");
			await importMemory(`${culture}.po`, po, "po");
		}
		cultures.push({
			culture,
			archive: {
				status: "read",
				provenance: provenance(`${culture}.archive`, archive),
				value: success(parseArchive(archive))
			},
			po: {
				status: "read",
				provenance: provenance(`${culture}.po`, po),
				value: projectPOEvidence(success(parsePO(po)))
			}
		});
	}
	const evidence: LocalizationTargetEvidence = {
		...emptyEvidence(),
		target: authored,
		manifest: {
			status: "read",
			provenance: provenance("Fuzz.manifest", manifest),
			value: success(parseManifest(manifest))
		},
		cultures
	};
	const inventory = input.records
		.map((record) => ({
			path: record.path,
			signature: "fuzz",
			headerData: {
				packageFlags: input.excluded.includes(record.path) ? 0 : 0x00040000,
				gatherableTextDataCount: 0,
				gatherableTextDataOffset: 0,
				hasTextProperty: false
			}
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const records = [...input.records].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0
	);
	const corpus = candidateCorpusFromEvents({ projectRoot, inventory, events: records });
	const raw = applyLocalizationReview(joinLocalizationTarget(corpus, evidence), input.review);
	const expected = applyLocalizationKeyChanges(raw, localizationKeyChanges(raw, corpus).pairs);
	const oracle = textCorpusQuery(corpus, undefined, expected);
	const base: TextCorpusSearchRequest = {
		query: "",
		capability: "all",
		pageSize: 50,
		localization: { target: expected.target },
		facets: { folder: "", assets: true, origins: true, cultures: true }
	};
	const { localization: _selection, ...unlocalized } = base;
	const { facets: _facets, ...withoutFacets } = base;
	const translationQuery = ["translated", "po", "Alpha", "\ud800", "\udfff", "\u0000"][
		input.seed % 6
	]!;
	const requests: TextCorpusSearchRequest[] = [
		...(
			[
				"é",
				"i\u0307",
				"ı",
				"\ud800",
				"\udfff",
				"😀",
				"Alpha first",
				"Alpha Alpha",
				"not-a-source",
				" \u2028 "
			] as const
		).flatMap((query) => [
			{ ...withoutFacets, query },
			{ ...unlocalized, query }
		]),
		withoutFacets,
		base,
		unlocalized,
		{
			...unlocalized,
			filter: [{ field: "namespace", op: "is", values: ["UI"] }]
		},
		{ ...base, pageSize: 2 },
		{ ...base, capability: "read_only" },
		{ ...base, capability: "source_editable" },
		{ ...base, withoutNotes: true },
		{
			...base,
			query: translationQuery,
			localization: {
				target: expected.target,
				culture: authored.cultures[0]!,
				searchTranslations: true
			}
		},
		{
			...base,
			query: translationQuery,
			localization: {
				target: expected.target,
				cultures: authored.cultures,
				searchTranslations: true
			}
		},
		{
			...base,
			localization: {
				target: expected.target,
				state: localizationStates[input.seed % localizationStates.length]!
			}
		},
		{ ...base, where: { pathPrefix: "Content/Text" } },
		{ ...base, where: { files: [input.records[0]!.path] } },
		...(["shared", "duplicate_source", "long", "unresolved", "conflicting"] as const).map(
			(lens) => ({ ...base, lens })
		),
		...input.cultures.map((culture) => ({
			...base,
			localization: {
				target: expected.target,
				cultures: [authored.cultures.find((value) => value === culture)!]
			}
		})),
		...["Alpha", "first", "\u2028", "translated", "\ud800", "\udfff", "\u0000"].map(
			(query) => ({ ...base, query })
		),
		...(["folder", "asset", "origin", "problem", "namespace"] as const).map((group) => ({
			...base,
			group
		}))
	];
	const filters = [
		{
			field: "problem",
			op: "is",
			values: [TextProblem.literals[input.seed % TextProblem.literals.length]!]
		},
		{ field: "finding", op: "is", values: ["shared"] },
		{ field: "translation", op: "is", values: ["missing", "not_synced"] },
		{ field: "origin", op: "is", values: ["asset"] },
		{ field: "folder", op: "is", values: ["Content/Text"] },
		{ field: "asset", op: "is", values: [input.records[0]!.path] },
		{ field: "namespace", op: "is", values: ["UI"] },
		{ field: "editing", op: "is", values: ["editable"] },
		{ field: "notes", op: "is_not", values: ["present"] }
	];
	for (let offset = 0; offset < 3; offset++)
		requests.push(
			Schema.decodeUnknownSync(TextCorpusSearchRequest)({
				...base,
				filter: [filters[(input.seed + offset) % filters.length]]
			})
		);
	const firstPage = oracle.search({ ...base, pageSize: 2 });
	if (firstPage.localization?.nextCursor)
		requests.push({
			...base,
			pageSize: 2,
			localizationCursor: firstPage.localization.nextCursor
		});
	const group = (["asset", "folder", "namespace", "origin", "problem"] as const)[input.seed % 5]!;
	const grouped = oracle.search({ ...base, group });
	if (grouped.groups?.entries[0])
		requests.push({
			...base,
			group: grouped.groups.by,
			openGroup: grouped.groups.entries[0].key
		});
	// Page both projections and revisit warmed requests after other scopes. The event oracle
	// supplies cursors, so these comparisons also cover display order and cache-key isolation.
	for (const selection of [base, unlocalized]) {
		const grouping = (
			["asset", "folder", "namespace", "origin", "problem", "audience"] as const
		)[input.seed % 6]!;
		const groups = oracle.search({ ...selection, group: grouping }).groups;
		for (const openGroup of [undefined, groups?.entries[0]?.key, "missing-test-group"]) {
			const pageRequest = {
				...selection,
				pageSize: 1,
				group: grouping
			};
			const firstRequest =
				openGroup === undefined ? pageRequest : { ...pageRequest, openGroup };
			const page = oracle.search(firstRequest);
			requests.push(firstRequest);
			if (page.localization?.nextCursor)
				requests.push({
					...firstRequest,
					pageSize: 2,
					localizationCursor: page.localization.nextCursor
				});
			else if (page.nextCursor)
				requests.push({
					...firstRequest,
					pageSize: 2,
					cursor: page.nextCursor
				});
			requests.push(firstRequest);
		}
	}
	requests.push({
		...base,
		localization: {
			target: expected.target,
			review: "not_reviewed",
			keyChanged: input.seed % 2 === 0
		}
	});
	if (persisted) await importJoinEvidence(projectRoot, cache, evidence);
	await run(
		refreshPackageTextLayer({
			inventory,
			read: (paths) =>
				Stream.fromIterable(records.filter((record) => paths.includes(record.path)))
		})
	);
	const joinedInput = { projectRoot, target: authored };
	if (input.review) Object.assign(joinedInput, { review: input.review });
	if (buildJoined) {
		await buildJoined(
			{ projectKey: projectRoot, cacheRoot: cache, targetKey: "Fuzz" },
			joinedInput
		);
	} else await run(refreshJoinedTarget(joinedInput));
	if (seedDictionary)
		await run(
			Effect.gen(function* () {
				const reader = yield* (yield* SharedIndex).open();
				const values = yield* reader.strings([0, 1]);
				if (values[0] !== "K0" || values[1] !== "")
					throw new Error("Shifted dictionary IDs changed during join preparation");
			})
		);
	const actual = await run(
		Effect.gen(function* () {
			const joined = yield* openJoinedTarget();
			yield* inspectJoinedTarget(joined);
			const query = new JoinedQueryData(joined);
			const candidate = columnarTextCorpusQuery(joined);
			const rawPresentations = Array.from(query.column("query.raw.order"))
				.filter((row) => query.column("query.raw.visible")[row])
				.map((row) => query.presentation("raw", row));
			const slicePresentations = Array.from(
				{ length: query.column("query.slice.raw").length },
				(_, row) => ({
					line: query.column("query.slice.line")[row]!,
					visible: query.column("query.slice.visible")[row]!,
					unit: query.presentation("slice", row)
				})
			);
			return {
				query: {
					summary: candidate.summary(),
					statusReport: indexedLocalizationStatusReport(
						joined,
						evidence,
						candidate.search(base)
					),
					exports: [candidate.export(base), candidate.export(unlocalized)],
					lines: candidate.localizationLines(base),
					searches: requests.map((request) => candidate.search(request)),
					rawFocus: rawPresentations.map((unit) =>
						candidate.focus({ id: unit.id, pageSize: 2 })
					),
					focus: expected.lines.map((line) => ({
						line: candidate.localizationFocus(line.id),
						units:
							line.origin.kind === "corpus"
								? line.origin.unitIds.map((id) =>
										candidate.focus({
											id,
											pageSize: 2,
											localization: { target: expected.target, id: line.id }
										})
									)
								: []
					}))
				},
				rawPresentations,
				slicePresentations,
				join: yield* hydrateJoinedTarget(joined, 0, 10000),
				corpus: yield* textCorpusFromPackageTextLayer(projectRoot),
				problems: yield* u32(joined.layer, "line.problems"),
				origins: yield* u32(joined.layer, "line.origins"),
				editing: yield* u32(joined.layer, "line.editing"),
				notes: yield* u32(joined.layer, "line.notes")
			};
		})
	);
	const differences: FuzzDifference[] = [];
	const comparison = compareLocalizationJoins(expected, actual.join, 100);
	for (const difference of comparison.differences)
		differences.push({ field: `join.${difference.field}`, detail: JSON.stringify(difference) });
	const hydrated = textCorpusQuery(actual.corpus, undefined, {
		...actual.join,
		lines: [...actual.join.lines].sort((a, b) => a.id.localeCompare(b.id))
	});
	const compare = (field: string, left: OracleValue, right: OracleValue) => {
		if (
			/\.(facts|unknownReasons|flags)$/u.test(field) &&
			Array.isArray(left) &&
			Array.isArray(right)
		) {
			left = [...left].sort();
			right = [...right].sort();
		}
		if (isDeepStrictEqual(left, right)) return;
		if (Array.isArray(left) && Array.isArray(right)) {
			for (let row = 0; row < Math.max(left.length, right.length); row++)
				compare(`${field}.${row}`, left[row], right[row]);
			return;
		}
		if (isOracleRecord(left) && isOracleRecord(right)) {
			const a = Object.fromEntries(Object.entries(left)),
				b = Object.fromEntries(Object.entries(right));
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
				compare(`${field}.${key}`, a[key], b[key]);
			return;
		}
		differences.push({ field, detail: JSON.stringify({ expected: left, actual: right }) });
	};
	compare("query.summary", oracle.summary(), hydrated.summary());
	compare("column-query.summary", oracle.summary(), actual.query.summary);
	compare(
		"column-query.statusReport",
		Schema.decodeUnknownSync(Schema.Json)(
			JSON.parse(
				JSON.stringify(localizationStatusReport(corpus, evidence, oracle.search(base)))
			)
		),
		Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(actual.query.statusReport)))
	);
	compare("column-query.export.localized", oracle.export(base), actual.query.exports[0]);
	compare("column-query.export.raw", oracle.export(unlocalized), actual.query.exports[1]);
	compare("column-query.localizationLines", oracle.localizationLines(base), actual.query.lines);
	for (const [row, unit] of actual.rawPresentations.entries())
		compare(
			"column-query.rawFocus",
			oracle.focus({ id: unit.id, pageSize: 2 }),
			actual.query.rawFocus[row]
		);
	compare(
		"query.columns.raw",
		oracle.search({ query: "", capability: "all", pageSize: 1000 }).units,
		actual.rawPresentations
	);
	for (const slice of actual.slicePresentations) {
		if (!slice.visible) continue;
		const line = actual.join.lines[slice.line]!;
		compare(
			"query.columns.slice",
			oracle.focus({
				id: slice.unit.id,
				pageSize: 2,
				localization: { target: expected.target, id: line.id }
			})?.unit,
			slice.unit
		);
	}
	const nativeFocus: import("../packages/game-text/src/schema.ts").TextCorpusFocusRequest[] = [
		...actual.rawPresentations.map((unit) => ({ id: unit.id, pageSize: 2 })),
		...expected.lines.flatMap((line) =>
			line.origin.kind === "corpus"
				? line.origin.unitIds.map((id) => ({
						id,
						pageSize: 2,
						localization: { target: expected.target, id: line.id }
					}))
				: []
		)
	];
	for (const request of nativeFocus.slice()) {
		const cursor = oracle.focus(request)?.nextOccurrenceCursor;
		if (cursor) nativeFocus.push({ ...request, occurrenceCursor: cursor });
	}
	const nativeDetails = expected.lines.map((line) => ({
		target: expected.target,
		selection: { kind: "line" as const, id: line.id }
	}));
	const nativeResults = nativeSearch
		? await nativeSearch(
				{ projectKey: projectRoot, cacheRoot: cache, targetKey: "Fuzz" },
				requests,
				expected.lines.map((line) => line.id),
				nativeFocus,
				[base, unlocalized],
				nativeDetails
			)
		: undefined;
	if (nativeResults) {
		compare(
			"native-engine.corpus_lines",
			[...expected.lines].sort((a, b) => a.id.localeCompare(b.id)),
			[...nativeResults.corpusLines].sort((a, b) => a.id.localeCompare(b.id))
		);
		for (const [index, request] of nativeDetails.entries())
			compare(
				"native-engine.detail",
				oracle.localizationDetail(request),
				nativeResults.details[index]
			);
		compare("native-engine.summary", oracle.summary(), nativeResults.summary);
		compare("native-engine.export.localized", oracle.export(base), nativeResults.exports[0]);
		compare("native-engine.export.raw", oracle.export(unlocalized), nativeResults.exports[1]);
		for (const [index, request] of nativeFocus.entries())
			compare(
				"native-engine.focus",
				oracle.focus(request) ?? null,
				nativeResults.focus[index]
			);
		for (const [index, line] of expected.lines.entries())
			compare(
				"native-engine.line",
				oracle.localizationFocus(line.id),
				nativeResults.lines[index]
			);
	}
	for (const [index, request] of requests.entries()) {
		if (nativeResults)
			compare(
				`native-engine.search.${index}`,
				oracle.search(request),
				nativeResults.searches[index]
			);
		compare(`query.search.${index}`, oracle.search(request), hydrated.search(request));
		compare(
			`column-query.search.${index}`,
			oracle.search(request),
			actual.query.searches[index]
		);
	}
	for (const [lineIndex, line] of expected.lines.entries()) {
		compare(
			"query.localizationFocus",
			oracle.localizationFocus(line.id),
			hydrated.localizationFocus(line.id)
		);
		compare(
			"column-query.localizationFocus",
			oracle.localizationFocus(line.id),
			actual.query.focus[lineIndex]!.line
		);
		if (line.origin.kind === "corpus")
			for (const [unitIndex, id] of line.origin.unitIds.entries()) {
				const request = {
					id,
					pageSize: 2,
					localization: { target: expected.target, id: line.id }
				};
				compare("query.focus", oracle.focus(request), hydrated.focus(request));
				compare(
					"column-query.focus",
					oracle.focus(request),
					actual.query.focus[lineIndex]!.units[unitIndex]
				);
			}
	}
	for (let bit = 0; bit < TextProblem.literals.length; bit++) {
		const problem = TextProblem.literals[bit]!;
		const ids = new Set(
			oracle
				.localizationLines({
					...base,
					filter: [{ field: "problem", op: "is", values: [problem] }]
				})
				.map((line) => line.id)
		);
		for (let row = 0; row < actual.join.lines.length; row++) {
			const line = actual.join.lines[row]!;
			if (line.source.trim() !== "")
				compare(
					`column.problem.${problem}`,
					ids.has(line.id),
					Boolean(actual.problems[row]! & (1 << bit))
				);
		}
	}
	// Facet membership is line scoped, including saved units split into several gathered lines.
	for (const [field, values] of [
		["origin", ["string_table", "data_table", "asset", "cpp", "other_source"]],
		["editing", ["editable", "read_only"]],
		["notes", ["present", "missing"]]
	] as const)
		for (let bit = 0; bit < values.length; bit++) {
			const value = values[bit]!;
			const request = Schema.decodeUnknownSync(TextCorpusSearchRequest)({
				...base,
				filter: [{ field, op: "is", values: [value] }]
			});
			const ids = new Set(oracle.localizationLines(request).map((line) => line.id));
			for (let row = 0; row < actual.join.lines.length; row++) {
				const line = actual.join.lines[row]!;
				if (line.source.trim() === "") continue;
				const matches =
					field === "notes"
						? Boolean(actual.notes[row]) === (value === "present")
						: Boolean(
								(field === "origin" ? actual.origins : actual.editing)[row]! &
								(1 << bit)
							);
				compare(`column.facet.${field}.${value}`, ids.has(line.id), matches);
			}
		}
	return differences;
}

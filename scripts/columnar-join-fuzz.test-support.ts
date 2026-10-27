import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { refreshPackageTextLayer } from "../packages/game-text/src/package-text-layer.ts";
import { refreshJoinedTarget } from "../packages/game-text/src/joined-target-reference.test-support.ts";
import {
	openJoinedTarget,
	inspectJoinedTarget
} from "../packages/game-text/src/joined-target-reader.ts";
import { hydrateJoinedTarget } from "../packages/game-text/src/joined-target-hydrate.test-support.ts";
import {
	joinLocalizationTarget,
	applyLocalizationKeyChanges,
	localizationKeyChanges,
	applyLocalizationReview
} from "../packages/game-text/src/entry-corpus.ts";
import type {
	TextCorpusSearchRequest,
	TextCorpusSearchPage
} from "../packages/game-text/src/schema.ts";
import {
	localizationStates,
	LocalizationUnknownReason,
	type LocalizationCultureState,
	type LocalizationLine
} from "../packages/game-text/src/localization-schema.ts";
import type { LocalizationLineView } from "../packages/game-text/src/index-reads.ts";
import { localizationShippedTranslation } from "../packages/game-text/src/localization-shipped-translation.ts";
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

/** Main asset classes the fuzz's packages take in turn; the last package of each six has none. */
const FUZZ_ASSET_CLASSES = [
	"/Script/Engine.DataTable",
	"/Script/Engine.Blueprint",
	"/Script/UMGEditor.WidgetBlueprint",
	"/Script/Engine.World",
	"/Game/Text/BP_Item.BP_Item_C",
	undefined
] as const;

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
		// By row, so the random stream and every seed's other inputs stay as they were.
		...(FUZZ_ASSET_CLASSES[row % FUZZ_ASSET_CLASSES.length] === undefined
			? undefined
			: { assetClass: FUZZ_ASSET_CLASSES[row % FUZZ_ASSET_CLASSES.length]! }),
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

/**
 * A seed's input with nothing for the join to pair: every manifest line is a resolved occurrence's
 * identity and source, and the archives and POs hold only those lines. The native join can then
 * patch an in-place edit rather than rebuild.
 */
export function pairlessJoinFuzzInput(seed: number): JoinFuzzInput {
	const seeded = joinFuzzInput(seed);
	// Only resolved, keyed occurrences in gathered, complete packages, which the manifest lists;
	// Unreal can't load localization files holding a lone surrogate.
	const input = {
		...seeded,
		records: seeded.records.map((record) => ({
			...record,
			occurrences: record.occurrences.filter(
				(occurrence) =>
					!seeded.excluded.includes(record.path) &&
					!record.path.includes("/L10N/") &&
					record.status === "complete" &&
					occurrence.identity.status === "resolved" &&
					occurrence.identity.key &&
					!occurrence.identity.namespace.includes("[") &&
					occurrence.source.isWellFormed()
			)
		}))
	};
	const lines = new Map<string, Entry>();
	for (const record of input.records)
		for (const occurrence of record.occurrences)
			if (occurrence.identity.status === "resolved") {
				const { namespace, key } = occurrence.identity;
				const id = JSON.stringify([namespace, key]);
				if (!lines.has(id))
					lines.set(id, {
						namespace,
						key,
						source: occurrence.source,
						notes: "",
						path: `/Game/${record.path.slice(8, -7)}.Object.Label0`
					});
			}
	const manifest = [...lines.values()];
	const known = (entry: { readonly namespace: string; readonly key: string }) =>
		lines.get(JSON.stringify([entry.namespace, entry.key]));
	const { review: _review, ...rest } = input;
	return {
		...rest,
		manifest,
		archives: input.archives.map((entries) =>
			entries.flatMap((entry) => {
				const line = known(entry);
				return line ? [{ ...entry, source: line.source }] : [];
			})
		),
		pos: input.pos.map((entries) =>
			entries.flatMap((entry) => {
				const line = known(entry);
				return line ? [{ ...entry, source: line.source, path: line.path }] : [];
			})
		)
	};
}

/**
 * The input after an in-place edit: some occurrences' sources change, to a new text or to another
 * occurrence's, and each culture's PO changes one translation. Identities, counts and paths stay,
 * so the native join can patch its lines rather than rebuild.
 */
export function editJoinFuzzInput(input: JoinFuzzInput): JoinFuzzInput {
	let state = (input.seed ^ 0x5bd1e995) >>> 0;
	const random = () => {
		state += 0x6d2b79f5;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
	const int = (limit: number) => Math.floor(random() * limit);
	const sources = input.records.flatMap((record) =>
		record.occurrences.map((occurrence) => occurrence.source)
	);
	const edits = 1 + int(3);
	const records = input.records.map((record) => ({
		...record,
		occurrences: record.occurrences.map((occurrence) => ({ ...occurrence }))
	}));
	const occurrences = records.flatMap((record) => record.occurrences);
	for (let edit = 0; edit < edits && occurrences.length > 0; edit++) {
		const occurrence = occurrences[int(occurrences.length)]!;
		occurrence.source = int(2) ? `${occurrence.source} edited` : sources[int(sources.length)]!;
	}
	const pos = input.pos.map((entries) => {
		const at = int(entries.length + 1);
		return entries.map((entry, index) =>
			index === at ? { ...entry, translation: `${entry.translation} edited` } : entry
		);
	});
	return { ...input, records, pos };
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

/** What the engine reads back: every stored line, and one request's lines with marks and its page. */
export interface NativeLineFacts {
	readonly lines: readonly LocalizationLine[];
	readonly exported: readonly LocalizationLineView<"identity" | "source" | "marks">[];
	readonly page: TextCorpusSearchPage;
}

/**
 * Actual persisted layers against the join planted from the original events: every join field,
 * and with `nativeLines` the engine's line facts and the culture counts that tally them.
 */
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
	nativeLines?: (
		configuration: ReturnType<
			typeof import("./columnar-join.test-support.ts").joinStoreOptions
		>,
		request: TextCorpusSearchRequest
	) => Promise<NativeLineFacts>,
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
			// The content's, so an edited record reads as a changed package.
			signature: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
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
	const raw = applyLocalizationReview(
		joinLocalizationTarget(corpus, evidence, evidence.target, {
			completePackageInventory: true
		}),
		input.review
	);
	const expected = applyLocalizationKeyChanges(raw, localizationKeyChanges(raw, corpus).pairs);
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
			return yield* hydrateJoinedTarget(joined, 0, 10000);
		})
	);
	const differences: FuzzDifference[] = [];
	const comparison = compareLocalizationJoins(expected, actual, 100);
	for (const difference of comparison.differences)
		differences.push({ field: `join.${difference.field}`, detail: JSON.stringify(difference) });
	if (!nativeLines) return differences;
	const compare = (field: string, left: OracleValue, right: OracleValue, line: string) => {
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
				compare(`${field}.${row}`, left[row], right[row], line);
			return;
		}
		if (isOracleRecord(left) && isOracleRecord(right)) {
			const a = Object.fromEntries(Object.entries(left)),
				b = Object.fromEntries(Object.entries(right));
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
				compare(`${field}.${key}`, a[key], b[key], line);
			return;
		}
		differences.push({
			field,
			detail: JSON.stringify({ line, expected: left, actual: right })
		});
	};
	// Cultures by name, so a difference names its culture rather than its position.
	const byCulture = <C extends { readonly culture: string }>(cultures: readonly C[]) =>
		Object.fromEntries(cultures.map((culture) => [culture.culture, culture]));
	const request: TextCorpusSearchRequest = {
		query: "",
		capability: "all",
		pageSize: 1,
		localization: { target: expected.target }
	};
	const facts = await nativeLines(
		{ projectKey: projectRoot, cacheRoot: cache, targetKey: "Fuzz" },
		request
	);
	const planted = new Map(expected.lines.map((line) => [line.id, line]));
	const stored = new Map(facts.lines.map((line) => [line.id, line]));
	for (const id of planted.keys())
		if (!stored.has(id)) differences.push({ field: "native-engine.lines.missing", detail: id });
	for (const id of stored.keys())
		if (!planted.has(id)) differences.push({ field: "native-engine.lines.extra", detail: id });
	for (const [id, line] of planted) {
		const read = stored.get(id);
		if (read)
			compare(
				"native-engine.line",
				{ ...line, cultures: byCulture(line.cultures) },
				{ ...read, cultures: byCulture(read.cultures) },
				id
			);
	}
	// The export's marks carry the translation that ships instead of the archive and PO entries.
	const mark = (culture: LocalizationCultureState) => {
		const { archive: _archive, po: _po, poTranslation: _poTranslation, ...shown } = culture;
		return { ...shown, translation: localizationShippedTranslation(culture).value };
	};
	const tallies = new Map(
		expected.cultures.map((culture) => [
			culture,
			{
				states: Object.fromEntries(localizationStates.map((state) => [state, 0])),
				unknownReasons: Object.fromEntries(
					LocalizationUnknownReason.literals.map((reason) => [reason, 0])
				),
				reducedSourceChecking: 0
			}
		])
	);
	let notSynced = 0;
	for (const view of facts.exported) {
		const line = planted.get(view.id);
		if (!line) {
			differences.push({ field: "native-engine.export.extra", detail: view.id });
			continue;
		}
		compare("native-engine.export.identity", line.identity, view.identity, view.id);
		compare("native-engine.export.source", line.source, view.source, view.id);
		compare(
			"native-engine.export.marks",
			byCulture(line.cultures.map(mark)),
			byCulture(view.marks),
			view.id
		);
		for (const culture of line.cultures) {
			const tally = tallies.get(culture.culture);
			if (!tally) continue;
			tally.states[culture.state]!++;
			for (const reason of culture.unknownReasons) tally.unknownReasons[reason]!++;
			if (culture.reducedSourceChecking) tally.reducedSourceChecking++;
			if (culture.facts.includes("not_synced")) notSynced++;
		}
	}
	// The request's culture counts are tallies of its lines' marks.
	const page = facts.page.localization;
	compare(
		"native-engine.counts",
		Object.fromEntries(tallies),
		Object.fromEntries(
			(page?.counts ?? []).map((counts) => [
				counts.culture,
				{
					states: Object.fromEntries(
						Object.entries(counts.states).map(([state, value]) => [state, value.lines])
					),
					unknownReasons: counts.unknownReasons,
					reducedSourceChecking: counts.reducedSourceChecking
				}
			])
		),
		"*"
	);
	compare("native-engine.counts.notSynced", notSynced, page?.notSynced, "*");
	return differences;
}

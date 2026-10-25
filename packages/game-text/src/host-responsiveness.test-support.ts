import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Layer, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget
} from "@ue-shed/localization";
import {
	makeAssetReaderTestLayer,
	makeProjectIndexTestLayer,
	ProjectIdentity,
	ProjectIndexCursor,
	ProjectIndexGeneration,
	type SavedAssetPackageTextRecord
} from "@ue-shed/unreal-assets";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target } from "./localization.test-support.js";
import { gameTextIndexRefreshLayer } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { GameTextIndexBuilderLive } from "./native-index-builder.js";

/** A synthetic project shaped like a large server-hosted scan: most inventory rows are packages
 * without text, a minority carry many occurrences, and a two-culture target localizes them.
 */
export interface SyntheticHostProject {
	readonly inventory: number;
	readonly textPackages: number;
	readonly occurrencesPerPackage: number;
	readonly keys: number;
}

const textHeader = {
	packageFlags: 0x00040000,
	gatherableTextDataCount: 1,
	gatherableTextDataOffset: 1,
	hasTextProperty: true
};
const plainHeader = {
	packageFlags: 0,
	gatherableTextDataCount: 0,
	gatherableTextDataOffset: 0,
	hasTextProperty: false
};
// Packages and sidecars are absent on disk, which is what the signature records.
const signature = JSON.stringify([null, null, null, null]);
const source = (key: number) => `Velora nimblet oriven ${key} taluma`;

/** The production host stack over in-memory Project Index and reader adapters. */
export const makeSyntheticHostFixture = Effect.fn("Test.GameText.hostFixture")(function* (
	project: SyntheticHostProject
) {
	const directory = yield* Effect.acquireRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-host-responsiveness-"))),
		(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
	);
	const projectRoot = yield* Effect.promise(() => realpath(directory));
	const authored = Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		name: "Synthetic",
		outputPaths: {
			...target.outputPaths,
			manifest: "Synthetic.manifest",
			archives: { en: "en.archive", de: "de.archive" },
			portableObjects: { en: "en.po", de: "de.po" }
		}
	});
	const keys = Array.from({ length: project.keys }, (_, key) => key);
	yield* Effect.promise(async () => {
		await writeFile(
			join(projectRoot, "Synthetic.manifest"),
			JSON.stringify({
				FormatVersion: 1,
				Namespace: "UI",
				Children: keys.map((key) => ({
					Source: { Text: source(key) },
					Keys: [{ Key: `K${key}`, Path: `/Game/Text/Package${key}.Package${key}.Label` }]
				}))
			})
		);
		for (const culture of authored.cultures) {
			await writeFile(
				join(projectRoot, `${culture}.archive`),
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "UI",
					Children: keys.map((key) => ({
						Key: `K${key}`,
						Source: { Text: source(key) },
						Translation: { Text: `${culture} ${source(key)}` }
					}))
				})
			);
			await writeFile(
				join(projectRoot, `${culture}.po`),
				keys
					.map(
						(key) =>
							`msgctxt "UI,K${key}"\nmsgid "${source(key)}"\nmsgstr "${culture} ${source(key)}"\n`
					)
					.join("\n")
			);
		}
	});
	const records = new Map<string, SavedAssetPackageTextRecord>();
	const inventory: {
		kind: "inventory";
		packagePath: string;
		signature: string;
		headerData: typeof textHeader;
	}[] = [];
	for (let pkg = 0; pkg < project.textPackages; pkg++) {
		const path = `Content/Text/Package${pkg}.uasset`;
		records.set(path, {
			...emptyPackageTextRecord(path),
			occurrences: Array.from({ length: project.occurrencesPerPackage }, (_, row) => {
				const key = (pkg * project.occurrencesPerPackage + row) % project.keys;
				return {
					source: source(key),
					dev_notes: "",
					identity: { status: "resolved" as const, namespace: "UI", key: `K${key}` },
					location: {
						kind: "asset_property" as const,
						object_path: `/Game/Text/Package${pkg}.Package${pkg}`,
						class_path: "/Script/Engine.DataAsset",
						property_path: `Label${row}`
					},
					edit_capability: "read_only" as const
				};
			})
		});
		inventory.push({ kind: "inventory", packagePath: path, signature, headerData: textHeader });
	}
	for (let row = inventory.length; row < project.inventory; row++)
		inventory.push({
			kind: "inventory",
			packagePath: `Content/Props/Batch${Math.floor(row / 1000)}/Prop${row}.uasset`,
			signature,
			headerData: plainHeader
		});
	const summary = {
		projectId: ProjectIdentity.make(projectRoot),
		generation: ProjectIndexGeneration.make(1),
		packageCount: inventory.length,
		mapCount: 0,
		changedPackages: inventory.length,
		removedPackages: 0,
		completeness: "complete" as const,
		diagnostics: []
	};
	const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
	// Each page is a process round trip in production, so it resolves on a later macrotask.
	const projectIndex = makeProjectIndexTestLayer({
		rebuild: () => Stream.die("The fixture uses a committed Project Index."),
		refresh: () => Stream.die("The fixture uses a committed Project Index."),
		status: () => Effect.succeed({ status: "ready" as const, summary }),
		query: (request) =>
			Effect.promise(nextMacrotask).pipe(
				Effect.as({
					projectId: summary.projectId,
					generation: summary.generation,
					items: inventory.slice(
						Number(request.cursor ?? 0),
						Number(request.cursor ?? 0) + request.limit
					),
					...(Number(request.cursor ?? 0) + request.limit < inventory.length
						? {
								nextCursor: ProjectIndexCursor.make(
									String(Number(request.cursor ?? 0) + request.limit)
								)
							}
						: undefined)
				})
			)
	});
	// Reader records arrive in pipe-sized groups on separate macrotasks.
	const reader = makeAssetReaderTestLayer({
		configuration: () =>
			Effect.succeed({
				executable: process.env.UE_SHED_UASSET_EXECUTABLE ?? "uasset",
				timeoutMs: 30_000,
				catalogTimeoutMs: 50 * 60_000
			}),
		catalogProgress: () =>
			Effect.succeed({
				phase: "idle",
				cacheHits: 0,
				processedAssets: 0,
				tablesFound: 0,
				totalAssets: 0
			}),
		scanProgress: () =>
			Effect.succeed({
				phase: "idle",
				cacheHits: 0,
				emittedAssets: 0,
				processedAssets: 0,
				totalAssets: 0
			}),
		savedWorldProgress: () =>
			Effect.succeed({
				phase: "idle",
				actorsFound: 0,
				processedPackages: 0,
				totalPackages: 0
			}),
		readBlueprint: () =>
			Effect.die(new Error("Unexpected readBlueprint in this reader fixture")),
		readLevelSequence: () =>
			Effect.die(new Error("Unexpected readLevelSequence in this reader fixture")),
		readSavedWorld: () =>
			Effect.die(new Error("Unexpected readSavedWorld in this reader fixture")),
		extractProjectText: () =>
			Stream.die(new Error("Unexpected extractProjectText in this reader fixture")),
		extractProjectTextures: () =>
			Stream.die(new Error("Unexpected extractProjectTextures in this reader fixture")),
		discoverAssets: () => Effect.die("unused"),
		discoverTables: () => Effect.die("unused"),
		readAsset: () => Effect.die("unused"),
		readTable: () => Effect.die("unused"),
		source: () => Effect.succeed("configured"),
		scanProject: () => Effect.die("The fixture never enumerates packages."),
		extractProjectTextPackages: (request) =>
			Stream.fromAsyncIterable(
				(async function* () {
					let count = 0;
					for (const path of request.paths ?? []) {
						const record = records.get(path);
						if (!record) throw new Error(`Synthetic package ${path} is absent.`);
						yield record;
						if (++count % 16 === 0) await nextMacrotask();
					}
				})(),
				(cause) => {
					throw cause;
				}
			)
	});
	const evidence = Layer.effect(
		LocalizationEvidence,
		Effect.gen(function* () {
			const live = yield* LocalizationEvidence;
			return LocalizationEvidence.of({
				...live,
				discover: () =>
					Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] })
			});
		})
	).pipe(Layer.provide(LocalizationEvidenceNodeLive));
	const cacheRoot = join(projectRoot, "cache");
	const layer = gameTextIndexRefreshLayer(cacheRoot).pipe(
		Layer.provide(
			gameTextIndexSourceNodeLayer(cacheRoot, { refreshProjectIndex: false }).pipe(
				Layer.provide(Layer.merge(projectIndex, reader))
			)
		),
		Layer.provide(GameTextIndexBuilderLive.pipe(Layer.provide(reader))),
		Layer.provide(evidence)
	);
	return {
		layer,
		request: { projectRoot, targetName: authored.name },
		textPackages: project.textPackages,
		occurrences: project.textPackages * project.occurrencesPerPackage
	};
});

/** Runs an effect while a fixed-interval timer records the longest event-loop gap. */
export const withEventLoopGaps = <A, E, R>(effect: Effect.Effect<A, E, R>, intervalMs = 20) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const state = { last: performance.now(), maxGapMs: 0 };
			const timer = setInterval(() => {
				const now = performance.now();
				state.maxGapMs = Math.max(state.maxGapMs, now - state.last);
				state.last = now;
			}, intervalMs);
			return { state, timer };
		}),
		({ state }) =>
			effect.pipe(
				Effect.map((value) => ({
					value,
					// The stretch since the last tick also counts when the effect ends.
					maxGapMs: Math.max(state.maxGapMs, performance.now() - state.last)
				}))
			),
		({ timer }) => Effect.sync(() => clearInterval(timer))
	);

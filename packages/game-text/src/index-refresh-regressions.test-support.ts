import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget
} from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target } from "./localization.test-support.js";
import { GameTextIndexSource, gameTextIndexRefreshLayer } from "./index-refresh.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";

import { LocalizationImportSource } from "./localization-import.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { textCorpusFromExtractionEvents } from "./corpus.js";

export const makeIndexRegressionFixture = Effect.fn("Test.GameText.indexFixture")(function* (
	parentDirectory = tmpdir()
) {
	const directory = yield* Effect.acquireRelease(
		Effect.promise(() => mkdtemp(join(parentDirectory, "ue-shed-index-regressions-"))),
		(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
	);
	const projectRoot = yield* Effect.promise(() => realpath(directory));
	const authored = Schema.decodeUnknownSync(LocalizationTarget)({
		...target,
		name: "Review",
		outputPaths: {
			...target.outputPaths,
			manifest: "Review.manifest",
			archives: { en: "en.archive", de: "de.archive" },
			portableObjects: { en: "en.po", de: "de.po" }
		}
	});
	const contents = {
		manifest: JSON.stringify({
			FormatVersion: 1,
			Namespace: "UI",
			Children: [
				{
					Source: { Text: "Source" },
					Keys: [{ Key: "K", Path: "/Game/Text/Table.Table.Label" }]
				}
			]
		}),
		archive: JSON.stringify({
			FormatVersion: 2,
			Namespace: "UI",
			Children: [{ Key: "K", Source: { Text: "Source" }, Translation: { Text: "Shipped" } }]
		}),
		po: 'msgctxt "UI,K"\nmsgid "Source"\nmsgstr "Shipped"\n'
	};
	yield* Effect.promise(async () => {
		await writeFile(join(projectRoot, "Review.manifest"), contents.manifest);
		for (const culture of authored.cultures) {
			await writeFile(join(projectRoot, `${culture}.archive`), contents.archive);
			await writeFile(join(projectRoot, `${culture}.po`), contents.po);
		}
	});
	const path = join(projectRoot, "Content/Text/Table.uasset");
	let record: SavedAssetPackageTextRecord = {
		...emptyPackageTextRecord(path),
		occurrences: [
			{
				source: "Source",
				dev_notes: "",
				identity: { status: "resolved", namespace: "UI", key: "K" },
				location: {
					kind: "asset_property",
					object_path: "/Game/Text/Table.Table",
					class_path: "/Script/Engine.DataAsset",
					property_path: "Label"
				},
				edit_capability: "read_only"
			}
		]
	};
	// Further packages beside the main one; reads return the requested packages.
	let others: SavedAssetPackageTextRecord[] = [];
	let signature = 0;
	let packageReads = 0;
	let inventories = 0;
	let readGate = Effect.void;
	let targets: readonly LocalizationTarget[] = [authored];
	const source = Layer.succeed(GameTextIndexSource, {
		inventory: () => {
			inventories++;
			return Effect.succeed(
				// Inventories list unique paths in byte order.
				[path, ...others.map((other) => other.path)]
					.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
					.map((file) => ({
						path: file,
						signature: String(signature),
						headerData: {
							packageFlags: 0x00040000,
							gatherableTextDataCount: 1,
							gatherableTextDataOffset: 1,
							hasTextProperty: true
						}
					}))
			);
		},
		read: (_root, entries) => {
			packageReads++;
			const wanted = new Set(entries.map((entry) => entry.path));
			return Stream.fromEffect(readGate).pipe(
				Stream.flatMap(() =>
					Stream.fromIterable([record, ...others].filter((item) => wanted.has(item.path)))
				)
			);
		}
	});
	const evidence = Layer.effect(
		LocalizationEvidence,
		Effect.gen(function* () {
			const live = yield* LocalizationEvidence;
			return LocalizationEvidence.of({
				...live,
				discover: () => Effect.succeed({ schemaVersion: 1, targets, diagnostics: [] })
			});
		})
	).pipe(Layer.provide(LocalizationEvidenceNodeLive));
	const layer = (
		_worker = false,
		suppliedSource = source,
		qualityWorker = false,
		implementation = typeScriptIndexBuilderLayer
	) => {
		// Use the real positioned-file adapter, with in-process parsing for these tiny fixtures.
		// Worker lifecycle and atomic cold staging have dedicated integration tests.
		const files = { ...LocalizationImportSource.defaultValue() };
		const fixtureBuilder = Layer.effect(
			GameTextIndexBuilder,
			Effect.map(GameTextIndexBuilder, (builder) =>
				GameTextIndexBuilder.of({
					...builder,
					importLocalizationTarget: (input) =>
						builder
							.importLocalizationTarget(input)
							.pipe(Effect.provideService(LocalizationImportSource, files))
				})
			)
		).pipe(Layer.provide(implementation));
		return gameTextIndexRefreshLayer(join(projectRoot, "cache"), {
			qualityWorker
		}).pipe(
			Layer.provide(suppliedSource),
			Layer.provide(fixtureBuilder),
			Layer.provide(implementation),
			Layer.provide(evidence)
		);
	};
	return {
		projectRoot,
		target: authored,
		contents,
		packageReads: () => packageReads,
		inventories: () => inventories,
		pauseReads: (gate: Effect.Effect<void>) => {
			readGate = gate;
		},
		evidence,
		source,
		layer,
		setTargets: (available: readonly LocalizationTarget[]) => {
			targets = available;
		},
		addTarget: (name: string) => {
			const next = Schema.decodeUnknownSync(LocalizationTarget)({ ...authored, name });
			targets = [...targets, next];
			return next;
		},
		request: { projectRoot, targetName: authored.name },
		raw: () =>
			textCorpusFromExtractionEvents({
				projectRoot,
				discoveredPackages: 1 + others.length,
				events: [record, ...others]
			}),
		/** Adds packages beside the main one, at project-relative paths. */
		addPackages: (
			records: readonly (Partial<Omit<SavedAssetPackageTextRecord, "path" | "event">> & {
				readonly path: string;
			})[]
		) => {
			others = [
				...others,
				...records.map(
					(item): SavedAssetPackageTextRecord => ({
						...emptyPackageTextRecord(join(projectRoot, item.path)),
						...item,
						path: join(projectRoot, item.path)
					})
				)
			];
			signature++;
		},
		setSource: (source: string) => {
			record = {
				...record,
				occurrences: record.occurrences.map((item) => ({ ...item, source }))
			};
			signature++;
		},
		/** Replaces record fields other than the path, such as its status and coverage gaps. */
		patchRecord: (patch: Partial<Omit<SavedAssetPackageTextRecord, "path">>) => {
			record = { ...record, ...patch };
			signature++;
		},
		update: (
			occurrences: SavedAssetPackageTextRecord["occurrences"],
			blueprintClasses?: SavedAssetPackageTextRecord["blueprintClasses"]
		) => {
			const { blueprintClasses: _previous, ...rest } = record;
			record = {
				...rest,
				occurrences,
				...(blueprintClasses === undefined ? undefined : { blueprintClasses })
			};
			signature++;
		}
	};
});

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { expect, it } from "vitest";
import {
	LocalizationEvidence,
	LocalizationTarget,
	defaultLocalizationReviewPath,
	localizationReviewFingerprint
} from "@ue-shed/localization";
import { emptyPackageTextRecord } from "./package-text-record.js";
import { target } from "./localization.test-support.js";
import { hydrateJoinedTarget } from "./joined-target-hydrate.test-support.js";
import { columnarTextCorpusQuery } from "./columnar-query.test-support.js";
import { TextCorpusSearchRequest } from "./schema.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { GameTextIndexBuilder } from "./index-builder.js";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import {
	GameTextIndexSource,
	GameTextIndexRefresh,
	gameTextIndexRefreshLayer
} from "./index-refresh.js";

it("retains readers across refresh steps updating selected inputs and review", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ue-shed-game-text-index-"));
	try {
		const projectRoot = await realpath(directory);
		const authored = Schema.decodeUnknownSync(LocalizationTarget)({
			...target,
			name: "Refresh",
			outputPaths: {
				...target.outputPaths,
				manifest: "Refresh.manifest",
				archives: { en: "en.archive", de: "de.archive" },
				portableObjects: { en: "en.po", de: "de.po" }
			}
		});
		const manifest = JSON.stringify({
			FormatVersion: 1,
			Namespace: "UI",
			Children: [
				{
					Source: { Text: "Source" },
					Keys: [{ Key: "K", Path: "/Game/Text/Table.Table.Label" }]
				}
			]
		});
		const archive = JSON.stringify({
			FormatVersion: 2,
			Namespace: "UI",
			Children: [{ Key: "K", Source: { Text: "Source" }, Translation: { Text: "Shipped" } }]
		});
		const po = 'msgctxt "UI,K"\nmsgid "Source"\nmsgstr "Shipped"\n';
		await writeFile(join(projectRoot, "Refresh.manifest"), manifest);
		for (const culture of authored.cultures) {
			await writeFile(join(projectRoot, `${culture}.archive`), archive);
			await writeFile(join(projectRoot, `${culture}.po`), po);
		}
		let signature = "before";
		let value = "Source";
		const reads: string[][] = [];
		const path = "Content/Text/Table.uasset";
		const progress: GameTextIndexProgress[] = [];
		const source = Layer.succeed(GameTextIndexSource, {
			inventory: () =>
				Effect.succeed([
					{
						path,
						signature,
						headerData: {
							packageFlags: 0x40000,
							gatherableTextDataCount: 0,
							gatherableTextDataOffset: 0,
							hasTextProperty: false
						}
					}
				]),
			read: (_root, entries) => {
				reads.push(entries.map((entry) => entry.path));
				return Stream.succeed({
					...emptyPackageTextRecord(path),
					occurrences: [
						{
							source: value,
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
				});
			}
		});
		const evidence = Layer.succeed(LocalizationEvidence, {
			discover: () =>
				Effect.succeed({ schemaVersion: 1, targets: [authored], diagnostics: [] }),
			read: () =>
				Effect.die("Index refresh must not read whole localization files as objects."),
			targets: () => Effect.die("Index refresh discovers target configuration directly.")
		});
		const builds = { localization: 0, packages: 0, joined: 0 };
		const builder = Layer.effect(
			GameTextIndexBuilder,
			Effect.gen(function* () {
				const fallback = yield* GameTextIndexBuilder;
				return GameTextIndexBuilder.of({
					...fallback,
					importLocalizationTarget: (request) => {
						builds.localization++;
						return fallback.importLocalizationTarget(request);
					},
					refreshPackageTextLayer: (request) => {
						builds.packages++;
						return fallback.refreshPackageTextLayer(request);
					},
					refreshJoinedTarget: (request) => {
						builds.joined++;
						return fallback.refreshJoinedTarget(request);
					}
				});
			})
		).pipe(Layer.provideMerge(typeScriptIndexBuilderLayer));
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const refresh = yield* GameTextIndexRefresh;
					const request = { projectRoot, targetName: authored.name };
					const first = yield* refresh.refresh(request);
					expect(progress.map((event) => event.phase)).toEqual(
						expect.arrayContaining([
							"localization",
							"inventory",
							"packages",
							"joining",
							"opening",
							"ready"
						])
					);
					expect(progress).toContainEqual({
						phase: "localization",
						completed: 5,
						total: 5
					});
					expect(progress).toContainEqual({ phase: "packages", completed: 1, total: 1 });
					expect(progress.at(-1)?.phase).toBe("ready");
					const searches = [
						{ query: "source", capability: "all" as const, pageSize: 10 },
						{ query: "absent", capability: "all" as const, pageSize: 10 },
						{
							query: "Source",
							capability: "all" as const,
							pageSize: 10,
							localization: { target: authored.name, culture: "de" },
							facets: { folder: "", assets: true, origins: true, cultures: true }
						}
					].map((request) => Schema.decodeUnknownSync(TextCorpusSearchRequest)(request));
					for (const search of searches)
						expect(yield* first.search(search)).toEqual(
							yield* first.query.search(search)
						);
					let armed = false;
					let checkpoints = 0;
					const cancellable = columnarTextCorpusQuery(
						first.joined,
						undefined,
						undefined,
						() => {
							checkpoints++;
							if (armed && checkpoints === 2) throw new Error("Test interruption");
						}
					);
					cancellable.search(searches[0]!);
					checkpoints = 0;
					armed = true;
					const interruptedRequest = {
						query: "new-term",
						capability: "all" as const,
						pageSize: 10
					};
					expect(() => cancellable.search(interruptedRequest)).toThrow();
					armed = false;
					checkpoints = 0;
					expect(cancellable.search(searches[0]!)).toEqual(
						yield* first.query.search(searches[0]!)
					);
					expect(checkpoints).toBe(1);
					expect(cancellable.search(interruptedRequest)).toEqual(
						yield* first.query.search(interruptedRequest)
					);
					const groupRequests = ["Content/Text", "Content/Other"].map((openGroup) =>
						Schema.decodeUnknownSync(TextCorpusSearchRequest)({
							...searches[0],
							group: "folder",
							openGroup
						})
					);
					expect(
						yield* Effect.all(groupRequests.map(first.search), {
							concurrency: "unbounded"
						})
					).toEqual(
						yield* Effect.all(
							groupRequests.map((request) => first.query.search(request))
						)
					);
					expect(
						(yield* first.query.search({
							query: "Source",
							capability: "all",
							pageSize: 10
						})).total
					).toBe(1);
					const before = yield* hydrateJoinedTarget(first.joined);
					expect(before.lines[0]?.source).toBe("Source");
					const unchanged = yield* refresh.refresh(request);
					expect(unchanged.join.rebuilt).toBe(false);
					expect(unchanged.packages.readPackages).toBe(0);
					expect(reads).toEqual([[path]]);
					yield* Effect.promise(async () => {
						signature = "after";
						value = "Changed source with enough text to retain the long-source finding";
						await writeFile(
							join(projectRoot, "de.po"),
							po.replace("Shipped", "Pending")
						);
						await writeFile(
							join(projectRoot, "de.archive"),
							archive.replace("Shipped", "Skipped")
						);
					});
					yield* refresh.invalidate({ ...request, changedFiles: ["de.po"] });
					const changed = yield* refresh.refresh({
						...request,
						changedFiles: [path, "de.po"]
					});
					const after = yield* hydrateJoinedTarget(changed.joined);
					expect(
						(yield* changed.query.search({
							query: "Changed",
							capability: "all",
							pageSize: 10
						})).total
					).toBe(1);
					expect(
						(yield* first.query.search({
							query: "Changed",
							capability: "all",
							pageSize: 10
						})).total
					).toBe(0);
					expect(after.lines[0]?.source).toBe(value);
					const marks = after.lines[0]?.cultures.find((mark) => mark.culture === "de");
					expect(marks?.archive?.translation.Text).toBe("Shipped");
					expect(marks?.poTranslation).toBe("Pending");
					expect(yield* hydrateJoinedTarget(first.joined)).toEqual(before);
					expect(yield* first.search(searches[0]!)).toEqual(
						yield* first.query.search(searches[0]!)
					);
					expect(
						yield* changed.search({ query: "Changed", capability: "all", pageSize: 10 })
					).toEqual(
						yield* changed.query.search({
							query: "Changed",
							capability: "all",
							pageSize: 10
						})
					);
					const reviewPath = defaultLocalizationReviewPath(authored.name);
					yield* Effect.promise(async () => {
						await mkdir(join(projectRoot, dirname(reviewPath)), { recursive: true });
						await writeFile(
							join(projectRoot, reviewPath),
							JSON.stringify({
								schemaVersion: 1,
								target: authored.name,
								acceptedFindings: [],
								records: [
									{
										culture: "de",
										namespace: "UI",
										key: "K",
										flags: ["reviewed"],
										by: "Test reviewer",
										at: "2026-01-01T00:00:00Z",
										fingerprint: localizationReviewFingerprint(
											"Source",
											"Pending"
										)
									}
								]
							})
						);
					});
					yield* refresh.invalidate({ ...request, changedFiles: [reviewPath] });
					const reviewed = yield* refresh.refresh({ ...request, changedFiles: [] });
					expect(reviewed.join.rebuilt).toBe(true);
					expect(reviewed.imported.files).toHaveLength(0);
					expect(
						(yield* hydrateJoinedTarget(reviewed.joined)).lines[0]?.cultures[1]?.review
							?.status
					).toBe("current");
					const full = yield* refresh.refresh(request);
					expect(
						(yield* hydrateJoinedTarget(full.joined)).lines[0]?.cultures[1]?.archive
							?.translation.Text
					).toBe("Skipped");
					const pinned = yield* hydrateJoinedTarget(full.joined);
					signature = "incremental";
					value = "Optimized source with enough text to retain the long-source finding";
					const incremental = yield* refresh.refresh({
						...request,
						changedFiles: [path]
					});
					expect(incremental.join).toMatchObject({ strategy: "incremental" });
					expect(
						(yield* incremental.query.search({
							query: "Optimized",
							capability: "all",
							pageSize: 10
						})).total
					).toBe(1);
					expect(
						(yield* full.query.search({
							query: "Optimized",
							capability: "all",
							pageSize: 10
						})).total
					).toBe(0);
					expect(yield* hydrateJoinedTarget(full.joined)).toEqual(pinned);
				})
			).pipe(
				Effect.provideService(GameTextIndexProgressReporter, (event) => {
					progress.push(event);
				}),
				Effect.provide(
					gameTextIndexRefreshLayer(join(projectRoot, "cache"), {}).pipe(
						Layer.provide(source),
						Layer.provide(builder),
						Layer.provide(evidence)
					)
				)
			)
		);
		expect(builds).toEqual({ localization: 6, packages: 6, joined: 6 });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);

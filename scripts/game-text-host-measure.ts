/// <reference path="../apps/workbench/node_modules/electron/electron.d.ts" />
import { GameTextIndexBuilderLive } from "../packages/game-text/dist/entry-index.js";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { Context, Effect, Exit, Layer, Schema, Scope, Stream, type Tracer } from "effect";
import {
	GameTextIndexSteps,
	GameTextIndexBuilder,
	GameTextIndexSource,
	gameTextIndexRefreshLayer,
	type GameTextIndexRefreshResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchPage
} from "../packages/game-text/dist/index.js";
import {
	LocalizationEvidenceNodeLive,
	LocalizationEvidence,
	LocalizationTargetName,
	CultureCode
} from "../packages/localization/dist/index.js";
import { PackageTextStored } from "../packages/game-text/src/package-text-columns.ts";
import { packageTextShard } from "../packages/game-text/src/package-text-layer.ts";
import { packageTextJsonLines } from "./retained-package-lines.ts";
import { readGeneratedPackageInventory } from "./package-text-generated.ts";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";
import type { WorkbenchGameTextApi } from "../apps/workbench/src/main/services/game-text.ts";
import { AssetReaderLive } from "../packages/unreal-assets/dist/index.js";
import { sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import {
	openJoinedTarget,
	type JoinedTargetReader
} from "../packages/game-text/src/joined-target-reader.ts";

type Measure = <A>(
	name: string,
	run: () => Promise<A>,
	summary: (value: A) => object
) => Promise<void>;

/** Retained reader evidence is supplied at the native-reader boundary. Hosts, refresh, builder and
 * queries are the production implementations; no event-built corpus or join is used here. */
export async function measureGameTextHosts(
	project: string,
	cache: string,
	records: string,
	measure: Measure,
	host: string,
	task: string,
	changedByte: number,
	forceChangedJoin = false,
	backend: "native" | "typescript" = "native",
	tracer?: Tracer.Tracer,
	packageEditId = "phase6-refresh"
) {
	if (host !== "cli" && host !== "workbench") throw new Error("Choose cli or workbench.");
	if (
		process.env.NODE_OPTIONS ||
		process.execArgv.some((arg) => arg.startsWith("--max-old-space-size"))
	)
		throw new Error("Host measurements require Node's default heap.");
	const recipe = await readScaleRecipe(project);
	if (backend !== "native")
		throw new Error("Run the historical TypeScript baseline from its original checkout.");
	const selectedBuilder = GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive));

	// A capped cold build may publish nothing. Prepare disposable file layers in separately
	// capped runs so query measurements remain available; this is never a cold-build success.
	if (task.startsWith("prepare-file:")) {
		const position = Number(task.slice("prepare-file:".length));
		const preparation = Effect.gen(function* () {
			const builder = yield* GameTextIndexBuilder;
			const evidence = yield* LocalizationEvidence;
			const discovery = yield* evidence.discover({ projectRoot: project });
			const target = discovery.targets.find((value) => value.name === "Generated");
			if (!target) throw new Error("Generated target is absent.");
			const files = [
				{ path: target.outputPaths.manifest, format: "manifest" as const },
				...target.cultures.flatMap((culture) => [
					{ path: target.outputPaths.archives[culture], format: "archive" as const },
					{ path: target.outputPaths.portableObjects[culture], format: "po" as const }
				])
			];
			const file =
				Number.isSafeInteger(position) && position >= 0 ? files[position] : undefined;
			if (!file?.path) throw new Error("Choose an existing target file position.");
			return yield* builder.withSession(
				{
					configuration: {
						cacheRoot: cache,
						projectKey: project,
						targetKey: target.name,
						projectView: { kind: "localization", target: target.name }
					}
				},
				builder.importLocalizationFile({
					projectRoot: project,
					cacheRoot: cache,
					sharedTargetKey: target.name,
					projectScoped: true,
					relativePath: file.path,
					format: file.format,
					poFormat: target.poFormat,
					collapseMode: target.collapseMode
				})
			);
		}).pipe(Effect.provide(selectedBuilder), Effect.provide(LocalizationEvidenceNodeLive));
		await measure(
			`${host}:${task}`,
			() => Effect.runPromise(preparation),
			(file) => ({
				builder:
					backend === "native"
						? "Native public protocol adapter"
						: "TypeScript reference builder",
				path: file.relativePath,
				parsed: file.parsed,
				bytes: file.snapshotBytes
			})
		);
		return;
	}
	const selected = (await readGeneratedPackageInventory(records)).find((entry) =>
		entry.path.endsWith("/Package0.uasset")
	);
	if (!selected) throw new Error("Retained package 0 is absent.");
	let version = "";
	const packageBytesDelta = task === "refresh-package-size" ? 16 : 0;
	const builderLayer = forceChangedJoin
		? Layer.effect(
				GameTextIndexBuilder,
				Effect.gen(function* () {
					const builder = yield* GameTextIndexBuilder;
					return GameTextIndexBuilder.of({
						...builder,
						refreshJoinedTarget: (input) =>
							builder.refreshJoinedTarget({
								...input,
								force: input.force || version !== ""
							})
					});
				}).pipe(Effect.provide(selectedBuilder))
			)
		: selectedBuilder;
	const source = Layer.succeed(
		GameTextIndexSource,
		GameTextIndexSource.of({
			inventory: () =>
				Effect.promise(async () =>
					(await readGeneratedPackageInventory(records)).map((entry) =>
						version && entry.path === selected.path
							? {
									...entry,
									signature: `${selected.signature}:${version}${packageBytesDelta ? ":resized" : ""}`
								}
							: entry
					)
				),
			read: (_root, entries) =>
				Stream.fromAsyncIterable(
					(async function* () {
						const wanted = new Set(entries.map((entry) => entry.path));
						const shards = [
							...new Set(entries.map((entry) => packageTextShard(entry.path)))
						];
						const decode = Schema.decodeUnknownSync(
							Schema.fromJsonString(PackageTextStored)
						);
						for (const shard of shards)
							for await (const line of packageTextJsonLines(
								join(records, `package-text.${shard}.ndjson`)
							)) {
								const record = decode(line);
								if (!wanted.has(record.path)) continue;
								if (record.evidence.event === "not_gatherable")
									throw new Error("Host requested an excluded package.");
								const event = record.evidence;
								yield version &&
								record.path === selected.path &&
								event.event === "text_package_record"
									? {
											...event,
											fileBytes: event.fileBytes + packageBytesDelta,
											occurrences: event.occurrences.map((occurrence, row) =>
												row === 0
													? {
															...occurrence,
															source: `${occurrence.source} ${version}`
														}
													: occurrence
											)
										}
									: event;
							}
					})(),
					(cause) => {
						throw cause;
					}
				)
		})
	);
	if (task === "prepare-packages" || task === "prepare-saved-packages") {
		const preparation = Effect.gen(function* () {
			const builder = yield* GameTextIndexBuilder;
			const reader = yield* GameTextIndexSource;
			const inventory = yield* reader.inventory({ projectRoot: project });
			const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
			return yield* builder.withSession(
				{
					configuration: {
						cacheRoot: cache,
						projectKey: project,
						targetKey: "SavedText",
						projectView: { kind: "source" }
					}
				},
				builder.refreshPackageTextLayer({
					inventory,
					read: (paths) =>
						reader.read(
							project,
							paths.map((path) => byPath.get(path)!)
						)
				})
			);
		}).pipe(Effect.provide(source), Effect.provide(selectedBuilder));
		await measure(
			`${host}:${task}`,
			() => Effect.runPromise(preparation),
			(value) => ({
				builder:
					backend === "native"
						? "Native public protocol adapter"
						: "TypeScript reference builder",
				readPackages: value.readPackages,
				changedShards: value.changedShards,
				published: value.published
			})
		);
		return;
	}
	const indexLayer = gameTextIndexRefreshLayer(cache).pipe(
		Layer.provide(source),
		Layer.provide(builderLayer),
		Layer.provide(selectedBuilder),
		Layer.provide(LocalizationEvidenceNodeLive)
	);
	const rootScope = await Effect.runPromise(Scope.make());
	const run = <A, E>(effect: Effect.Effect<A, E>) =>
		Effect.runPromise(tracer ? Effect.withTracer(effect, tracer) : effect);
	const context = await run(Layer.buildWithScope(indexLayer, rootScope));
	const targetName = LocalizationTargetName.make("Generated");
	const cli =
		host === "cli" ? await import("../apps/cli/src/workflows/game-text-index.ts") : undefined;
	const builderLabel =
		backend === "native" ? "Native public protocol adapter" : "TypeScript reference builder";
	let readerScope: Scope.Closeable | undefined;
	let result: GameTextIndexRefreshResult | undefined;
	let workbench: WorkbenchGameTextApi | undefined;
	const openCli = async () => {
		if (readerScope) await run(Scope.close(readerScope, Exit.void));
		readerScope = await run(Scope.make());
		result = await run(
			cli!
				.refreshCliGameTextIndex(
					{ projectRoot: project, targetName: "Generated" },
					undefined
				)
				.pipe(Effect.provide(context), Effect.provideService(Scope.Scope, readerScope))
		);
		return {
			builder: builderLabel,
			joinPolicy: forceChangedJoin
				? "force full join for changed inputs"
				: "production incremental",
			readPackages: result.packages.readPackages,
			packageEditId: version || null,
			packageBytesDelta: version ? packageBytesDelta : 0,
			parsedFiles: result.imported.files.filter((file) => file.parsed).length,
			changedShards: result.packages.changedShards,
			packageProfile: result.packages.profile,
			rebuilt: result.join.rebuilt,
			...("strategy" in result.join ? { strategy: result.join.strategy } : undefined),
			...("affectedLines" in result.join
				? { affectedLines: result.join.affectedLines }
				: undefined),
			...("incrementalFallback" in result.join
				? { incrementalFallback: result.join.incrementalFallback }
				: undefined)
		};
	};
	const openWorkbench = async () => {
		const { WorkbenchGameText, WorkbenchGameTextLive } =
			await import("../apps/workbench/src/main/services/game-text.ts");
		const { makeWorkbenchProjectTestLayer } =
			await import("../apps/workbench/src/main/services/project-workspace.ts");
		const { ElectronDialog } =
			await import("../apps/workbench/src/main/adapters/electron-dialog.ts");
		const { LocalFilesLive } =
			await import("../apps/workbench/src/main/adapters/local-files.ts");
		const projectSummary = {
			inputAtlas: "ready" as const,
			mapCount: 0,
			packageCount: recipe.packages,
			projectName: basename(project),
			projectRoot: project,
			generation: 0
		};
		const projects = makeWorkbenchProjectTestLayer({
			choose: () => Effect.succeed({ status: "ready", project: projectSummary }),
			current: () => Effect.succeed({ status: "ready", project: projectSummary }),
			candidates: () =>
				Effect.succeed({
					generation: 0,
					assets: [],
					failures: [],
					summary: {
						cacheHits: 0,
						depth: "header",
						diagnostics: [],
						emittedAssets: 0,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot: project,
						roots: [join(project, "Content")],
						scannedAssets: 0,
						schema_version: 8,
						skippedAssets: 0
					}
				}),
			inputAtlas: () => Effect.die("Not used"),
			savedProject: () => Effect.succeed({ maps: [], projectRoot: project }),
			savedTables: () => Effect.die("Not used")
		});
		const dialogs = Layer.succeed(
			ElectronDialog,
			ElectronDialog.of({
				chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
				chooseFile: () => Effect.succeed({ status: "cancelled" }),
				chooseFiles: () => Effect.succeed({ status: "cancelled" }),
				chooseSaveFile: () => Effect.succeed({ status: "cancelled" })
			})
		);
		const layer = WorkbenchGameTextLive.pipe(
			Layer.provide(projects),
			Layer.provide(dialogs),
			Layer.provide(LocalFilesLive),
			Layer.provide(LocalizationEvidenceNodeLive),
			Layer.provide(
				Layer.succeed(GameTextIndexSteps, Context.get(context, GameTextIndexSteps))
			)
		);
		const built = await run(Layer.buildWithScope(layer, rootScope));
		workbench = Context.get(built, WorkbenchGameText);
		const refreshed = await run(workbench.configuredRefresh(true));
		if (refreshed.status !== "completed") throw new Error(JSON.stringify(refreshed));
		const localized = await run(workbench.localizationTarget(targetName));
		if (localized.status !== "ready") throw new Error(JSON.stringify(localized));
		return {
			builder: builderLabel,
			lines: localized.lines,
			savedUnits: refreshed.summary.searchable.textUnits
		};
	};
	const refresh = async () => {
		if (host === "cli") return openCli();
		if (!workbench) return openWorkbench();
		const refreshed = await run(workbench.configuredRefresh(true));
		if (refreshed.status !== "completed") throw new Error(JSON.stringify(refreshed));
		const localized = await run(workbench.localizationTarget(targetName));
		if (localized.status !== "ready") throw new Error(JSON.stringify(localized));
		return {
			builder: builderLabel,
			lines: localized.lines,
			savedUnits: refreshed.summary.searchable.textUnits
		};
	};
	const query = async (request: TextCorpusSearchRequest): Promise<TextCorpusSearchPage> => {
		if (host === "cli") return run(result!.query.search(request));
		const reply = await run(workbench!.search(request));
		if (reply.status !== "ready") throw new Error(JSON.stringify(reply));
		return reply.page;
	};
	const base: TextCorpusSearchRequest = {
		query: "",
		capability: "all",
		pageSize: 1,
		localization: { target: targetName, culture: CultureCode.make(recipe.cultures[0]!) }
	};
	const pageSummary = (page: TextCorpusSearchPage) => ({
		total: page.total,
		displayed: page.units.length,
		lines: page.localization?.lines.length ?? 0,
		sha256: createHash("sha256").update(JSON.stringify(page)).digest("hex"),
		// Historical synchronous CLI values and schema-decoded native values can have
		// different object-key insertion order while carrying exactly the same response.
		canonicalSha256: createHash("sha256")
			.update(
				JSON.stringify(page, (_key, value: Schema.Json | undefined) =>
					value instanceof Object && !Array.isArray(value)
						? Object.fromEntries(
								Object.entries(value).sort(([a], [b]) =>
									a < b ? -1 : a > b ? 1 : 0
								)
							)
						: value
				)
			)
			.digest("hex")
	});
	const columnProof = (joined: JoinedTargetReader) =>
		run(
			Effect.gen(function* () {
				const hashes: Record<string, string> = {};
				for (const name of [
					...new Set([
						...joined.layer.directory.entries.keys(),
						...Object.keys(joined.meta.aliases),
						...Object.keys(joined.meta.chunks ?? {}),
						...Object.keys(joined.meta.patches ?? {})
					])
				].sort()) {
					// Incremental generations intentionally retain the base source accelerator, so its
					// bytes are not a full build's.
					if (
						name === "join.meta" ||
						name === "shared.meta" ||
						name.startsWith("query.source.")
					)
						continue;
					const values = yield* joined.layer.section(name);
					hashes[name] = createHash("sha256")
						.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
						.digest("hex");
				}
				return {
					hashes,
					count: joined.meta.count,
					pairs: joined.meta.pairs,
					ambiguous: joined.meta.ambiguous
				};
			})
		);
	try {
		await measure(
			`${host}:${
				task === "cold" || task === "all"
					? "cold-build"
					: task === "prepared"
						? "prepared-open"
						: "warm-open"
			}`,
			refresh,
			(value) => value
		);
		let first: TextCorpusSearchPage | undefined;
		await measure(`${host}:first-query`, async () => (first = await query(base)), pageSummary);
		await measure(`${host}:count`, () => query(base), pageSummary);
		await measure(
			`${host}:filter`,
			() =>
				query({
					...base,
					filter: [{ field: "problem", op: "is", values: ["translation"] }]
				}),
			pageSummary
		);
		await measure(
			`${host}:facet`,
			async () => {
				const page = await query({
					...base,
					facets: { folder: "", assets: true, origins: true, cultures: true }
				});
				if (
					!page.facets?.folders ||
					!page.facets.assets ||
					!page.facets.origins ||
					!page.facets.cultures
				)
					throw new Error("Requested facets are absent.");
				return page;
			},
			pageSummary
		);
		await measure(
			`${host}:page`,
			() =>
				query({
					...base,
					pageSize: 50,
					...(first!.localization?.nextCursor === undefined
						? undefined
						: { localizationCursor: first!.localization.nextCursor })
				}),
			pageSummary
		);
		await measure(
			`${host}:facet-repeat`,
			() =>
				query({
					...base,
					facets: { folder: "", assets: true, origins: true, cultures: true }
				}),
			pageSummary
		);
		await measure(
			`${host}:page-repeat`,
			() =>
				query({
					...base,
					pageSize: 50,
					...(first!.localization?.nextCursor === undefined
						? undefined
						: { localizationCursor: first!.localization.nextCursor })
				}),
			pageSummary
		);
		await measure(`${host}:search`, () => query({ ...base, query: "mirava" }), pageSummary);
		await measure(
			`${host}:search-repeat`,
			() => query({ ...base, query: "mirava" }),
			pageSummary
		);
		const absentQuery = "__ue_shed_benchmark_absent_source__";
		await measure(
			`${host}:empty-search`,
			() => query({ ...base, query: absentQuery }),
			pageSummary
		);
		await measure(
			`${host}:empty-search-repeat`,
			() => query({ ...base, query: absentQuery }),
			pageSummary
		);
		// Every term differs from earlier requests: this measures typing and new predicates,
		// rather than revisiting the exact-match query cache.
		const distinctQueries = [
			"m",
			"mi",
			"mir",
			"mira",
			"mirav",
			"a",
			"é",
			"😀",
			"mirava archive"
		];
		for (const [index, text] of distinctQueries.entries())
			await measure(
				`${host}:search-distinct-${index}`,
				() => query({ ...base, query: text }),
				(page) => ({ ...pageSummary(page), query: text })
			);
		const id = first!.units[0]?.id,
			lineId = first!.localization?.lines[0]?.id;
		if (!id || !lineId) throw new Error("Focus fixture absent.");
		await measure(
			`${host}:focus`,
			async () =>
				host === "cli"
					? run(
							result!.query.focus({
								id,
								pageSize: 20,
								localization: { target: targetName, id: lineId }
							})
						)
					: run(
							workbench!.focus({
								id,
								pageSize: 20,
								localization: { target: targetName, id: lineId }
							})
						),
			(value) => {
				const focus =
					value && "status" in value
						? value.status === "found"
							? value.focus
							: undefined
						: value;
				if (!focus || focus.totalOccurrences < 1)
					throw new Error("Focus did not return saved occurrence evidence.");
				return {
					found: true,
					occurrences: focus.occurrences.length,
					totalOccurrences: focus.totalOccurrences
				};
			}
		);
		await measure(`${host}:refresh-no-change`, refresh, (value) => value);
		if (host === "cli") {
			const { runCli } = await import("../apps/cli/src/command.ts");
			const { CliRuntime } = await import("../apps/cli/src/cli-runtime.ts");
			let statusTotal = 0,
				exitCode = 0;
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (value) =>
						Effect.sync(() => {
							statusTotal = JSON.parse(value).page?.total ?? statusTotal;
						}),
					printError: (value) => Effect.die(value),
					setExitCode: (code) =>
						Effect.sync(() => {
							exitCode = code;
						})
				})
			);
			await measure(
				"cli:loc-status-command",
				async () => {
					await run(
						runCli([
							"loc",
							"status",
							project,
							"--target",
							"Generated",
							"--limit",
							"1"
						]).pipe(Effect.provide(context), Effect.provide(runtime))
					);
					if (exitCode) throw new Error(`CLI status exited ${exitCode}`);
					return { total: statusTotal, exitCode };
				},
				(value) => value
			);
		}
		if (
			["all", "refresh", "refresh-package", "refresh-package-size", "refresh-po"].includes(
				task
			)
		) {
			const editPackage = task !== "refresh-po";
			const editPo = ["all", "refresh", "refresh-po"].includes(task);
			const byte = editPo
				? await captureBenchmarkByte(
						join(project, "Content/Localization/Generated/en/Generated.po"),
						"mirava"
					)
				: undefined;
			try {
				version = editPackage ? packageEditId : "";
				if (byte) {
					const { open } = await import("node:fs/promises");
					const file = await open(byte.path, "r+");
					try {
						await file.write(
							Uint8Array.of(changedByte === byte.byte ? 111 : changedByte),
							0,
							1,
							byte.offset
						);
						await file.sync();
					} finally {
						await file.close();
					}
				}
				const edit = editPackage
					? editPo
						? "one-package-one-po"
						: packageBytesDelta
							? "one-package-with-size-change"
							: "one-package"
					: "one-po";
				await measure(`${host}:refresh-${edit}`, refresh, (value) => value);
				await measure(`${host}:query-after-refresh`, () => query(base), pageSummary);
				await measure(
					`${host}:search-after-refresh`,
					() => query({ ...base, query: "phase6-refresh" }),
					pageSummary
				);
				if (host === "cli" && !forceChangedJoin) {
					await measure(
						"cli:proof-incremental-full",
						async () => {
							const incremental = await columnProof(result!.joined);
							const input = result!.joined.meta.input;
							if (readerScope) await run(Scope.close(readerScope, Exit.void));
							readerScope = undefined;
							const full = await Effect.runPromise(
								Effect.scoped(
									Effect.gen(function* () {
										const builder = yield* GameTextIndexBuilder;
										yield* builder.withSession(
											{
												configuration: {
													cacheRoot: cache,
													projectKey: project,
													targetKey: "Generated",
													projectView: {
														kind: "localization",
														target: "Generated"
													}
												}
											},
											builder.refreshJoinedTarget({ ...input, force: true })
										);
										const joined = yield* openJoinedTarget();
										return yield* Effect.promise(() => columnProof(joined));
									})
								).pipe(
									Effect.provide(selectedBuilder),
									Effect.provide(
										sharedIndexNodeLayer({
											cacheRoot: cache,
											projectKey: project,
											targetKey: "Generated",
											projectView: {
												kind: "localization",
												target: "Generated"
											}
										})
									)
								)
							);
							if (JSON.stringify(incremental) !== JSON.stringify(full)) {
								const names = [
									...new Set([
										...Object.keys(incremental.hashes),
										...Object.keys(full.hashes)
									])
								].filter((name) => incremental.hashes[name] !== full.hashes[name]);
								const { writeFile } = await import("node:fs/promises");
								await writeFile(
									join(cache, "join-proof-failure.json"),
									JSON.stringify({ incremental, full, names }, null, "\t")
								);
								throw new Error(
									`STOP: measured incremental columns differ from full rebuild: ${names.join(", ")}`
								);
							}
							return {
								equal: true,
								columns: Object.keys(full.hashes).length,
								lines: full.count,
								differences: 0
							};
						},
						(value) => value
					);
				}
			} finally {
				await restoreBenchmarkByte(byte);
				version = "";
				await measure(`${host}:restore-derived-index`, refresh, (value) => value);
			}
		}
	} finally {
		if (readerScope) await run(Scope.close(readerScope, Exit.void));
		await run(Scope.close(rootScope, Exit.void));
	}
}

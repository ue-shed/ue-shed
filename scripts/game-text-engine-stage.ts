import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { channel } from "node:diagnostics_channel";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Fiber, Layer, Option, Result, Schema, Scope } from "effect";
import * as currentIndex from "../packages/game-text/dist/entry-index.js";
import * as currentWorkspace from "../packages/game-text/dist/entry-workspace.js";
import type { GameTextWorkspaceFileHooks } from "../packages/game-text/dist/entry-workspace.js";
import * as currentSchema from "../packages/game-text/dist/entry-schema.js";
import type {
	TextCorpusRowsPage,
	TextCorpusSearchPage
} from "../packages/game-text/dist/entry-schema.js";
import * as currentAssets from "../packages/unreal-assets/dist/index.js";
import * as currentLocalization from "../packages/localization/dist/index.js";
import * as currentCorpus from "../packages/game-text/dist/entry-corpus.js";
import * as currentRules from "../packages/game-text/dist/entry-rules.js";
import * as currentPublic from "../packages/game-text/dist/index.js";
import { retainedPackageSource } from "./game-text-scale-quality.ts";
import { trackBenchmarkEventLoop } from "./benchmark-event-loop.ts";
import {
	decodeEngineRequestMix,
	engineAnswerDigest,
	expectFound,
	type EngineSample
} from "./game-text-engine-results.ts";

export interface EngineStageOptions {
	readonly project: string;
	readonly cache: string;
	readonly output: string;
	readonly mix: string;
	readonly records?: string | undefined;
	readonly target?: string | undefined;
	readonly stage: string;
	/** Persistent project-index cache warmed outside the measured stages. */
	readonly projectIndexCache?: string | undefined;
	/** Keep the first-ever cold project-index refresh inside the measured build. */
	readonly coldProjectIndex?: boolean | undefined;
}

type EngineRequestMetrics = ReturnType<ReturnType<typeof trackBenchmarkEventLoop>["stop"]> & {
	nodeThreadCpuMs: number;
	failed: 0 | 1;
	total?: number;
	rowCount?: number;
};

/** All writable destinations belong to the caller's output directory; projects are inputs only. */
export async function runEngineStage(options: EngineStageOptions) {
	// The same harness can load a preserved build for an alternating instrumentation-off control.
	// SAFETY: the preserved build is the same commit and public API types as the current build.
	const load = async <A>(path: string, current: A): Promise<A> =>
		process.env.UE_SHED_ENGINE_API_ROOT
			? (import(
					pathToFileURL(join(process.env.UE_SHED_ENGINE_API_ROOT, "packages", path)).href
				) as Promise<A>)
			: current;
	const {
		GameTextIndexBuilderLive,
		GameTextIndexSource,
		GameTextIndexSteps,
		gameTextIndexRefreshLayer,
		gameTextIndexSourceNodeLayer
	} = await load("game-text/dist/entry-index.js", currentIndex);
	const { makeGameTextWorkspace } = await load(
		"game-text/dist/entry-workspace.js",
		currentWorkspace
	);
	const { TextCorpusSearchRequest, TextUnit } = await load(
		"game-text/dist/entry-schema.js",
		currentSchema
	);
	const { AssetReader, AssetReaderLive, projectIndexProcessLayerFromReader } = await load(
		"unreal-assets/dist/index.js",
		currentAssets
	);
	const { LocalizationEvidence, LocalizationEvidenceNodeLive, LocalizationTargetName } =
		await load("localization/dist/index.js", currentLocalization);
	const { LOCALIZATION_LINES_CSV_FIELDS, localizationLinesCsv } = await load(
		"game-text/dist/entry-corpus.js",
		currentCorpus
	);
	const { decodeGameTextRuleDocumentJson, effectiveRuleDocument, STARTER_CHECK_RULES } =
		await load("game-text/dist/entry-rules.js", currentRules);
	const { gatheredIdentityKey, gatheredTextIdentity } = await load(
		"game-text/dist/index.js",
		currentPublic
	);
	const [stage, scenarioHost, scenarioGroups] = options.stage.split(":");
	const mix = decodeEngineRequestMix(JSON.parse(await readFile(options.mix, "utf8")));
	const samples: EngineSample[] = [];
	const timings: unknown[] = [];
	let activeSample: string | undefined;
	const topic = channel("ue-shed.game-text-benchmark");
	const Timing = Schema.Struct({
		stage: Schema.String,
		ms: Schema.Number,
		requestId: Schema.optionalKey(Schema.String),
		action: Schema.optionalKey(Schema.String)
	});
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostics_channel owns this boundary; decode it immediately.
	const listener = (message: unknown) =>
		timings.push({ sampleId: activeSample, ...Schema.decodeUnknownSync(Timing)(message) });
	if (process.env.UE_SHED_GAME_TEXT_MEASURE_DIR) topic.subscribe(listener);
	// What each measured sample moved between the host and the native processes, per operation.
	const boundaries = new Map<
		string,
		Record<string, { requests: number; requestBytes: number; responseBytes: number }>
	>();
	const Boundary = Schema.Struct({
		transport: Schema.String,
		operation: Schema.String,
		requestBytes: Schema.Number,
		responseBytes: Schema.Number
	});
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostics_channel owns this boundary; decode it immediately.
	const boundaryListener = (message: unknown) => {
		if (activeSample === undefined) return;
		const event = Schema.decodeUnknownSync(Boundary)(message);
		const totals = boundaries.get(activeSample) ?? {};
		const key = `${event.transport}:${event.operation}`;
		const total = (totals[key] ??= { requests: 0, requestBytes: 0, responseBytes: 0 });
		total.requests += 1;
		total.requestBytes += event.requestBytes;
		total.responseBytes += event.responseBytes;
		boundaries.set(activeSample, totals);
	};
	channel("ue-shed.native-boundary").subscribe(boundaryListener);
	let peakHeapBytes = 0;
	let peakRssBytes = 0;
	let measuring = false;
	let measurementDepth = 0;
	const pendingHashes: (() => Promise<void>)[] = [];
	let recording = true;
	const sample = () => {
		const memory = process.memoryUsage();
		if (recording) {
			peakHeapBytes = Math.max(peakHeapBytes, memory.heapUsed);
			peakRssBytes = Math.max(peakRssBytes, memory.rss);
		}
		process.send?.({ kind: "memory", heap: memory.heapUsed, rss: memory.rss });
	};
	const measure = async <A>(
		id: string,
		run: () => Promise<A>,
		requests: number | (() => number) = 1
	) => {
		recording = true;
		process.send?.({ kind: "resume" });
		if (!measuring) {
			measuring = true;
			peakHeapBytes = 0;
			peakRssBytes = 0;
			process.send?.({ kind: "start" });
		}
		const probe = trackBenchmarkEventLoop();
		const previousSample = activeSample;
		activeSample = id;
		measurementDepth++;
		const cpu = process.threadCpuUsage();
		const started = performance.now();
		let answer: A;
		let ms: number;
		let gaps;
		try {
			answer = await run();
			ms = performance.now() - started;
		} finally {
			activeSample = previousSample;
			measurementDepth--;
			gaps = probe.stop();
			sample();
		}
		const used = process.threadCpuUsage(cpu);
		const counted = Schema.decodeUnknownResult(
			Schema.Struct({
				total: Schema.optionalKey(Schema.Number),
				page: Schema.optionalKey(Schema.Struct({ total: Schema.Number })),
				rowCount: Schema.optionalKey(Schema.Number),
				status: Schema.optionalKey(Schema.String)
			})
		)(answer);
		const total = Result.isSuccess(counted)
			? (counted.success.total ?? counted.success.page?.total)
			: undefined;
		const rowCount = Result.isSuccess(counted) ? counted.success.rowCount : undefined;
		const metrics: EngineRequestMetrics = {
			...gaps,
			nodeThreadCpuMs: (used.user + used.system) / 1000,
			failed: Result.isSuccess(counted) && counted.success.status === "failed" ? 1 : 0
		};
		if (total !== undefined) metrics.total = total;
		if (rowCount !== undefined) metrics.rowCount = rowCount;
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is a number-or-callback API, not unparsed external data.
		const requestCount = typeof requests === "number" ? requests : requests();
		pendingHashes.push(async () => {
			const recorded = {
				id,
				ms,
				...engineAnswerDigest(answer),
				requests: requestCount,
				metrics,
				boundary: boundaries.get(id) ?? {}
			};
			samples.push(recorded);
			process.send?.({ kind: "sample", sample: recorded });
		});
		// Hash outside the whole fan-out timer, including its nested request timers.
		if (measurementDepth === 0) {
			recording = false;
			process.send?.({ kind: "pause" });
			for (const hash of pendingHashes.splice(0)) await hash();
		}
		return answer;
	};
	await mkdir(options.cache, { recursive: true });
	await mkdir(options.output, { recursive: true });
	const files: GameTextWorkspaceFileHooks = {
		chooseFile: () => Effect.succeed({ status: "cancelled" }),
		chooseSaveFile: () => Effect.succeed({ status: "cancelled" }),
		readFile: (path) => Effect.promise(() => readFile(path)),
		readFileWithin: (root, path) => Effect.promise(() => readFile(join(root, path))),
		writeFile: () =>
			Effect.fail({
				message: "Workspace file writes are disabled in the baseline.",
				recovery: "Use the benchmark cache and output directories."
			})
	};
	if (stage === "records") {
		const { convertGeneratedPackageText } = await import("./package-text-generated.ts");
		const { gameTextScaleRecipe } = await import("./localization-scale-data.ts");
		const { readScaleRecipe } = await import("./game-text-scale-options.ts");
		const recipe = gameTextScaleRecipe((await readScaleRecipe(options.project)).scale);
		await measure("records", () =>
			convertGeneratedPackageText(options.project, options.records!, recipe.textPackages)
		);
		return {
			schemaVersion: 1 as const,
			stage: options.stage,
			node: process.version,
			peakHeapBytes,
			peakRssBytes,
			samples
		};
	}
	const scope = await Effect.runPromise(Scope.make());
	// `UE_SHED_GAME_TEXT_STAGES` records every span the stage ends, and their `*.stage_ms.*`
	// attributes, beside the results.
	const recorder = process.env.UE_SHED_GAME_TEXT_STAGES
		? (await import("./game-text-stage-timings.ts")).makeStageRecorder()
		: undefined;
	const run = <A, E>(effect: Effect.Effect<A, E>) =>
		Effect.runPromise(recorder ? Effect.withTracer(effect, recorder.tracer) : effect);
	const timer = setInterval(sample, 25);
	try {
		const projectIndexLayer = (cacheRoot: string) =>
			Layer.unwrap(
				Effect.gen(function* () {
					const reader = yield* AssetReader;
					const configuration = yield* reader.configuration();
					return projectIndexProcessLayerFromReader({ ...configuration, cacheRoot });
				})
			);
		if (stage === "warm-project-index") {
			const warmed = gameTextIndexSourceNodeLayer(options.cache).pipe(
				Layer.provide(projectIndexLayer(options.cache)),
				Layer.provide(AssetReaderLive)
			);
			const context = await run(Layer.buildWithScope(warmed, scope));
			const inventorySource = Context.get(context, GameTextIndexSource);
			await run(inventorySource.inventory({ projectRoot: options.project }));
			return {
				schemaVersion: 1 as const,
				stage: options.stage,
				node: process.version,
				peakHeapBytes,
				peakRssBytes,
				samples
			};
		}
		// The edit stage changes a package, so it reads a linked working copy of the records.
		const records =
			stage === "edit" && options.records
				? join(options.output, "edit-records")
				: options.records;
		if (stage === "edit") {
			if (!options.records) throw new Error("The edit stage needs retained records.");
			const { linkRetainedRecords } = await import("./package-text-generated.ts");
			await linkRetainedRecords(options.records, records!);
		}
		const source = records
			? retainedPackageSource(records)
			: options.projectIndexCache && !options.coldProjectIndex
				? gameTextIndexSourceNodeLayer(options.cache, {
						refreshProjectIndex: false
					}).pipe(
						Layer.provide(projectIndexLayer(options.projectIndexCache)),
						Layer.provide(AssetReaderLive)
					)
				: gameTextIndexSourceNodeLayer(options.cache).pipe(Layer.provide(AssetReaderLive));
		// Quality runs in the engine, so `quality-in-process`, kept for earlier runs' names, is
		// `quality`.
		const layer = gameTextIndexRefreshLayer(options.cache).pipe(
			Layer.provide(source),
			Layer.provide(GameTextIndexBuilderLive.pipe(Layer.provide(AssetReaderLive))),
			Layer.provide(LocalizationEvidenceNodeLive)
		);
		const context = await run(Layer.buildWithScope(layer, scope));
		const steps = Context.get(context, GameTextIndexSteps);
		const state = {
			status: "ready" as const,
			project: { projectRoot: options.project, generation: 0 }
		};
		const workspace = await run(
			makeGameTextWorkspace({
				project: {
					current: () => Effect.succeed(state),
					refresh: () => Effect.succeed(state),
					candidates: () =>
						Effect.succeed({
							generation: 0,
							summary: { projectRoot: options.project }
						}),
					progress: () =>
						Effect.succeed({ phase: "idle", completed: 0, total: 0, stage: "" })
				},
				files
			}).pipe(
				Effect.provide(context),
				Effect.provide(LocalizationEvidenceNodeLive),
				Effect.provideService(Scope.Scope, scope)
			)
		);
		const targetReply = await run(
			Effect.flatMap(LocalizationEvidence, (reader) =>
				reader.discover({ projectRoot: options.project })
			).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
		const targetName = options.target ?? targetReply.targets[0]?.name;
		if (!targetName) throw new Error("The project has no localization target.");
		const target = LocalizationTargetName.make(targetName);
		const { lens: _lens, ...list } = mix.list;
		const base = Schema.decodeUnknownSync(TextCorpusSearchRequest)({
			...list,
			localization: { target }
		});
		const ready = <A extends { readonly status: string }>(reply: A, expected = "ready") => {
			if (reply.status !== expected) throw new Error(JSON.stringify(reply));
			return reply;
		};
		const search = async (request: typeof base) => {
			const reply = await run(workspace.search(request));
			if (reply.status !== "ready") throw new Error(JSON.stringify(reply));
			return reply.page;
		};
		const searchRows = async (request: typeof base) => {
			const reply = await run(workspace.searchRows(request));
			if (reply.status !== "ready") throw new Error(JSON.stringify(reply));
			return reply.page;
		};
		// Open groups as the renderer reads them: one rows request per 20, and alone past the budget.
		const openGroupRows = (
			request: typeof base,
			keys: readonly string[],
			read: (request: typeof base, label: string) => Promise<TextCorpusRowsPage>
		) =>
			Promise.all(
				Array.from({ length: Math.ceil(keys.length / 20) }, async (_, chunk) => {
					const openGroups = keys.slice(chunk * 20, chunk * 20 + 20);
					const reply = await read(
						{ ...request, openGroups, firstRows: request.pageSize },
						`rows-${chunk}`
					);
					return Promise.all(
						(reply.openGroups ?? []).map(
							(group) =>
								group.page ?? read({ ...request, openGroup: group.key }, group.key)
						)
					);
				})
			).then((chunks) => chunks.flat());
		const firstPage = async (
			read: (request: typeof base) => Promise<TextCorpusSearchPage>,
			readRows: (request: typeof base) => Promise<TextCorpusRowsPage>
		) => {
			const page = await read(base);
			const groups = page.groups?.entries ?? [];
			const fits =
				page.groups?.more === 0 &&
				groups.reduce((total, group) => total + group.count, 0) <= 50;
			const open = fits ? groups : groups.slice(0, 1);
			return {
				total: page.total,
				page,
				groups: await openGroupRows(
					base,
					open.map((group) => group.key),
					(request) => readRows(request)
				)
			};
		};
		if (stage === "build" || stage === "cached-reopen") {
			await measure(stage, async () => {
				ready(await run(workspace.configuredRefresh(true)), "completed");
				ready(await run(workspace.localizationTarget(target)));
				return firstPage(search, searchRows);
			});
		} else if (stage === "open") {
			await measure("open", async () => {
				const model = await run(
					steps
						.openCommitted({ projectRoot: options.project, targetName })
						.pipe(Effect.provideService(Scope.Scope, scope))
				);
				if (Option.isNone(model)) throw new Error("Built index not available.");
				return firstPage(
					(request) => run(model.value.query.search(request)),
					(request) => run(model.value.query.searchRows(request))
				);
			});
		} else {
			ready(await run(workspace.configuredRefresh(true)), "completed");
			ready(await run(workspace.localizationTarget(target)));
			if (
				stage === "quality" ||
				stage === "quality-default" ||
				stage === "quality-in-process"
			) {
				// Without a rules file nothing runs: `quality-default` previews the starter's checks.
				const document =
					stage === "quality-default"
						? STARTER_CHECK_RULES
						: await run(
								decodeGameTextRuleDocumentJson(
									await readFile(
										new URL("./game-text-engine-rules.json", import.meta.url),
										"utf8"
									)
								)
							);
				ready(await run(workspace.previewQualityRules(document)), "completed");
				await measure(stage, async () =>
					ready(await run(workspace.localizationQualitySearch({ target, filter: "all" })))
				);
			} else if (stage === "edit") {
				// A rescan after one package edit, as the Workbench runs it: the refresh evaluates the
				// previewed rules again. The first evaluation is outside the timer.
				const document = await run(
					decodeGameTextRuleDocumentJson(
						await readFile(
							new URL("./game-text-engine-rules.json", import.meta.url),
							"utf8"
						)
					)
				);
				ready(await run(workspace.previewQualityRules(document)), "completed");
				const { editRetainedRecords } = await import("./package-text-generated.ts");
				await editRetainedRecords(options.records!, records!);
				// The stage breakdown covers the rescan only, not the build before it.
				recorder?.reset();
				await measure("edit.refresh", async () =>
					ready(await run(workspace.configuredRefresh(true)), "completed")
				);
			} else if (stage === "loc-check" || stage === "lines-export") {
				// `loc check` and `loc export` as each commit's CLI runs them: the starter's checks
				// over the open snapshot printed to a file, and the all-languages CSV.
				const model = await run(
					steps
						.openCommitted({ projectRoot: options.project, targetName })
						.pipe(Effect.provideService(Scope.Scope, scope))
				);
				if (Option.isNone(model)) throw new Error("Built index not available.");
				const opened = model.value;
				const path = join(
					options.output,
					stage === "loc-check" ? "report.json" : "lines.csv"
				);
				await rm(path, { force: true });
				if (stage === "loc-check")
					await measure(stage, async () => {
						const file = createWriteStream(path);
						const write = (text: string) =>
							new Promise<void>((resolve, reject) =>
								file.write(text, (error) => (error ? reject(error) : resolve()))
							);
						let findings: number;
						// A build without the engine's writers runs the CLI it shipped.
						if (Reflect.has(opened, "prepareLocalizationCheck")) {
							const prepared = await run(
								opened.prepareLocalizationCheck(STARTER_CHECK_RULES, {})
							);
							await run(prepared.write((text) => Effect.promise(() => write(text))));
							findings = prepared.findings;
						} else {
							// That CLI built the whole report, then printed its members and each finding in turn.
							const report = await run(
								opened.localizationCheck(STARTER_CHECK_RULES, {})
							);
							let chunk = "";
							const piece = async (text: string) => {
								chunk += text;
								if (chunk.length >= 1 << 20) {
									await write(chunk);
									chunk = "";
								}
							};
							let separator = "{";
							for (const [key, value] of Object.entries(report)) {
								// The arrays are printed an element at a time: as one string they are
								// longer than a string can be.
								if (
									(key === "findings" || key === "checkDiagnostics") &&
									Array.isArray(value) &&
									value.length > 0
								) {
									await piece(`${separator}\n\t${JSON.stringify(key)}: [`);
									for (const [at, item] of value.entries())
										await piece(
											`${at ? "," : ""}\n\t\t${JSON.stringify(item, null, "\t").replaceAll("\n", "\n\t\t")}`
										);
									await piece("\n\t]");
								} else {
									const text = JSON.stringify(value, null, "\t");
									if (text === undefined) continue;
									await piece(
										`${separator}\n\t${JSON.stringify(key)}: ${text.replaceAll("\n", "\n\t")}`
									);
								}
								separator = ",";
							}
							await write(`${chunk}\n}\n`);
							findings = report.findings.length;
						}
						await new Promise<void>((resolve) => file.end(resolve));
						return { rowCount: findings, bytes: (await stat(path)).size };
					});
				else
					await measure(stage, async () => {
						const request = {
							query: "",
							capability: "all" as const,
							localization: { target }
						};
						if (Reflect.has(opened.query, "writeLocalizationLinesCsv")) {
							const written = await run(
								opened.query.writeLocalizationLinesCsv(request, { path })
							);
							return { rowCount: "rows" in written ? written.rows : -1 };
						}
						const lines = await run(
							opened.query.selectLocalizationLines(
								request,
								LOCALIZATION_LINES_CSV_FIELDS
							)
						);
						const { csv, rows } = localizationLinesCsv({
							join: opened.localization,
							lines
						});
						await writeFile(path, csv, { flag: "wx" });
						return { rowCount: rows };
					});
			} else if (stage === "engine-load") {
				// The engine under load: a keystroke while rules evaluate, cancel latency, a 5,000-row
				// findings page, and its resident memory with one snapshot open.
				const { childWorkingSet } = await import("./game-text-scale-safety.ts");
				const captured = await run(
					decodeGameTextRuleDocumentJson(
						await readFile(
							new URL("./game-text-engine-rules.json", import.meta.url),
							"utf8"
						)
					)
				);
				// The same work under a new document key: one optional argument nothing names.
				let fresh = 0;
				const freshRules = () => ({
					...captured,
					rules: captured.rules.map((rule) =>
						rule.kind === "format_arguments"
							? {
									...rule,
									params: {
										...rule.params,
										optionalArguments: [`BenchmarkUnused${++fresh}`]
									}
								}
							: rule
					)
				});
				const prefixes = mix.queries.flatMap((query) =>
					Array.from({ length: query.length }, (_, length) => query.slice(0, length + 1))
				);
				const header = (prefix: string) =>
					search(
						Schema.decodeUnknownSync(TextCorpusSearchRequest)({
							...base,
							query: prefix
						})
					);
				for (const [index, prefix] of prefixes.entries())
					await measure(`idle:${index}`, () => header(prefix));
				// Keystrokes while the workspace previews rules, the prefixes again and again.
				for (let repeat = 0; repeat < 2; repeat++) {
					const preview = Effect.runFork(workspace.previewQualityRules(freshRules()));
					let index = 0;
					while (preview.pollUnsafe() === undefined) {
						const prefix = prefixes[index % prefixes.length]!;
						await measure(`contended:${repeat}:${index++}`, () => header(prefix));
					}
					ready(await run(Fiber.join(preview)), "completed");
				}
				const model = await run(
					steps
						.openCommitted({ projectRoot: options.project, targetName })
						.pipe(Effect.provideService(Scope.Scope, scope))
				);
				if (Option.isNone(model)) throw new Error("Built index not available.");
				const query = model.value.query;
				// The same bulk read with nothing to cancel, which a cancel's latency is measured over.
				const nothing = () =>
					run(
						query.exportWithSignals({
							query: "\u{10ffff}no match\u{10ffff}",
							capability: "all"
						})
					).then(({ corpus }) => ({ rowCount: corpus.units.length }));
				for (let repeat = 0; repeat < 5; repeat++)
					await measure(`idle-free:${repeat}`, nothing);
				// Interrupting an evaluation, and an export of every unit, a second into each.
				const cancel = async (id: string, start: () => Effect.Effect<unknown, unknown>) => {
					const fiber = Effect.runFork(start());
					await new Promise((resolve) => setTimeout(resolve, 1000));
					if (fiber.pollUnsafe() !== undefined) throw new Error(`${id} finished first.`);
					// Until the interrupt returns, and until the engine answers the next bulk read:
					// an export that matches nothing.
					await measure(id, async () => {
						await run(Fiber.interrupt(fiber));
						await measure(`${id}:free`, nothing);
						return { status: "ok" };
					});
				};
				for (let repeat = 0; repeat < 5; repeat++) {
					await cancel(`cancel:evaluation:${repeat}`, () =>
						query.findingsEvaluate(effectiveRuleDocument(freshRules()))
					);
					await cancel(`cancel:export:${repeat}`, () =>
						query.exportWithSignals({ query: "", capability: "all" })
					);
				}
				// A 5,000-row findings page over the captured rules' layer.
				const { key } = await run(query.findingsEvaluate(effectiveRuleDocument(captured)));
				for (let repeat = 0; repeat < 10; repeat++)
					await measure(`findings-page:${repeat}`, () =>
						run(
							query.findingsQuery({
								key,
								view: "workspace",
								order: "severity",
								offset: 0,
								limit: 5000
							})
						)
					);
				// The engine's resident memory: the worker's descendants with one snapshot open.
				const engineBytes = async () =>
					(await childWorkingSet(process.pid, true)) -
					(await childWorkingSet(process.pid, false));
				await measure("resident:open", async () => ({ rowCount: await engineBytes() }));
				// After a bulk read every build can answer: 5,000 lines' projected fields. A build
				// whose export returns text can't hold every unit of the larger projects in one string.
				const { group: _group, facets: _facets, ...plain } = base;
				const lines: string[] = [];
				let page = await run(query.search(plain));
				for (;;) {
					lines.push(...(page.localization?.lines ?? []).map((line) => line.id));
					const cursor = page.localization?.nextCursor;
					if (!cursor || lines.length >= 5000) break;
					page = await run(query.search({ ...plain, localizationCursor: cursor }));
				}
				await run(
					query.selectLocalizationLines(
						Schema.decodeUnknownSync(TextCorpusSearchRequest)({
							...plain,
							lines: lines.slice(0, 5000)
						}),
						LOCALIZATION_LINES_CSV_FIELDS
					)
				);
				await measure("resident:after-bulk-read", async () => ({
					rowCount: await engineBytes()
				}));
			} else if (stage === "overhead") {
				const model = await run(
					steps
						.openCommitted({ projectRoot: options.project, targetName })
						.pipe(Effect.provideService(Scope.Scope, scope))
				);
				if (Option.isNone(model)) throw new Error("Built index not available.");
				const query = model.value.query;
				const { group: _group, ...flat } = base;
				const { facets: _facets, ...plain } = flat;
				const ids: NonNullable<
					TextCorpusSearchPage["localization"]
				>["lines"][number]["id"][] = [];
				let request = plain;
				while (ids.length < 5000) {
					const page = await run(query.search(request));
					ids.push(...(page.localization?.lines ?? []).map((line) => line.id));
					const cursor = page.localization?.nextCursor;
					if (!cursor) break;
					request = { ...plain, localizationCursor: cursor };
				}
				if (scenarioHost !== "small")
					await run(
						query.selectLocalizationLines(
							{ ...plain, lines: ids.slice(0, 1) },
							LOCALIZATION_LINES_CSV_FIELDS
						)
					);
				for (let repeat = 0; repeat < 30; repeat++)
					await measure(`small:${repeat}`, () => run(query.search(flat)));
				if (scenarioHost !== "small") {
					const observeBulk = async <A>(read: () => Promise<A>) => {
						try {
							return await read();
						} catch (cause) {
							console.error(cause);
							return {
								status: "failed" as const,
								message: cause instanceof Error ? cause.message : String(cause)
							};
						}
					};
					await measure("medium", () =>
						observeBulk(() =>
							run(
								query.selectLocalizationLines(
									{ ...plain, lines: ids.slice(0, 5000) },
									LOCALIZATION_LINES_CSV_FIELDS
								)
							)
						)
					);
				}
			} else if (stage === "typing") {
				for (const host of mix.hosts.filter(
					(host) =>
						!scenarioHost ||
						(host.name === scenarioHost && host.openGroups === scenarioGroups)
				))
					for (const query of mix.queries)
						for (let length = 1; length <= query.length; length++) {
							const prefix = query.slice(0, length);
							const id = `${host.name}:${host.openGroups}:${query}:${length}`;
							const request = Schema.decodeUnknownSync(TextCorpusSearchRequest)(
								host.excludeEditor
									? {
											...base,
											query: prefix,
											filter: [
												{
													field: "audience",
													op: "is_not",
													values: ["editor"]
												}
											]
										}
									: { ...base, query: prefix }
							);
							let fanout = 1;
							await measure(
								`keystroke:${id}`,
								async () => {
									const page = await measure(`request:${id}:header`, () =>
										search(request)
									);
									const groups = page.groups?.entries ?? [];
									const fits =
										page.groups?.more === 0 &&
										groups.reduce((n, group) => n + group.count, 0) <= 50;
									const open =
										host.openGroups === "all" || fits
											? groups
											: groups.slice(0, 1);
									const replies = await openGroupRows(
										request,
										open.map((group) => group.key),
										(read, label) => {
											fanout++;
											return measure(`request:${id}:${label}`, () =>
												searchRows(read)
											);
										}
									);
									return { page, groups: replies };
								},
								() => fanout
							);
						}
			} else if (stage === "selection") {
				const { group: _group, ...ungrouped } = base;
				const page = await search(ungrouped);
				const unit = page.units.find((unit) => unit.occurrenceCount > 0) ?? page.units[0];
				if (!unit) throw new Error("No row available for selection.");
				const line = page.localization?.lines[0];
				if (scenarioHost === "electroswag-worst") {
					const { selection } = mix;
					const seed = expectFound(
						await run(workspace.focus({ id: unit.id, pageSize: selection.pageSize })),
						"seed focus"
					);
					const files = [
						...new Set(seed.focus.occurrences.map((place) => place.packageFile))
					];
					const pooled = async <A, B>(
						items: readonly A[],
						read: (item: A) => Promise<B>
					) => {
						const values: B[] = [];
						let next = 0;
						await Promise.all(
							Array.from(
								{ length: Math.min(selection.concurrency, items.length) },
								async () => {
									for (let index = next++; index < items.length; index = next++)
										values[index] = await read(items[index]!);
								}
							)
						);
						return values;
					};
					const related =
						selection.causeSearchPages +
						selection.relatedLines +
						selection.relatedLines * (1 + selection.relatedLines);
					await measure(
						"electroswag:saturated-related",
						async () => {
							const causePages: TextCorpusSearchPage[] = [];
							for (let index = 0; index < selection.causeSearchPages; index++) {
								const previousCursor = causePages.at(-1)?.nextCursor;
								const cursor = previousCursor
									? { cursor: previousCursor }
									: undefined;
								causePages.push(
									await search(
										Schema.decodeUnknownSync(TextCorpusSearchRequest)({
											query: "",
											capability: "all",
											pageSize: selection.pageSize,
											filter: [
												{
													field: "fact",
													op: "is",
													values: ["conflicting"]
												},
												{ field: "asset", op: "is", values: files }
											],
											...cursor
										})
									)
								);
							}
							const ids = causePages.flatMap((page) =>
								page.units.map((unit) => unit.id)
							);
							const saturated = Array.from(
								{ length: selection.relatedLines },
								(_, index) => ids[index % Math.max(1, ids.length)] ?? unit.id
							);
							const focuses = await pooled(saturated, async (id) =>
								expectFound(
									await run(
										workspace.focus({ id, pageSize: selection.pageSize })
									),
									"related focus"
								)
							);
							const sameKeys = await pooled(focuses, async ({ focus: found }) => {
								const identity = gatheredTextIdentity(
									TextUnit.make({
										id: found.unit.id,
										source: found.unit.source,
										identity: found.unit.identity,
										occurrences: found.occurrences
									})
								);
								const key = identity
									? gatheredIdentityKey(identity)
									: JSON.stringify(["", ""]);
								const page = await search(
									Schema.decodeUnknownSync(TextCorpusSearchRequest)({
										query: "",
										capability: "all",
										pageSize: selection.keySearchPageSize,
										filter: [
											{ field: "translation_key", op: "is", values: [key] }
										]
									})
								);
								const ids = page.units
									.filter((other) => other.id !== found.unit.id)
									.map((other) => other.id);
								return {
									page,
									focuses: await pooled(
										Array.from(
											{ length: selection.relatedLines },
											(_, index) =>
												ids[index % Math.max(1, ids.length)] ??
												found.unit.id
										),
										async (id) =>
											expectFound(
												await run(
													workspace.focus({
														id,
														pageSize: selection.pageSize
													})
												),
												"same-key focus"
											)
									)
								};
							});
							// Saturate the host's bounds with existing IDs when the project has fewer partners.
							// This is an explicit load probe, not a claim that this project has 20×20 copies.
							return { saturated: true, causePages, focuses, sameKeys };
						},
						related
					);
					// The same review's evidence as one request: the unit's same key, same text,
					// conflict and key change, with every member's places and translations.
					await measure(
						"electroswag:related",
						async () =>
							expectFound(
								await run(
									workspace.related({
										target,
										selection: { kind: "unit", id: unit.id },
										pageSize: selection.pageSize
									})
								),
								"related"
							),
						1
					);
				}
				for (const host of ["workbench", "electroswag"].filter(
					(host) => !scenarioHost || host === scenarioHost
				))
					await measure(
						`${host}:selection`,
						() =>
							Promise.all([
								run(
									workspace.focus(
										line
											? {
													id: unit.id,
													pageSize: 50,
													localization: { target, id: line.id }
												}
											: { id: unit.id, pageSize: 50 }
									)
								).then((reply) => expectFound(reply, "focus")),
								run(
									workspace.localizationFocus({
										target,
										selection: line
											? { kind: "line", id: line.id }
											: { kind: "unit", id: unit.id }
									})
								).then((reply) => expectFound(reply, "detail"))
							]),
						2
					);
			} else throw new Error(`Unknown engine stage: ${options.stage}`);
		}
	} finally {
		clearInterval(timer);
		topic.unsubscribe(listener);
		sample();
		await run(Scope.close(scope, Exit.void));
		if (process.env.UE_SHED_GAME_TEXT_MEASURE_DIR)
			await writeFile(
				join(process.env.UE_SHED_GAME_TEXT_MEASURE_DIR, `ts-${process.pid}.ndjson`),
				timings.map((timing) => JSON.stringify(timing)).join("\n") + "\n"
			);
		if (recorder)
			await writeFile(
				join(options.output, "stages.json"),
				JSON.stringify(recorder.counts(), null, "\t")
			);
	}
	return {
		schemaVersion: 1 as const,
		stage: options.stage,
		node: process.version,
		peakHeapBytes,
		peakRssBytes,
		samples
	};
}

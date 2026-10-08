import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Metric,
	Queue,
	Result,
	Schema,
	Stream
} from "effect";
import {
	EngineInstallationDiscovery,
	EngineInstallationDiscoveryLive,
	OwnedProcessTree,
	OwnedProcessTreeLive,
	unrealEditorCommandletExecutable
} from "@ue-shed/engine";
import { parseLocalizationRecipe } from "./targets.js";
import { decodeText } from "./decode.js";
import { defaultLocalizationLimits } from "./schema.js";
import { planLocalizationOperation, localizationOperationError } from "./operation-plan.js";
import { parseLocalizationProgress, localizationExitFailure } from "./operation-progress.js";
import {
	isLocalizationFileMissing,
	localizationIOFailure,
	localizationProjectDescriptor,
	validateLocalizationOutputPath,
	readLocalizationConfig,
	snapshotLocalizationProject,
	readLocalizationLogChunk,
	localizationFileChanges
} from "./operation-io.js";
import {
	LocalizationEngine,
	LocalizationOperationError,
	LocalizationRunRequest,
	LocalizationOperationReceipt,
	type LocalizationOperationPlan,
	type LocalizationRunEvent
} from "./operation-schema.js";

export interface LocalizationOperationsApi {
	readonly plan: (
		request: LocalizationRunRequest
	) => Effect.Effect<LocalizationOperationPlan, LocalizationOperationError>;
	readonly run: (
		request: LocalizationRunRequest
	) => Stream.Stream<LocalizationRunEvent, LocalizationOperationError>;
}
export class LocalizationOperations extends Context.Service<
	LocalizationOperations,
	LocalizationOperationsApi
>()("@ue-shed/localization/LocalizationOperations") {}

export const LocalizationOperationsLive = Layer.effect(
	LocalizationOperations,
	Effect.gen(function* () {
		const engines = yield* EngineInstallationDiscovery;
		const processes = yield* OwnedProcessTree;
		const prepare = Effect.fn("LocalizationOperations.plan")(function* (
			input: LocalizationRunRequest
		) {
			const request = yield* Schema.decodeUnknownEffect(LocalizationRunRequest)(input).pipe(
				Effect.mapError(() => localizationOperationError("invalid_request"))
			);
			const projectRoot = resolve(request.projectRoot);
			const projectDescriptor = yield* Effect.tryPromise({
				try: () => localizationProjectDescriptor(projectRoot),
				catch: localizationIOFailure
			});
			const discovery = { projectDescriptor };
			if (request.explicitEngineRoot !== undefined)
				Object.assign(discovery, { explicitRoot: request.explicitEngineRoot });
			const installation = yield* engines.resolve(discovery).pipe(
				Effect.withTracerEnabled(false),
				Effect.mapError((error) =>
					localizationOperationError(
						error.code === "engine_ambiguous" ? "engine_ambiguous" : "engine_not_found"
					)
				)
			);
			const engine = yield* Schema.decodeUnknownEffect(LocalizationEngine)(
				`${installation.version.major}.${installation.version.minor}`
			).pipe(Effect.mapError(() => localizationOperationError("unsupported_engine")));
			const logPath = join(tmpdir(), "ue-shed-localization", randomUUID(), "Commandlet.log");
			const plan = yield* Effect.try({
				try: () =>
					planLocalizationOperation({
						operation: request.operation,
						target: request.target,
						engine,
						projectDescriptor,
						logPath
					}),
				catch: localizationIOFailure
			});
			for (const config of plan.configs) {
				const bytes = yield* Effect.tryPromise({
					try: () => readLocalizationConfig(projectRoot, config),
					catch: (error) =>
						isLocalizationFileMissing(error)
							? localizationOperationError("missing_config")
							: localizationIOFailure(error)
				});
				const parsed = yield* Effect.try({
					try: () =>
						parseLocalizationRecipe(
							decodeText(bytes, defaultLocalizationLimits),
							config
						),
					catch: () => localizationOperationError("unsupported_config")
				});
				if (Result.isFailure(parsed))
					return yield* Effect.fail(localizationOperationError("unsupported_config"));
				const prior = request.target.configs.find(
					(recipe) => recipe.relativePath === config
				);
				if (JSON.stringify(parsed.success) !== JSON.stringify(prior))
					return yield* Effect.fail(localizationOperationError("config_changed"));
			}
			for (const file of plan.files) {
				if (
					file.relativePath
						.split("/")
						.some((component) =>
							plan.auditExcludedDirectories.some(
								(directory) => directory.toLowerCase() === component.toLowerCase()
							)
						)
				)
					return yield* Effect.fail(localizationOperationError("unsupported_config"));
				yield* Effect.tryPromise({
					try: () => validateLocalizationOutputPath(projectRoot, file.relativePath),
					catch: localizationIOFailure
				});
			}
			yield* Effect.annotateCurrentSpan({
				operation: plan.operation,
				configs: plan.configs.length,
				steps: plan.steps.length,
				planned_files: plan.files.length
			});
			return { plan, installation, request };
		});
		const plan = Effect.fn("LocalizationOperations.planOnly")(
			(request: LocalizationRunRequest) =>
				prepare(request).pipe(Effect.map((prepared) => prepared.plan))
		);
		const execute = Effect.fn("LocalizationOperations.execute")(function* (
			input: LocalizationRunRequest,
			publish: (event: LocalizationRunEvent) => Effect.Effect<void>
		) {
			const { plan, installation, request } = yield* prepare(input);
			const root = dirname(plan.projectDescriptor);
			const executable = unrealEditorCommandletExecutable(
				installation.root,
				process.platform,
				installation.version
			);
			yield* Effect.tryPromise({
				try: () => access(executable),
				catch: () => localizationOperationError("commandlet_missing")
			});
			// A private directory is retained for explicit receipts/failures; no project log writes.
			yield* Effect.tryPromise({
				try: () => mkdir(dirname(plan.logPath), { recursive: true, mode: 0o700 }),
				catch: localizationIOFailure
			});
			const before = yield* Effect.tryPromise({
				try: () => snapshotLocalizationProject(root, plan),
				catch: localizationIOFailure
			});
			const started = yield* Clock.currentTimeMillis;
			const receipt = yield* Effect.scoped(
				Effect.gen(function* () {
					const handle = yield* Effect.acquireRelease(
						processes
							.launch({
								executable,
								args: plan.arguments,
								cwd: root,
								terminationTimeout: Duration.seconds(15)
							})
							.pipe(
								Effect.withTracerEnabled(false),
								Effect.mapError(() => localizationOperationError("launch_failed"))
							),
						(handle) =>
							handle.terminate("cancelled").pipe(
								Effect.withTracerEnabled(false),
								Effect.mapError(() =>
									localizationOperationError("termination_failed")
								),
								Effect.orDie
							)
					);
					yield* publish({
						schemaVersion: 1,
						type: "process_started",
						pid: handle.pid,
						logPath: plan.logPath
					});
					let offset = 0;
					const decoder = new TextDecoder();
					let pending = "";
					let activeConfig: string | undefined;
					const lines: string[] = [];
					const seen = new Set<string>();
					const consume = Effect.fn("LocalizationOperations.tail")(function* (
						finish = false
					) {
						for (;;) {
							const chunk = yield* Effect.tryPromise({
								try: () => readLocalizationLogChunk(plan.logPath, offset, decoder),
								catch: localizationIOFailure
							});
							const exhausted = chunk.offset === offset;
							offset = chunk.offset;
							const text = chunk.text + (finish && exhausted ? decoder.decode() : "");
							if (exhausted && !text && (!finish || !pending)) break;
							pending += text;
							const complete = pending.split(/\r?\n/u);
							pending = complete.pop() ?? "";
							if (finish && exhausted && pending) {
								complete.push(pending);
								pending = "";
							}
							if (pending.length > 8192) pending = pending.slice(-8192);
							for (const line of complete) {
								lines.push(line.slice(0, 2048));
								if (lines.length > 40) lines.shift();
								activeConfig =
									/Beginning GatherText Commandlet for '([^']+)'/u.exec(
										line
									)?.[1] ?? activeConfig;
								const progress = parseLocalizationProgress(
									line,
									plan,
									activeConfig
								);
								if (!progress) continue;
								const identity = `${progress.stepIndex}/${progress.phase}`;
								if (seen.has(identity)) continue;
								seen.add(identity);
								yield* publish(progress);
							}
							if (exhausted) break;
						}
					});
					const exit = yield* Effect.raceFirst(
						handle.awaitExit.pipe(
							Effect.withTracerEnabled(false),
							Effect.mapError(() => localizationOperationError("commandlet_failed"))
						),
						consume().pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.forever)
					).pipe(
						Effect.timeoutOrElse({
							duration: Duration.seconds(request.timeoutSeconds ?? 1800),
							orElse: () => Effect.fail(localizationOperationError("timeout"))
						}),
						Effect.mapError(
							(error) =>
								new LocalizationOperationError({
									code: error.code,
									message: error.message,
									recovery: error.recovery,
									retrySafe: false,
									logExcerpt: lines.slice(-40),
									logPath: plan.logPath
								})
						)
					);
					yield* consume(true);
					if (exit.kind === "terminated")
						return yield* Effect.fail(localizationOperationError("cancelled"));
					if (exit.exitCode !== 0)
						return yield* Effect.fail(
							localizationExitFailure(exit.exitCode, lines, plan.logPath)
						);
					// End any owned descendants before taking the final durable-file snapshot.
					yield* handle.terminate("cancelled").pipe(
						Effect.withTracerEnabled(false),
						Effect.mapError(() => localizationOperationError("termination_failed"))
					);
					const after = yield* Effect.tryPromise({
						try: () => snapshotLocalizationProject(root, plan),
						catch: localizationIOFailure
					});
					const changes = localizationFileChanges(before, after, plan);
					const diagnostics = changes
						.filter((change) => !change.planned)
						.map(
							(change) =>
								({
									code: "unplanned_file_change",
									relativePath: change.relativePath
								}) satisfies LocalizationOperationReceipt["diagnostics"][number]
						);
					const ended = yield* Clock.currentTimeMillis;
					return LocalizationOperationReceipt.make({
						schemaVersion: 1,
						type: "receipt",
						operation: plan.operation,
						target: plan.target,
						status: diagnostics.length ? "planning_defect" : "completed",
						durationMs: Math.max(0, Math.round(ended - started)),
						pid: handle.pid,
						logPath: plan.logPath,
						plan,
						changes,
						diagnostics
					});
				})
			).pipe(
				Effect.catchDefect((cause) =>
					cause instanceof LocalizationOperationError &&
					cause.code === "termination_failed"
						? Effect.fail(cause)
						: Effect.die(cause)
				)
			);
			yield* Effect.annotateCurrentSpan({
				operation: receipt.operation,
				duration_ms: receipt.durationMs,
				changed_files: receipt.changes.length,
				diagnostics: receipt.diagnostics.length
			});
			yield* Metric.update(
				Metric.counter("localization.operations.changed_files"),
				receipt.changes.length
			);
			return receipt;
		});
		return LocalizationOperations.of({
			plan,
			run: (request) =>
				Stream.callback<LocalizationRunEvent, LocalizationOperationError>(
					(queue) =>
						execute(request, (event) =>
							Queue.offer(queue, event).pipe(Effect.asVoid)
						).pipe(
							// Explicit failures contain private log lines. Trace only the handled boundary.
							Effect.withTracerEnabled(false),
							Effect.flatMap((receipt) =>
								Effect.annotateCurrentSpan({
									operation: receipt.operation,
									duration_ms: receipt.durationMs,
									configs: receipt.plan.configs.length,
									steps: receipt.plan.steps.length,
									planned_files: receipt.plan.files.length,
									changed_files: receipt.changes.length,
									diagnostics: receipt.diagnostics.length
								}).pipe(Effect.andThen(Queue.offer(queue, receipt)))
							),
							Effect.andThen(Queue.end(queue)),
							Effect.catch((error) =>
								Metric.update(
									Metric.counter("localization.operations.failures"),
									1
								).pipe(
									Effect.andThen(
										Effect.annotateCurrentSpan({ code: error.code })
									),
									Effect.andThen(Queue.fail(queue, error))
								)
							),
							Effect.withSpan("LocalizationOperations.run")
						),
					{ bufferSize: 64, strategy: "suspend" }
				)
		});
	})
);
export const LocalizationOperationsNodeLive = LocalizationOperationsLive.pipe(
	Layer.provide(EngineInstallationDiscoveryLive),
	Layer.provide(OwnedProcessTreeLive)
);

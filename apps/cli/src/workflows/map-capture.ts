import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { CliCommandError, CliRuntime, messageOf, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type Command<Tag extends CliCommand["_tag"]> = Extract<CliCommand, { readonly _tag: Tag }>;

function commandError(cause: unknown): CliCommandError {
	return new CliCommandError({ message: messageOf(cause) });
}

const ExplicitTiles = Schema.Array(
	Schema.Struct({
		column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		row: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		zoom: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
).check(Schema.isMinLength(1));

function readExplicitTiles(path: string) {
	return Effect.tryPromise({
		try: async () => JSON.parse(await readFile(path, "utf8")) as unknown,
		catch: commandError
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ExplicitTiles)),
		Effect.mapError(commandError)
	);
}

export const runMapCapturePlanValidate = Effect.fn("Cli.workflow.map_capture.plan_validate")(
	(command: Command<"MapCapturePlanValidate">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					MapCaptureRepository,
					MapCaptureRepositoryLive,
					validateMapCaptureProjectRoot
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				return yield* Effect.gen(function* () {
					const projectRoot = yield* validateMapCaptureProjectRoot(command.projectRoot);
					const repository = yield* MapCaptureRepository;
					const plan = yield* repository.loadPlan(command.planPath);
					return yield* printJson({
						contract: plan.contract,
						mapPath: plan.project.mapPath,
						planId: plan.id,
						projectRoot,
						status: "valid"
					});
				}).pipe(Effect.provide(MapCaptureRepositoryLive), Effect.mapError(commandError));
			})
		)
);

export const runMapCaptureInspect = Effect.fn("Cli.workflow.map_capture.inspect")(
	(command: Command<"MapCaptureInspect">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					inspectMapCapturePlan,
					MapCaptureRepository,
					MapCaptureRepositoryLive,
					validateMapCaptureProjectRoot
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				return yield* Effect.gen(function* () {
					const projectRoot = yield* validateMapCaptureProjectRoot(command.projectRoot);
					const repository = yield* MapCaptureRepository;
					const plan = yield* repository.loadPlan(command.planPath);
					const inspection = yield* inspectMapCapturePlan(plan);
					return yield* printJson({
						grid: inspection.grid,
						planId: plan.id,
						projectRoot,
						tileCount: inspection.tileCount
					});
				}).pipe(Effect.provide(MapCaptureRepositoryLive), Effect.mapError(commandError));
			})
		)
);

export const runMapCaptureRun = Effect.fn("Cli.workflow.map_capture.run")(
	(command: Command<"MapCaptureRun">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { runMapCapture } = yield* Effect.promise(() => import("@ue-shed/cameras"));
				const tiles = command.tilesPath
					? yield* readExplicitTiles(command.tilesPath)
					: undefined;
				const outcome = yield* runMapCapture({
					...(command.correlationId === undefined
						? {}
						: { correlationId: command.correlationId }),
					endpoint: command.endpoint,
					...(command.levels === undefined ? {} : { levels: command.levels }),
					planPath: command.planPath,
					projectRoot: command.projectRoot,
					...(tiles === undefined ? {} : { tiles })
				}).pipe(Effect.mapError(commandError));
				yield* printJson(outcome);
				if (!outcome.published) {
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(3);
				}
			})
		)
);

export const runMapCaptureRuns = Effect.fn("Cli.workflow.map_capture.runs")(
	(command: Command<"MapCaptureRuns">) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const {
					MapCaptureRepository,
					MapCaptureRepositoryLive,
					validateMapCaptureProjectRoot
				} = yield* Effect.promise(() => import("@ue-shed/cameras"));
				return yield* Effect.gen(function* () {
					const projectRoot = yield* validateMapCaptureProjectRoot(command.projectRoot);
					const repository = yield* MapCaptureRepository;
					return yield* repository
						.listRuns({ planId: command.planId, projectRoot })
						.pipe(Effect.flatMap(printJson));
				}).pipe(Effect.provide(MapCaptureRepositoryLive), Effect.mapError(commandError));
			})
		)
);

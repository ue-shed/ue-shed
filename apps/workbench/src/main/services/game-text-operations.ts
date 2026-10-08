import {
	OperationRelativePath,
	WorkbenchOperationProgress,
	type WorkbenchOperationFailure,
	type WorkbenchOperationFilesRequest,
	type WorkbenchOperationFilesResult,
	type WorkbenchOperationPlan,
	type WorkbenchOperationPlanResult,
	type WorkbenchOperationRequest,
	type WorkbenchOperationResult,
	type WorkbenchOperationState
} from "@ue-shed/game-text";
import {
	LocalizationOperations,
	LocalizationOperationError,
	availableLocalizationOperations,
	localizationOperationError,
	type LocalizationOperationPlan,
	type LocalizationOperationReceipt,
	type LocalizationRunRequest,
	type LocalizationTarget,
	type LocalizationTargetName
} from "@ue-shed/localization";
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Ref,
	Result,
	Schema,
	Stream
} from "effect";
import { randomUUID } from "node:crypto";
import { WorkbenchWindow } from "../adapters/electron-window.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";
import { WorkbenchGameText } from "./game-text.js";

export interface WorkbenchGameTextOperationsApi {
	readonly state: (target: LocalizationTargetName) => Effect.Effect<WorkbenchOperationState>;
	readonly plan: (
		request: WorkbenchOperationRequest
	) => Effect.Effect<WorkbenchOperationPlanResult>;
	readonly run: (id: string) => Effect.Effect<WorkbenchOperationResult>;
	readonly cancel: (id: string) => Effect.Effect<WorkbenchOperationResult>;
	readonly files: (
		request: WorkbenchOperationFilesRequest
	) => Effect.Effect<WorkbenchOperationFilesResult>;
}
export class WorkbenchGameTextOperations extends Context.Service<
	WorkbenchGameTextOperations,
	WorkbenchGameTextOperationsApi
>()("@ue-shed/workbench/WorkbenchGameTextOperations") {}

/** Log excerpts are diagnostic prose only. Never forward paths, credentials or full logs. */
export function safeLocalizationLogLine(line: string): string {
	if (/password|authorization|credential|secret|(?:access|refresh)[_-]?token/iu.test(line))
		return "[Sensitive diagnostic omitted]";
	return line
		.replace(/(?:[A-Za-z]:[\\/]|\\\\|(?<![\w:])\/)[^\s"<>|]+/gu, "[path]")
		.replace(/[\u0000-\u0008\u000b-\u001f]/gu, "")
		.slice(0, 2048);
}
function failed(code: string, message: string, recovery: string): WorkbenchOperationFailure {
	return { status: "failed", code, message, recovery, details: [] };
}
const failureMessages = {
	invalid_request: "The Unreal step request is invalid.",
	unsupported_engine: "This project's Unreal Engine version is not supported.",
	engine_not_found: "Unreal Engine could not be found for this project.",
	engine_ambiguous: "Several Unreal Engine installations match this project.",
	missing_config: "This target has no configuration for that Unreal step.",
	unsupported_operation: "This target does not support that Unreal step.",
	unsupported_config: "This target's configuration uses unsupported Unreal steps.",
	unsafe_path: "The target's output paths are unsafe.",
	project_missing: "The selected project has no readable Unreal project file.",
	project_ambiguous: "The selected folder contains several Unreal project files.",
	commandlet_missing: "This engine installation is missing Unreal's commandlet executable.",
	launch_failed: "Unreal could not be started.",
	commandlet_failed: "Unreal could not finish this step.",
	project_locked: "The project is locked by another Unreal process.",
	timeout: "The Unreal step timed out.",
	cancelled: "The Unreal step was cancelled.",
	termination_failed: "Unreal could not be stopped.",
	io_failed: "The project's localization files could not be read or updated.",
	limit_exceeded: "The project exceeds the limits for this Unreal step.",
	config_changed: "The target's configuration changed after the file list was prepared.",
	target_not_found: "The selected localization target was not found."
} satisfies Record<LocalizationOperationError["code"], string>;
function failure(error: LocalizationOperationError): WorkbenchOperationFailure {
	const recovery =
		error.code === "engine_not_found" || error.code === "engine_ambiguous"
			? "Install the engine associated with this project, or set UE_SHED_UNREAL_ENGINE_ROOT before starting Workbench."
			: error.code === "termination_failed"
				? "Stop the remaining Unreal process and restart Workbench before retrying. Check the project files first."
				: error.recovery;
	return {
		status: "failed",
		code: error.code,
		message: safeLocalizationLogLine(
			error.message === localizationOperationError(error.code).message
				? failureMessages[error.code]
				: error.message
		),
		recovery: safeLocalizationLogLine(recovery),
		details: error.logExcerpt.slice(-40).map(safeLocalizationLogLine)
	};
}
const busy = () =>
	failed(
		"busy",
		"A scan or Unreal step is already running.",
		"Cancel it or wait before starting another step."
	);
const stale = () =>
	failed(
		"stale_plan",
		"This confirmation is no longer current.",
		"Select the target and open Unreal steps again to review a new file list."
	);

interface RetainedPlan {
	readonly used: boolean;
	readonly view: WorkbenchOperationPlan;
	readonly request: LocalizationRunRequest;
	readonly plan: LocalizationOperationPlan;
	readonly generation: number;
}
interface RetainedReceipt {
	readonly id: string;
	readonly projectRoot: string;
	readonly receipt: LocalizationOperationReceipt;
	readonly result: WorkbenchOperationResult;
}
/** Compare only execution inputs; each planning call allocates a different private log path. */
function planInputs(plan: LocalizationOperationPlan): string {
	return JSON.stringify({
		operation: plan.operation,
		target: plan.target,
		engine: plan.engine,
		projectDescriptor: plan.projectDescriptor,
		configs: plan.configs,
		steps: plan.steps,
		files: plan.files,
		wholeRecipe: plan.wholeRecipe
	});
}

export const WorkbenchGameTextOperationsLive = Layer.effect(
	WorkbenchGameTextOperations,
	Effect.gen(function* () {
		const runner = yield* LocalizationOperations;
		const gameText = yield* WorkbenchGameText;
		const project = yield* WorkbenchProject;
		const configuration = yield* WorkbenchConfiguration;
		const window = yield* WorkbenchWindow;
		const scope = yield* Effect.scope;
		const confirmation = yield* Ref.make<RetainedPlan | undefined>(undefined);
		const receipt = yield* Ref.make<RetainedReceipt | undefined>(undefined);
		const progress = yield* Ref.make<WorkbenchOperationProgress | undefined>(undefined);
		const lastResult = yield* Ref.make<
			| {
					projectRoot: string;
					target: LocalizationTargetName;
					result: WorkbenchOperationResult;
			  }
			| undefined
		>(undefined);
		const capabilities = yield* Ref.make<
			| {
					target: LocalizationTarget;
					operations: WorkbenchOperationState["operations"];
			  }
			| undefined
		>(undefined);
		const active = yield* Ref.make<
			| {
					id: string;
					fiber: Fiber.Fiber<void>;
					done: Deferred.Deferred<WorkbenchOperationResult>;
			  }
			| undefined
		>(undefined);
		const publish = (value: WorkbenchOperationProgress) =>
			Effect.gen(function* () {
				yield* Ref.set(progress, value);
				const current = yield* project.current();
				const saved = yield* Ref.get(confirmation);
				if (
					current.status !== "ready" ||
					current.project.projectRoot !== saved?.request.projectRoot
				)
					return;
				yield* window
					.send(
						"game-text:localization:operation-progress",
						Schema.encodeSync(WorkbenchOperationProgress)(value)
					)
					.pipe(Effect.ignore);
			});
		const authorized = (saved: RetainedPlan) =>
			Effect.gen(function* () {
				const current = yield* project.current();
				return (
					current.status === "ready" &&
					current.project.projectRoot === saved.request.projectRoot &&
					(current.project.generation ?? 0) === saved.generation &&
					(yield* gameText.operationTarget(saved.view.target)) === saved.request.target
				);
			});
		const state = Effect.fn("Workbench.GameText.operations.state")(function* (
			target: LocalizationTargetName
		): Effect.fn.Return<WorkbenchOperationState> {
			const selected = yield* gameText.operationTarget(target);
			const current = yield* project.current();
			const pending = yield* Ref.get(progress);
			const last = yield* Ref.get(lastResult);
			const reason = yield* gameText.operationBusyReason();
			let available = yield* Ref.get(capabilities);
			if (selected && available?.target !== selected) {
				available = {
					target: selected,
					operations: availableLocalizationOperations(selected)
				};
				yield* Ref.set(capabilities, available);
			}
			return {
				operations: selected ? (available?.operations ?? []) : [],
				wholeRecipe: selected?.source === "config_only",
				...(reason ? { busyReason: reason } : undefined),
				...(pending &&
				current.status === "ready" &&
				(yield* Ref.get(confirmation))?.request.projectRoot === current.project.projectRoot
					? { progress: pending }
					: undefined),
				...(last &&
				current.status === "ready" &&
				last.target === target &&
				last.projectRoot === current.project.projectRoot
					? { result: last.result }
					: undefined)
			};
		});
		const plan = Effect.fn("Workbench.GameText.operations.plan")(function* (
			request: WorkbenchOperationRequest
		): Effect.fn.Return<WorkbenchOperationPlanResult> {
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (!(yield* gameText.beginOperation())) return busy();
					return yield* restore(
						Effect.gen(function* () {
							const current = yield* project.current();
							const target = yield* gameText.operationTarget(request.target);
							if (current.status !== "ready" || !target) return stale();
							const engineRoot = configuration.unrealEngineRoot;
							const runRequest: LocalizationRunRequest = {
								operation: request.operation,
								target,
								projectRoot: current.project.projectRoot,
								...(engineRoot?.status === "configured"
									? { explicitEngineRoot: engineRoot.path }
									: undefined)
							};
							const prepared = yield* runner.plan(runRequest);
							for (const file of prepared.files)
								yield* Schema.decodeUnknownEffect(OperationRelativePath)(
									file.relativePath
								).pipe(
									Effect.mapError(() => localizationOperationError("unsafe_path"))
								);
							const view: WorkbenchOperationPlan = {
								id: randomUUID(),
								target: prepared.target,
								operation: prepared.operation,
								engine: prepared.engine,
								wholeRecipe: prepared.wholeRecipe,
								steps: prepared.steps.map((step) => step.kind),
								fileCount: prepared.files.length
							};
							const saved = {
								view,
								request: runRequest,
								plan: prepared,
								used: false,
								generation: current.project.generation ?? 0
							};
							if (!(yield* authorized(saved))) return stale();
							yield* Ref.set(confirmation, saved);
							return { status: "ready" as const, plan: view };
						}).pipe(Effect.catch((error) => Effect.succeed(failure(error))))
					).pipe(Effect.ensuring(gameText.endOperation()));
				})
			);
		});
		const run = Effect.fn("Workbench.GameText.operations.run")(function* (
			id: string
		): Effect.fn.Return<WorkbenchOperationResult> {
			return yield* Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (yield* Ref.get(active)) return busy();
					const saved = yield* Ref.get(confirmation);
					if (!saved || saved.used || saved.view.id !== id || !(yield* authorized(saved)))
						return stale();
					if (!(yield* gameText.beginOperation())) return busy();
					yield* Ref.set(confirmation, { ...saved, used: true });
					const done = yield* Deferred.make<WorkbenchOperationResult>();
					const initial: WorkbenchOperationProgress = {
						id,
						target: saved.view.target,
						operation: saved.view.operation,
						phase: "starting",
						stepIndex: 0,
						stepTotal: saved.view.steps.length
					};
					const execute = Effect.gen(function* () {
						const nextPlan = yield* runner.plan(saved.request);
						if (
							planInputs(nextPlan) !== planInputs(saved.plan) ||
							!(yield* authorized(saved))
						)
							return stale();
						const before = yield* gameText.localizationTarget(saved.view.target);
						if (nextPlan.steps.some((step) => step.kind.startsWith("gather_")))
							yield* gameText.localizationBeforeGather(saved.view.target);
						const received = yield* Ref.make<LocalizationOperationReceipt | undefined>(
							undefined
						);
						yield* runner.run(saved.request).pipe(
							Stream.runForEach((event) => {
								if (event.type === "progress")
									return publish({
										...initial,
										phase: "running",
										stepIndex: event.stepIndex,
										stepTotal: event.stepTotal,
										kind: event.kind
									});
								if (event.type === "receipt") return Ref.set(received, event);
								return Effect.void;
							})
						);
						const result = yield* Ref.get(received);
						if (!result)
							return failed(
								"missing_receipt",
								"Unreal returned no result.",
								"Check the project files before retrying."
							);
						yield* publish({ ...initial, phase: "refreshing" });
						// A whole config recipe may gather even when the selected action was import/sync.
						const gathered =
							saved.view.operation === "gather" ||
							result.plan.steps.some((step) => step.kind.startsWith("gather_"));
						const refreshed = (yield* authorized(saved))
							? yield* gameText.refreshAfterOperation(saved.view.target, gathered)
							: false;
						const after = yield* gameText.localizationTarget(saved.view.target);
						const imported = result.plan.steps.some((step) => step.kind === "import");
						const completed: WorkbenchOperationResult = {
							status: "completed",
							receipt: {
								id,
								target: result.target,
								operation: result.operation,
								changedFiles: result.changes.length,
								unplannedFiles: result.changes.filter((file) => !file.planned)
									.length,
								translationsImported:
									imported &&
									before.status === "ready" &&
									after.status === "ready"
										? Math.max(0, before.notSynced - after.notSynced)
										: 0,
								refreshed
							}
						};
						yield* Ref.set(receipt, {
							id,
							projectRoot: saved.request.projectRoot,
							receipt: result,
							result: completed
						});
						yield* Effect.annotateCurrentSpan({
							changedFileCount: result.changes.length
						});
						return completed;
					}).pipe(Effect.catch((error) => Effect.succeed(failure(error))));
					const complete = execute.pipe(
						Effect.onExit((exit) =>
							Effect.gen(function* () {
								const stopped = Exit.isFailure(exit)
									? Cause.findDefect(exit.cause)
									: undefined;
								const terminationError =
									stopped &&
									Result.isSuccess(stopped) &&
									stopped.success instanceof LocalizationOperationError
										? stopped.success
										: undefined;
								const result: WorkbenchOperationResult = Exit.isSuccess(exit)
									? exit.value
									: terminationError
										? failure(terminationError)
										: Exit.hasInterrupts(exit)
											? { status: "cancelled" }
											: failed(
													"unexpected_failure",
													"The Unreal step stopped unexpectedly.",
													"Check the project files before retrying."
												);
								yield* Ref.set(lastResult, {
									projectRoot: saved.request.projectRoot,
									target: saved.view.target,
									result
								});
								yield* Ref.set(progress, undefined);
								yield* Ref.set(active, undefined);
								// Failed termination cannot honestly admit another process or a scan.
								if (
									result.status !== "failed" ||
									result.code !== "termination_failed"
								)
									yield* gameText.endOperation();
								yield* Effect.annotateCurrentSpan({
									outcomeCode:
										result.status === "failed" ? result.code : result.status
								});
								yield* Deferred.succeed(done, result);
							})
						),
						Effect.asVoid,
						// The exit above has delivered the safe result and completed owned cleanup.
						Effect.catchCause(() => Effect.void)
					);
					yield* publish(initial);
					const fiber = yield* complete.pipe(
						Effect.forkIn(scope, {
							startImmediately: false,
							uninterruptible: false
						})
					);
					yield* Ref.set(active, { id, fiber, done });
					return yield* restore(Deferred.await(done));
				})
			);
		});
		const cancel = Effect.fn("Workbench.GameText.operations.cancel")(function* (id: string) {
			const current = yield* Ref.get(active);
			if (!current || current.id !== id) return stale();
			// Wait for OwnedProcessTree's termination finalizer before admitting another scan/run.
			yield* Fiber.interrupt(current.fiber);
			return yield* Deferred.await(current.done);
		});
		const files = Effect.fn("Workbench.GameText.operations.files")(function* (
			request: WorkbenchOperationFilesRequest
		): Effect.fn.Return<WorkbenchOperationFilesResult> {
			const saved = yield* Ref.get(confirmation);
			const completed = yield* Ref.get(receipt);
			const current = yield* project.current();
			if (current.status !== "ready") return stale();
			const offset = request.offset ?? 0;
			const source =
				request.kind === "planned"
					? saved?.view.id === request.id && (yield* authorized(saved))
						? {
								total: saved.plan.files.length,
								files: saved.plan.files.slice(offset, offset + 50).map((file) => ({
									path: file.relativePath,
									planned: true
								}))
							}
						: undefined
					: completed?.id === request.id &&
						  completed.projectRoot === current.project.projectRoot
						? {
								total: completed.receipt.changes.length,
								files: completed.receipt.changes
									.slice(offset, offset + 50)
									.map((file) => ({
										path: file.relativePath,
										planned: file.planned
									}))
							}
						: undefined;
			if (!source) return stale();
			const page = source.files;
			if (
				page.some((file) =>
					Result.isFailure(Schema.decodeUnknownResult(OperationRelativePath)(file.path))
				)
			)
				return failed(
					"unsafe_path",
					"The file list contains an unsafe path.",
					"Review the operation from the CLI."
				);
			return {
				status: "ready",
				files: page,
				total: source.total,
				...(offset + page.length < source.total
					? { nextOffset: offset + page.length }
					: undefined)
			};
		});
		return WorkbenchGameTextOperations.of({ state, plan, run, cancel, files });
	})
);

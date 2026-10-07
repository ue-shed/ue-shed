import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Deferred, Effect, Fiber, Layer, Ref, Result, Schema, Stream } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	discoverLocalizationTargets,
	planLocalizationOperation,
	LocalizationOperations,
	localizationOperationError,
	LocalizationOperationError,
	type LocalizationOperationsApi,
	type LocalizationRunEvent,
	type LocalizationOperationReceipt,
	type LocalizationOperationPlan,
	type LocalizationRunRequest
} from "@ue-shed/localization";
import { WorkbenchOperationProgress, WorkbenchOperationPlanResult } from "@ue-shed/game-text";
import { makeWorkbenchWindowTestLayer, WorkbenchWindowTest } from "../adapters/electron-window.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { makeWorkbenchGameTextTestLayer } from "./game-text.js";
import {
	WorkbenchGameTextOperations,
	WorkbenchGameTextOperationsLive,
	safeLocalizationLogLine
} from "./game-text-operations.js";

const root = resolve("fixtures/unreal-project");
const discovered = discoverLocalizationTargets({
	dashboardText: readFileSync(resolve(root, "Config/DefaultEditor.ini"), "utf8"),
	configs: readdirSync(resolve(root, "Config/Localization"))
		.filter((file) => file.endsWith(".ini"))
		.map((file) => ({
			relativePath: "Config/Localization/" + file,
			text: readFileSync(resolve(root, "Config/Localization", file), "utf8")
		}))
});
if (Result.isFailure(discovered)) throw discovered.failure;
const foundTarget = discovered.success.targets.find((target) => target.name === "FixtureGame");
if (!foundTarget) throw new Error("Missing fixture localization target.");
const target = foundTarget;
function planned(request: LocalizationRunRequest): LocalizationOperationPlan {
	return planLocalizationOperation({
		target: request.target,
		operation: request.operation,
		engine: "5.8",
		projectDescriptor: resolve(root, "UEShedFixture.uproject"),
		logPath: "C:/Private/Logs/Commandlet.log"
	});
}
function receipt(request: LocalizationRunRequest): LocalizationOperationReceipt {
	const plan = planned(request);
	return {
		schemaVersion: 1,
		type: "receipt",
		operation: request.operation,
		target: request.target.name,
		status: "planning_defect",
		durationMs: 100,
		pid: 123,
		logPath: plan.logPath,
		plan,
		changes: [
			{
				relativePath: "Content/Localization/FixtureGame/de/FixtureGame.archive",
				beforeHash: "before",
				afterHash: "after",
				planned: true
			},
			{
				relativePath: "Content/Localization/FixtureGame/de/FixtureGame.locres",
				beforeHash: "before",
				afterHash: "after",
				planned: true
			},
			{
				relativePath: "Content/Localization/FixtureGame/Unexpected.archive",
				beforeHash: null,
				afterHash: "after",
				planned: false
			}
		],
		diagnostics: [
			{
				code: "unplanned_file_change",
				relativePath: "Content/Localization/FixtureGame/Unexpected.archive"
			}
		]
	};
}
function environment(
	options: {
		readonly run?: LocalizationOperationsApi["run"];
		readonly plan?: LocalizationOperationsApi["plan"];
		readonly noTargets?: boolean;
	} = {}
) {
	return Effect.gen(function* () {
		const busy = yield* Ref.make(false);
		const projectRoot = yield* Ref.make(root);
		const refreshed = yield* Ref.make<readonly boolean[]>([]);
		const requests = yield* Ref.make<readonly LocalizationRunRequest[]>([]);
		const current = () =>
			Ref.get(projectRoot).pipe(
				Effect.map((projectRoot) => ({
					status: "ready" as const,
					project: {
						projectRoot,
						projectName: "UEShedFixture",
						generation: 0,
						inputAtlas: "ready" as const,
						packageCount: 1,
						mapCount: 0
					}
				}))
			);
		const project = makeWorkbenchProjectTestLayer({
			current,
			choose: current,
			inputAtlas: () => Effect.die("unused"),
			savedTables: () => Effect.die("unused"),
			savedProject: () => Effect.die("unused")
		});
		const gameText = makeWorkbenchGameTextTestLayer({
			configuredScan: () => Effect.die("unused"),
			chooseAndScan: () => Effect.die("unused"),
			operationTarget: () => Effect.succeed(options.noTargets ? undefined : target),
			operationBusyReason: () =>
				Ref.get(busy).pipe(
					Effect.map((value) => (value ? "A scan or Unreal step is running." : undefined))
				),
			beginOperation: () => Ref.modify(busy, (value) => [!value, true]),
			endOperation: () => Ref.set(busy, false),
			refreshAfterOperation: (_target, gather) =>
				Ref.update(refreshed, (values) => [...values, gather]).pipe(Effect.as(true)),
			localizationTarget: () =>
				Ref.get(refreshed).pipe(
					Effect.map((values) => ({
						status: "ready" as const,
						target: {
							name: target.name,
							nativeCulture: target.nativeCulture,
							cultures: target.cultures
						},
						lines: 1,
						notSynced: values.length ? 1 : 2
					}))
				)
		});
		const runner = Layer.succeed(
			LocalizationOperations,
			LocalizationOperations.of({
				plan: (request) =>
					Ref.update(requests, (values) => [...values, request]).pipe(
						Effect.andThen(
							options.plan ? options.plan(request) : Effect.succeed(planned(request))
						)
					),
				run:
					options.run ??
					((request) =>
						Stream.fromIterable<LocalizationRunEvent>([
							{
								schemaVersion: 1,
								type: "progress",
								phase: "started",
								stepIndex: 1,
								stepTotal: planned(request).steps.length,
								kind: "compile"
							},
							receipt(request)
						]))
			})
		);
		const window = makeWorkbenchWindowTestLayer();
		const layer = WorkbenchGameTextOperationsLive.pipe(
			Layer.provideMerge(window),
			Layer.provide(
				Layer.mergeAll(
					gameText,
					project,
					runner,
					makeWorkbenchConfigurationLayer({
						authoringAsset: { status: "not_configured" },
						expectedProject: { status: "not_configured" },
						project: { status: "not_configured" },
						remoteControlEndpoint: "http://127.0.0.1:30001",
						review: { status: "not_configured" },
						sourceCheckout: { status: "not_configured" },
						textureAuditRules: { status: "not_configured" },
						unrealEngineRoot: { status: "configured", path: "C:/Private/Engine" }
					})
				)
			)
		);
		return { layer, busy, projectRoot, refreshed, requests };
	});
}

it.effect("plans without running, streams safe progress and refreshes evidence after Sync", () =>
	Effect.gen(function* () {
		const env = yield* environment();
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			const state = yield* service.state(target.name);
			expect(state.operations).toEqual([
				"gather",
				"import",
				"export",
				"compile",
				"reports",
				"sync"
			]);
			const plan = yield* service.plan({ target: target.name, operation: "sync" });
			if (plan.status !== "ready") throw new Error("Expected confirmation.");
			expect(Schema.is(WorkbenchOperationPlanResult)(plan)).toBe(true);
			expect(plan.plan.engine).toBe("5.8");
			expect(JSON.stringify(plan)).not.toContain("Private");
			const files = yield* service.files({ id: plan.plan.id, kind: "planned" });
			expect(files).toMatchObject({ status: "ready", total: plan.plan.fileCount });
			expect(yield* Ref.get(env.refreshed)).toEqual([]);
			const result = yield* service.run(plan.plan.id);
			expect(result).toMatchObject({
				status: "completed",
				receipt: {
					changedFiles: 3,
					unplannedFiles: 1,
					translationsImported: 1,
					refreshed: true
				}
			});
			expect(yield* Ref.get(env.refreshed)).toEqual([false]);
			expect(
				(yield* Ref.get(env.requests)).every(
					(request) => request.explicitEngineRoot === "C:/Private/Engine"
				)
			).toBe(true);
			const window = yield* WorkbenchWindowTest;
			const events = yield* window.sent();
			expect(events).toHaveLength(3);
			for (const event of events) {
				expect(event.channel).toBe("game-text:localization:operation-progress");
				expect(Schema.is(WorkbenchOperationProgress)(event.payload)).toBe(true);
				expect(JSON.stringify(event.payload)).not.toContain("Private");
			}
			expect((yield* service.state(target.name)).busyReason).toBeUndefined();
			expect(yield* service.files({ id: plan.plan.id, kind: "changed" })).toMatchObject({
				status: "ready",
				total: 3,
				files: [{ planned: true }, { planned: true }, { planned: false }]
			});
		}).pipe(Effect.provide(env.layer));
	})
);

it.effect("rescans gathered text and pages file lists without leaking filesystem authority", () =>
	Effect.gen(function* () {
		const env = yield* environment({
			plan: (request) =>
				Effect.succeed({
					...planned(request),
					files: Array.from(
						{ length: 123 },
						(_, index): LocalizationOperationPlan["files"][number] => ({
							relativePath: `Content/Localization/FixtureGame/File${index}.po`,
							kind: "po"
						})
					)
				})
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			const result = yield* service.plan({ target: target.name, operation: "gather" });
			if (result.status !== "ready") throw new Error("Expected confirmation.");
			expect(yield* service.files({ id: result.plan.id, kind: "planned" })).toMatchObject({
				status: "ready",
				total: 123,
				nextOffset: 50
			});
			const last = yield* service.files({ id: result.plan.id, kind: "planned", offset: 100 });
			if (last.status !== "ready") throw new Error("Expected file page.");
			expect(last.files).toHaveLength(23);
			expect(last.nextOffset).toBeUndefined();
			yield* service.run(result.plan.id);
			expect(yield* Ref.get(env.refreshed)).toEqual([true]);
			yield* Ref.set(env.projectRoot, "C:/AnotherProject");
			expect(yield* service.files({ id: result.plan.id, kind: "changed" })).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
		}).pipe(Effect.provide(env.layer));
	})
);

it.effect("cancels the owned run, waits for finalization and enforces single flight", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const stopped = yield* Ref.make(false);
		const env = yield* environment({
			run: () =>
				Stream.fromEffect(
					Deferred.succeed(started, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(Ref.set(stopped, true))
					)
				)
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			const result = yield* service.plan({ target: target.name, operation: "sync" });
			if (result.status !== "ready") throw new Error("Expected confirmation.");
			const run = yield* service.run(result.plan.id).pipe(Effect.forkChild);
			yield* Deferred.await(started);
			expect(yield* service.run(result.plan.id)).toMatchObject({
				status: "failed",
				code: "busy"
			});
			expect(yield* service.plan({ target: target.name, operation: "gather" })).toMatchObject(
				{ status: "failed", code: "busy" }
			);
			expect(yield* service.cancel("wrong-id")).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
			expect(yield* Ref.get(stopped)).toBe(false);
			expect(yield* service.cancel(result.plan.id)).toEqual({ status: "cancelled" });
			expect(yield* Ref.get(stopped)).toBe(true);
			expect(yield* Fiber.join(run)).toEqual({ status: "cancelled" });
			expect(yield* Ref.get(env.busy)).toBe(false);
			expect(yield* Ref.get(env.refreshed)).toEqual([]);
		}).pipe(Effect.provide(env.layer));
	})
);

it.effect("rejects stale confirmations, scanning, missing targets and typed runner failures", () =>
	Effect.gen(function* () {
		const env = yield* environment({
			run: () =>
				Stream.fail(
					new LocalizationOperationError({
						code: "commandlet_failed",
						message: "Unreal could not finish the step.",
						recovery: "Repair the target configuration, then review a new plan.",
						retrySafe: false,
						logExcerpt: [
							"Error: C:/Private/Project/file.po could not be read",
							"password=secret"
						]
					})
				)
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			yield* Ref.set(env.busy, true);
			expect(yield* service.plan({ target: target.name, operation: "sync" })).toMatchObject({
				status: "failed",
				code: "busy"
			});
			yield* Ref.set(env.busy, false);
			const result = yield* service.plan({ target: target.name, operation: "sync" });
			if (result.status !== "ready") throw new Error("Expected confirmation.");
			yield* Ref.set(env.projectRoot, "C:/AnotherProject");
			expect(yield* service.run(result.plan.id)).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
			yield* Ref.set(env.projectRoot, root);
			const failed = yield* service.run(result.plan.id);
			expect(failed).toMatchObject({
				status: "failed",
				code: "commandlet_failed",
				details: ["Error: [path] could not be read", "[Sensitive diagnostic omitted]"]
			});
			expect(JSON.stringify(failed)).not.toContain("Private");
			expect(yield* Ref.get(env.busy)).toBe(false);
		}).pipe(Effect.provide(env.layer));
		const noTargets = yield* environment({ noTargets: true });
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			expect(yield* service.state(target.name)).toEqual({
				operations: [],
				wholeRecipe: false
			});
			expect(yield* service.plan({ target: target.name, operation: "sync" })).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
		}).pipe(Effect.provide(noTargets.layer));
	})
);

it("bounds and redacts diagnostic prose", () => {
	expect(safeLocalizationLogLine("Error: /private/project/file.po failed")).toBe(
		"Error: [path] failed"
	);
	expect(safeLocalizationLogLine("x".repeat(3000))).toHaveLength(2048);
});

it.effect("returns a typed planning failure and rejects changed plans before launching", () =>
	Effect.gen(function* () {
		const missingEngine = yield* environment({
			plan: () => Effect.fail(localizationOperationError("engine_not_found"))
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			expect(yield* service.plan({ target: target.name, operation: "sync" })).toMatchObject({
				status: "failed",
				code: "engine_not_found",
				message: "Unreal Engine could not be found for this project."
			});
			expect(yield* Ref.get(missingEngine.busy)).toBe(false);
		}).pipe(Effect.provide(missingEngine.layer));
		let changed = false;
		const runs = yield* Ref.make(0);
		const env = yield* environment({
			plan: (request) =>
				Effect.succeed({ ...planned(request), engine: changed ? "5.7" : "5.8" }),
			run: (request) =>
				Stream.fromEffect(
					Ref.update(runs, (count) => count + 1).pipe(Effect.as(receipt(request)))
				)
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			const plan = yield* service.plan({ target: target.name, operation: "sync" });
			if (plan.status !== "ready") throw new Error("Expected confirmation.");
			changed = true;
			expect(yield* service.run(plan.plan.id)).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
			changed = false;
			expect(yield* service.run(plan.plan.id)).toMatchObject({
				status: "failed",
				code: "stale_plan"
			});
			expect(yield* Ref.get(runs)).toBe(0);
		}).pipe(Effect.provide(env.layer));
	})
);

it.effect("reports failed process termination honestly and keeps exclusive admission closed", () =>
	Effect.gen(function* () {
		const env = yield* environment({
			run: () => Stream.die(localizationOperationError("termination_failed"))
		});
		yield* Effect.gen(function* () {
			const service = yield* WorkbenchGameTextOperations;
			const plan = yield* service.plan({ target: target.name, operation: "sync" });
			if (plan.status !== "ready") throw new Error("Expected confirmation.");
			expect(yield* service.run(plan.plan.id)).toMatchObject({
				status: "failed",
				code: "termination_failed"
			});
			expect(yield* Ref.get(env.busy)).toBe(true);
			expect(yield* service.plan({ target: target.name, operation: "sync" })).toMatchObject({
				status: "failed",
				code: "busy"
			});
		}).pipe(Effect.provide(env.layer));
	})
);

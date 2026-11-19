import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Ref, Result, Stream } from "effect";
import { expect } from "vitest";
import {
	discoverLocalizationTargets,
	localizationOperationError,
	makeLocalizationOperationsTestLayer,
	planLocalizationOperation,
	type LocalizationRunRequest
} from "@ue-shed/localization";
import { makeGameTextOperations, type GameTextOperationsHost } from "./workspace-operations.js";

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

/** Plans and runs one Sync whose commandlet times out; returns every request the runner saw. */
const runTimedOutSync = Effect.fn("test.runTimedOutSync")(function* (
	timeoutSeconds: number | undefined
) {
	const requests = yield* Ref.make<readonly LocalizationRunRequest[]>([]);
	const seen = (request: LocalizationRunRequest) =>
		Ref.update(requests, (values) => [...values, request]);
	const busy = yield* Ref.make(false);
	const host: GameTextOperationsHost = {
		workspace: {
			operationStateTarget: () => Effect.succeed(target),
			operationTarget: () => Effect.succeed(target),
			operationBusyReason: Effect.succeed(undefined),
			beginOperation: Ref.modify(busy, (value) => [!value, true]),
			endOperation: Ref.set(busy, false),
			refreshAfterOperation: () => Effect.succeed(true),
			localizationBeforeGather: () => Effect.void,
			localizationTarget: () =>
				Effect.succeed({
					status: "ready" as const,
					target: {
						name: target.name,
						nativeCulture: target.nativeCulture,
						cultures: target.cultures
					},
					lines: 1,
					notSynced: 0
				})
		},
		project: {
			current: Effect.succeed({
				status: "ready" as const,
				project: { projectRoot: root, generation: 0 }
			})
		},
		engineRoot: () => undefined,
		notifyProgress: () => Effect.void,
		...(timeoutSeconds === undefined ? undefined : { timeoutSeconds })
	};
	const runner = makeLocalizationOperationsTestLayer({
		plan: (request) =>
			seen(request).pipe(
				Effect.as(
					planLocalizationOperation({
						target: request.target,
						operation: request.operation,
						engine: "5.8",
						projectDescriptor: resolve(root, "UEShedFixture.uproject"),
						logPath: "C:/Private/Logs/Commandlet.log"
					})
				)
			),
		run: (request) =>
			Stream.fromEffect(
				seen(request).pipe(
					Effect.andThen(Effect.fail(localizationOperationError("timeout")))
				)
			)
	});
	const result = yield* Effect.scoped(
		Effect.gen(function* () {
			const operations = yield* makeGameTextOperations(host);
			const plan = yield* operations.plan({ target: target.name, operation: "sync" });
			if (plan.status !== "ready") throw new Error("Expected a plan to confirm.");
			return yield* operations.run(plan.plan.id);
		})
	).pipe(Effect.provide(runner));
	return { requests: yield* Ref.get(requests), result };
});

it.effect("Unreal steps keep the localization runner's 30-minute default", () =>
	Effect.gen(function* () {
		const { requests, result } = yield* runTimedOutSync(undefined);
		// plan, the run's recheck, then the run itself
		expect(requests).toHaveLength(3);
		for (const request of requests) expect("timeoutSeconds" in request).toBe(false);
		expect(result).toMatchObject({ status: "failed", code: "timeout" });
		if (result.status !== "failed") throw new Error("Expected a timeout.");
		expect(result.recovery).toContain("1800 seconds");
		expect(result.recovery).toContain("GameTextOperationsHost.timeoutSeconds");
	})
);

it.effect("the host's timeoutSeconds reaches every Unreal step", () =>
	Effect.gen(function* () {
		const { requests, result } = yield* runTimedOutSync(7200);
		expect(requests).toHaveLength(3);
		for (const request of requests) expect(request.timeoutSeconds).toBe(7200);
		if (result.status !== "failed") throw new Error("Expected a timeout.");
		expect(result.recovery).toContain("7200 seconds");
	})
);

import { ScenarioRunner, type ScenarioDocument, type ScenarioRunHandle } from "@ue-shed/scenarios";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const runner = yield* ScenarioRunner;

	yield* ipc.register(invokeContracts["scenario:start"], (...args) => {
		const [document, endpoint] = args as [ScenarioDocument, string];
		return runner.start({ document, endpoint }).pipe(Effect.orDie);
	});

	yield* ipc.register(invokeContracts["scenario:status"], (...args) => {
		const [handle] = args as [ScenarioRunHandle];
		return runner.status(handle).pipe(Effect.orDie);
	});

	yield* ipc.register(invokeContracts["scenario:cancel"], (...args) => {
		const [handle] = args as [ScenarioRunHandle];
		return Effect.gen(function* () {
			const cancelled = yield* runner.cancelHandle(handle);
			if (cancelled._tag === "Rejected") {
				return yield* Effect.die(new Error(`${cancelled.message} ${cancelled.recovery}`));
			}
			const status = yield* runner.status(handle);
			if (status._tag !== "Terminal") {
				return yield* Effect.die(
					new Error("Scenario cancellation was accepted without a terminal result.")
				);
			}
			return status.result;
		}).pipe(Effect.orDie);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerScenarios"));

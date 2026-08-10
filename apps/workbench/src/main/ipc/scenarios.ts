import { ScenarioRunner, type ScenarioDocument } from "@ue-shed/scenarios";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchUnrealConnection } from "../services/unreal-connection.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const runner = yield* ScenarioRunner;
	const connection = yield* WorkbenchUnrealConnection;

	yield* ipc.register(invokeContracts["scenario:run"], (...args) => {
		const [document] = args as [ScenarioDocument];
		return connection.endpoint().pipe(
			Effect.flatMap((endpoint) => runner.run({ document, endpoint })),
			Effect.orDie
		);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerScenarios"));

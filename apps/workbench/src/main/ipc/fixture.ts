import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { FixtureLauncher } from "../services/fixture-launcher.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const launcher = yield* FixtureLauncher;

	yield* ipc.register(invokeContracts["fixture:launch"], () => launcher.launch("default"));
	yield* ipc.register(invokeContracts["fixture:launch-review"], () =>
		launcher.launch("authoring")
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerFixture"));

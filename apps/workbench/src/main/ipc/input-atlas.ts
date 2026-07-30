import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchInputAtlas } from "../services/input-atlas.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const inputAtlas = yield* WorkbenchInputAtlas;

	yield* ipc.register(invokeContracts["input-atlas:configured-scan"], () =>
		inputAtlas.configuredScan()
	);
	yield* ipc.register(invokeContracts["input-atlas:choose-and-scan"], () =>
		inputAtlas.chooseAndScan().pipe(Effect.orDie)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerInputAtlas"));

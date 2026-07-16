import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchGameText } from "../services/game-text.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const gameText = yield* WorkbenchGameText;

	yield* ipc.register(invokeContracts["game-text:configured-scan"], () =>
		gameText.configuredScan()
	);
	yield* ipc.register(invokeContracts["game-text:choose-and-scan"], () =>
		gameText.chooseAndScan().pipe(Effect.orDie)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerGameText"));

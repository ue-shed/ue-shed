import { Effect } from "effect";
import type { TextCorpusFocusRequest, TextCorpusSearchRequest } from "@ue-shed/game-text";
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
	yield* ipc.register(invokeContracts["game-text:configured-refresh"], () =>
		gameText.configuredRefresh()
	);
	yield* ipc.register(invokeContracts["game-text:choose-and-refresh"], () =>
		gameText.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["game-text:search"], (...args) => {
		const [request] = args as [TextCorpusSearchRequest];
		return gameText.search(request);
	});
	yield* ipc.register(invokeContracts["game-text:focus"], (...args) => {
		const [request] = args as [TextCorpusFocusRequest];
		return gameText.focus(request);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerGameText"));

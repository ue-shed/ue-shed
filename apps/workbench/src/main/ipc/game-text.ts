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
	yield* ipc.register(invokeContracts["game-text:configured-refresh"], () =>
		gameText.configuredRefresh()
	);
	yield* ipc.register(invokeContracts["game-text:choose-and-refresh"], () =>
		gameText.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["game-text:progress"], () => gameText.progress());
	yield* ipc.register(invokeContracts["game-text:search"], (...args) => {
		const [request] = args;
		return gameText.search(request);
	});
	yield* ipc.register(invokeContracts["game-text:focus"], (...args) => {
		const [request] = args;
		return gameText.focus(request);
	});
	yield* ipc.register(invokeContracts["game-text:quality:choose-rules"], () =>
		gameText.chooseQualityRules()
	);
	yield* ipc.register(invokeContracts["game-text:quality:preview-rules"], (...args) => {
		const [document] = args;
		return gameText.previewQualityRules(document);
	});
	yield* ipc.register(invokeContracts["game-text:quality:save-rules"], (...args) => {
		const [document] = args;
		return gameText.saveQualityRules(document);
	});
	yield* ipc.register(invokeContracts["game-text:quality:search"], (...args) => {
		const [request] = args;
		return gameText.qualitySearch(request);
	});
	yield* ipc.register(invokeContracts["game-text:quality:focus"], (...args) => {
		const [request] = args;
		return gameText.qualityFocus(request);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerGameText"));

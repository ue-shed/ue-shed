import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchGameText } from "../services/game-text.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const gameText = yield* WorkbenchGameText;
	yield* ipc.register(invokeContracts["game-text:quality:reload-rules"], () =>
		gameText.reloadQualityRules()
	);
	yield* ipc.register(invokeContracts["game-text:quality:create-starter-rules"], (loadExisting) =>
		gameText.createStarterRules(loadExisting)
	);

	yield* ipc.register(invokeContracts["game-text:configured-scan"], () =>
		gameText.configuredRefresh(true)
	);
	yield* ipc.register(invokeContracts["game-text:choose-and-scan"], () =>
		gameText.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["game-text:configured-refresh"], (refresh) =>
		gameText.configuredRefresh(refresh)
	);
	yield* ipc.register(invokeContracts["game-text:choose-and-refresh"], () =>
		gameText.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["game-text:progress"], () => gameText.progress());
	yield* ipc.register(invokeContracts["game-text:investigation-export"], (...args) =>
		gameText.investigationExport(...args)
	);
	yield* ipc.register(invokeContracts["game-text:investigation-save"], (...args) =>
		gameText.investigationSave(...args)
	);
	yield* ipc.register(invokeContracts["game-text:investigation-open"], (...args) =>
		gameText.investigationOpen(...args)
	);
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

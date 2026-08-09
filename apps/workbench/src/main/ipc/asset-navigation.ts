import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import type { GameObjectPath } from "../ipc-contracts.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchAssetNavigation } from "../services/asset-navigation.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const navigation = yield* WorkbenchAssetNavigation;

	yield* ipc.register(invokeContracts["asset-navigation:locate"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return navigation.locate(objectPath);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerAssetNavigation"));

import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchConfigExplorer } from "../services/config-explorer.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const explorer = yield* WorkbenchConfigExplorer;

	yield* ipc.register(invokeContracts["config-explorer:showcase"], () => explorer.showcase());
}).pipe(Effect.withSpan("Workbench.Ipc.registerConfigExplorer"));

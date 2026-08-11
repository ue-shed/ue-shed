import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts, type ConfigExplorerQuery } from "../ipc-contracts.js";
import { WorkbenchConfigExplorer } from "../services/config-explorer.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const explorer = yield* WorkbenchConfigExplorer;

	yield* ipc.register(invokeContracts["config-explorer:query"], (...args) => {
		const [request] = args as [ConfigExplorerQuery];
		return explorer.query(request);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerConfigExplorer"));

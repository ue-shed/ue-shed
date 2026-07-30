import type { ContentObservatoryHistoryRequest } from "@ue-shed/extension-content-observatory/client";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchContentObservatory } from "../services/content-observatory.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const observatory = yield* WorkbenchContentObservatory;

	yield* ipc.register(invokeContracts["content-observatory:status"], () => observatory.status());
	yield* ipc.register(invokeContracts["content-observatory:start"], (...args) => {
		const [request] = args as [ContentObservatoryHistoryRequest];
		return observatory.start(request);
	});
	yield* ipc.register(invokeContracts["content-observatory:cancel"], () => observatory.cancel());
}).pipe(Effect.withSpan("Workbench.Ipc.registerContentObservatory"));

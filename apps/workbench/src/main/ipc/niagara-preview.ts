import { Effect } from "effect";
import { invokeContracts } from "../ipc-contracts.js";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { WorkbenchNiagaraPreview } from "../services/niagara-preview.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const niagara = yield* WorkbenchNiagaraPreview;
	yield* ipc.register(invokeContracts["niagara-preview:run"], (...args) => niagara.run(...args));
	yield* ipc.register(invokeContracts["niagara-preview:frame"], (...args) =>
		niagara.frame(...args)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerNiagaraPreview"));

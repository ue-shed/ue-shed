import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { Showcase } from "../services/showcase.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const showcase = yield* Showcase;

	yield* ipc.register(invokeContracts["showcase:context"], () => showcase.context());
}).pipe(Effect.withSpan("Workbench.Ipc.registerShowcase"));

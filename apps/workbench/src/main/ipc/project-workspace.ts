import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchProject } from "../services/project-workspace.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const project = yield* WorkbenchProject;

	yield* ipc.register(invokeContracts["project:current"], () => project.current());
	yield* ipc.register(invokeContracts["project:choose"], () => project.choose());
}).pipe(Effect.withSpan("Workbench.Ipc.registerProjectWorkspace"));

import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { ProjectLauncher } from "../services/project-launcher.js";
import { WorkbenchProject } from "../services/project-workspace.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const launcher = yield* ProjectLauncher;
	const project = yield* WorkbenchProject;

	yield* ipc.register(invokeContracts["project:current"], () => project.current());
	yield* ipc.register(invokeContracts["project:refresh"], (mode) => project.refresh(mode));
	yield* ipc.register(invokeContracts["project:choose"], () => project.choose());
	yield* ipc.register(invokeContracts["project:sample"], () => project.sample());
	yield* ipc.register(invokeContracts["project:recent"], () => project.recent());
	yield* ipc.register(invokeContracts["project:open-recent"], (...args) => {
		const [projectRoot] = args;
		return project.openRecent(projectRoot);
	});
	yield* ipc.register(invokeContracts["project:progress"], () => project.progress());
	yield* ipc.register(invokeContracts["project:launch"], (...args) => {
		const [mode] = args;
		return launcher.launch(mode);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerProjectWorkspace"));

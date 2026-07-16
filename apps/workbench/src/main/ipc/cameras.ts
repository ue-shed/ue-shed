import type { CameraScheduleConfig } from "@ue-shed/protocol";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts, type PresentationBudgetMbPerSecond } from "../ipc-contracts.js";
import { CameraPresentation } from "../services/camera-presentation.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const presentation = yield* CameraPresentation;

	yield* ipc.register(invokeContracts["camera:metrics"], () => presentation.metrics());
	yield* ipc.register(invokeContracts["camera:presentation-budget"], (...args) => {
		const [megabytesPerSecond] = args as [PresentationBudgetMbPerSecond];
		return presentation.setPresentationBudget(megabytesPerSecond);
	});
	yield* ipc.register(invokeContracts["camera:status"], () =>
		presentation.status().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["camera:configure"], (...args) => {
		const [config] = args as [CameraScheduleConfig];
		return presentation.configure(config).pipe(Effect.orDie);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerCameras"));

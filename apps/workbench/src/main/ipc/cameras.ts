import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { CameraPresentation } from "../services/camera-presentation.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const presentation = yield* CameraPresentation;

	yield* ipc.register(invokeContracts["camera:metrics"], () =>
		presentation.metrics().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["camera:presentation-budget"], (...args) => {
		const [megabytesPerSecond] = args;
		return presentation.setPresentationBudget(megabytesPerSecond);
	});
	yield* ipc.register(invokeContracts["camera:status"], () =>
		presentation.status().pipe(
			Effect.match({
				onFailure: () => ({
					message: "Camera streaming is unavailable in the current editor state.",
					recovery:
						"Launch the project With UE Shed and wait for UEShedCameras to connect. PIE is optional.",
					status: "unavailable" as const
				}),
				onSuccess: (camera) => ({ camera, status: "ready" as const })
			})
		)
	);
	yield* ipc.register(invokeContracts["camera:configure"], (...args) => {
		const [config] = args;
		return presentation.configure(config).pipe(Effect.orDie);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerCameras"));

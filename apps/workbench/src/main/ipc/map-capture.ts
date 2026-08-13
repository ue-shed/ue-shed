import type { MapCapturePlan } from "@ue-shed/cameras";
import type {
	MapCaptureExecuteIntent,
	MapCaptureSaveIntent
} from "@ue-shed/extension-camera-review/map-capture-client";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchMapCapture } from "../services/map-capture.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const mapCapture = yield* WorkbenchMapCapture;

	yield* ipc.register(invokeContracts["map-capture:choose-plan"], () => mapCapture.choosePlan());
	yield* ipc.register(invokeContracts["map-capture:new-plan"], () => mapCapture.newPlan());
	yield* ipc.register(invokeContracts["map-capture:save-plan"], (...args) => {
		const [intent] = args as [MapCaptureSaveIntent];
		return mapCapture.savePlan(intent);
	});
	yield* ipc.register(invokeContracts["map-capture:open-map"], (...args) => {
		const [plan] = args as [MapCapturePlan];
		return mapCapture.openMap(plan);
	});
	yield* ipc.register(invokeContracts["map-capture:preview"], (...args) => {
		const [plan] = args as [MapCapturePlan];
		return mapCapture.preview(plan);
	});
	yield* ipc.register(invokeContracts["map-capture:capture"], (...args) => {
		const [intent] = args as [MapCaptureExecuteIntent];
		return mapCapture.capture(intent);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerMapCapture"));

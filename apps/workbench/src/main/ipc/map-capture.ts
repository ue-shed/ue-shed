import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchMapCapture } from "../services/map-capture.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const mapCapture = yield* WorkbenchMapCapture;

	yield* ipc.register(invokeContracts["map-capture:actors"], (...args) => {
		const [mapPath] = args;
		return mapCapture.actors(mapPath);
	});
	yield* ipc.register(invokeContracts["map-capture:choose-plan"], () => mapCapture.choosePlan());
	yield* ipc.register(invokeContracts["map-capture:new-plan"], () => mapCapture.newPlan());
	yield* ipc.register(invokeContracts["map-capture:save-plan"], (...args) => {
		const [intent] = args;
		return mapCapture.savePlan(intent);
	});
	yield* ipc.register(invokeContracts["map-capture:open-map"], (...args) => {
		const [plan] = args;
		return mapCapture.openMap(plan);
	});
	yield* ipc.register(invokeContracts["map-capture:preview"], (...args) => {
		const [plan] = args;
		return mapCapture.preview(plan);
	});
	yield* ipc.register(invokeContracts["map-capture:capture"], (...args) => {
		const [intent] = args;
		return mapCapture.capture(intent);
	});
	yield* ipc.register(invokeContracts["map-capture:tile"], (...args) => {
		const [intent] = args;
		return mapCapture.tile(intent);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerMapCapture"));

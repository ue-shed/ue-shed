import type { AuthoringSetCellsIntent } from "@ue-shed/authoring-sdk";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import type { GameObjectPath, SessionId } from "../ipc-contracts.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchAuthoring } from "../services/authoring.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const authoring = yield* WorkbenchAuthoring;

	yield* ipc.register(invokeContracts["authoring:configured-table"], () =>
		authoring.configuredTable()
	);
	yield* ipc.register(invokeContracts["authoring:configured-catalog"], () =>
		authoring.configuredCatalog()
	);
	yield* ipc.register(invokeContracts["authoring:open-catalog-table"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return authoring.openCatalogTable(objectPath);
	});
	yield* ipc.register(invokeContracts["authoring:choose-table"], () =>
		authoring.chooseTable().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["authoring:session:begin"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return authoring.beginSession(objectPath);
	});
	yield* ipc.register(invokeContracts["authoring:session:edit"], (...args) => {
		const [intent] = args as [AuthoringSetCellsIntent];
		return authoring.editSession(intent);
	});
	yield* ipc.register(invokeContracts["authoring:session:undo"], (...args) => {
		const [sessionId] = args as [SessionId];
		return authoring.undoSession(sessionId);
	});
	yield* ipc.register(invokeContracts["authoring:session:redo"], (...args) => {
		const [sessionId] = args as [SessionId];
		return authoring.redoSession(sessionId);
	});
	yield* ipc.register(invokeContracts["authoring:session:apply"], (...args) => {
		const [sessionId] = args as [SessionId];
		return authoring.applySession(sessionId);
	});
	yield* ipc.register(invokeContracts["authoring:session:reconcile"], (...args) => {
		const [sessionId] = args as [SessionId];
		return authoring.reconcileSession(sessionId);
	});
	yield* ipc.register(invokeContracts["authoring:session:save"], (...args) => {
		const [sessionId] = args as [SessionId];
		return authoring.saveSession(sessionId);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerAuthoring"));

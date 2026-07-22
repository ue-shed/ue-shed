import {
	AuthoringClient,
	type AuthoringAuthority,
	type AuthoringClientError,
	type AuthoringSessionIntent
} from "@ue-shed/authoring-sdk";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import type { GameObjectPath, SessionId } from "../ipc-contracts.js";
import { invokeContracts } from "../ipc-contracts.js";

const hostRequest = <A>(effect: Effect.Effect<A, AuthoringClientError>) =>
	effect.pipe(Effect.orDie);

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const authoring = yield* AuthoringClient;

	yield* ipc.register(invokeContracts["authoring:configured-table"], () =>
		hostRequest(authoring.loadConfiguredTable())
	);
	yield* ipc.register(invokeContracts["authoring:configured-catalog"], () =>
		hostRequest(authoring.loadConfiguredCatalog())
	);
	yield* ipc.register(invokeContracts["authoring:open-catalog-table"], (...args) => {
		const [objectPath, authority] = args as [GameObjectPath, AuthoringAuthority];
		return hostRequest(authoring.openCatalogTable(objectPath, authority));
	});
	yield* ipc.register(invokeContracts["authoring:choose-table"], () =>
		hostRequest(authoring.chooseTable())
	);
	yield* ipc.register(invokeContracts["authoring:session:begin"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return hostRequest(authoring.beginSession(objectPath));
	});
	yield* ipc.register(invokeContracts["authoring:session:list"], () =>
		hostRequest(authoring.listSessions())
	);
	yield* ipc.register(invokeContracts["authoring:session:open"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.openSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:discard"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.discardSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:edit"], (...args) => {
		const [intent] = args as [AuthoringSessionIntent];
		return hostRequest(authoring.editSession(intent));
	});
	yield* ipc.register(invokeContracts["authoring:session:review"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.reviewSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:undo"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.undoSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:redo"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.redoSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:apply"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.applySession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:reconcile"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.reconcileSession(sessionId));
	});
	yield* ipc.register(invokeContracts["authoring:session:save"], (...args) => {
		const [sessionId] = args as [SessionId];
		return hostRequest(authoring.saveSession(sessionId));
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerAuthoring"));

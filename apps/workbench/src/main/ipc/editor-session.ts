import type { EditorPlaySessionCommand } from "@ue-shed/protocol";
import { EditorPlaySession } from "@ue-shed/engine-discovery";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchUnrealConnection } from "../services/unreal-connection.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const editorSession = yield* EditorPlaySession;
	const connection = yield* WorkbenchUnrealConnection;

	yield* ipc.register(invokeContracts["editor-session:status"], () =>
		connection.endpoint().pipe(
			Effect.flatMap((endpoint) => editorSession.status(endpoint)),
			Effect.orDie
		)
	);
	yield* ipc.register(invokeContracts["editor-session:execute"], (...args) => {
		const [command] = args as [EditorPlaySessionCommand];
		return connection.endpoint().pipe(
			Effect.flatMap((endpoint) => editorSession.execute(endpoint, command)),
			Effect.orDie
		);
	});
	yield* ipc.register(invokeContracts["editor-session:settings"], () => connection.settings());
	yield* ipc.register(invokeContracts["editor-session:set-port"], (...args) => {
		const [port] = args as [number];
		return connection.setPort(port);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerEditorSession"));

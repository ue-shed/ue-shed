import { WorkbenchEditorHandoff } from "../services/editor-handoff.js";
import { EditorPlaySession } from "@ue-shed/engine";
import { Effect, Option } from "effect";
import { WorkbenchMapReview } from "../services/map-review.js";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchUnrealConnection } from "../services/unreal-connection.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const editorSession = yield* EditorPlaySession;
	const connection = yield* WorkbenchUnrealConnection;
	const handoff = yield* WorkbenchEditorHandoff;
	yield* ipc.register(invokeContracts["editor-window:activate"], () =>
		connection.endpoint().pipe(Effect.flatMap(handoff.activate))
	);

	yield* ipc.register(invokeContracts["editor-session:status"], () =>
		connection.endpoint().pipe(
			Effect.flatMap((endpoint) => editorSession.status(endpoint)),
			Effect.match({
				onFailure: (error) => ({
					error: {
						code: error.code,
						endpoint: error.endpoint,
						message: error.message,
						operation: error.operation,
						recovery: error.recovery,
						retrySafe: error.retrySafe
					},
					status: "unavailable" as const
				}),
				onSuccess: (session) => ({ session, status: "ready" as const })
			})
		)
	);
	yield* ipc.register(invokeContracts["editor-session:execute"], (...args) => {
		const [command] = args;
		return connection.endpoint().pipe(
			Effect.flatMap((endpoint) =>
				editorSession
					.execute(endpoint, command)
					.pipe(
						Effect.tap((result) =>
							result.outcome !== "rejected" &&
							(command === "start_play" || command === "start_simulate")
								? handoff.activate(endpoint)
								: Effect.void
						)
					)
			),
			Effect.orDie
		);
	});
	yield* ipc.register(invokeContracts["editor-session:settings"], () => connection.settings());
	yield* ipc.register(invokeContracts["editor-session:set-port"], (...args) => {
		const [port] = args;
		return Effect.gen(function* () {
			if ((yield* connection.settings()).port !== port) {
				const review = yield* Effect.serviceOption(WorkbenchMapReview);
				if (Option.isSome(review)) yield* review.value.resetLiveTarget?.() ?? Effect.void;
			}
			return yield* connection.setPort(port);
		});
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerEditorSession"));

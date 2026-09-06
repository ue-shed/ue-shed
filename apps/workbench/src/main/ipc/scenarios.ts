import { ScenarioRunner } from "@ue-shed/scenarios";
import { readScenarioDocumentFile, writeScenarioDocumentFile } from "@ue-shed/scenarios/files";
import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const runner = yield* ScenarioRunner;
	const dialog = yield* ElectronDialog;
	const filters = [{ extensions: ["json"], name: "Scenario document" }];
	yield* ipc.register(invokeContracts["scenario:open-document"], () =>
		Effect.gen(function* () {
			const choice = yield* dialog.chooseFile({ filters, title: "Open scenario document" });
			if (choice.status === "cancelled") return choice;
			const document = yield* readScenarioDocumentFile(choice.path);
			return { status: "completed" as const, path: choice.path, document };
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed({
					status: "failed" as const,
					message: error.message,
					recovery: error.recovery
				})
			)
		)
	);
	yield* ipc.register(invokeContracts["scenario:save-document"], (document) =>
		Effect.gen(function* () {
			const choice = yield* dialog.chooseSaveFile({
				filters,
				title: "Save scenario document",
				defaultPath: "scenario.json"
			});
			if (choice.status === "cancelled") return choice;
			const saved = yield* writeScenarioDocumentFile(choice.path, document);
			return { status: "completed" as const, path: choice.path, document: saved };
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed({
					status: "failed" as const,
					message: error.message,
					recovery: error.recovery
				})
			)
		)
	);

	yield* ipc.register(invokeContracts["scenario:start"], (...args) => {
		const [document, endpoint] = args;
		return runner.start({ document, endpoint }).pipe(Effect.orDie);
	});

	yield* ipc.register(invokeContracts["scenario:status"], (...args) => {
		const [handle] = args;
		return runner.status(handle).pipe(Effect.orDie);
	});

	yield* ipc.register(invokeContracts["scenario:cancel"], (...args) => {
		const [handle] = args;
		return Effect.gen(function* () {
			const cancelled = yield* runner.cancelHandle(handle);
			if (cancelled._tag === "Rejected") {
				return yield* Effect.die(new Error(`${cancelled.message} ${cancelled.recovery}`));
			}
			const status = yield* runner.status(handle);
			if (status._tag !== "Terminal") {
				return yield* Effect.die(
					new Error("Scenario cancellation was accepted without a terminal result.")
				);
			}
			return status.result;
		}).pipe(Effect.orDie);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerScenarios"));

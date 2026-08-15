import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchCustodian } from "../services/project-custodian.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const custodian = yield* WorkbenchCustodian;

	yield* ipc.register(invokeContracts["project-custodian:configured-scan"], () =>
		custodian.configuredScan()
	);
	yield* ipc.register(invokeContracts["project-custodian:choose-and-scan"], () =>
		custodian.chooseAndScan()
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerProjectCustodian"));

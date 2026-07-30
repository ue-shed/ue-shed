import { Effect } from "effect";
import type { TextureAuditSearchRequest } from "@ue-shed/asset-audits";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import type { GameObjectPath } from "../ipc-contracts.js";
import { invokeContracts } from "../ipc-contracts.js";
import { WorkbenchAssetAudits } from "../services/asset-audits.js";

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const audits = yield* WorkbenchAssetAudits;

	yield* ipc.register(invokeContracts["asset-audits:textures:configured-scan"], () =>
		audits.configuredScan()
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:choose-and-scan"], () =>
		audits.chooseAndScan().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:configured-refresh"], () =>
		audits.configuredRefresh()
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:choose-and-refresh"], () =>
		audits.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:progress"], () => audits.progress());
	yield* ipc.register(invokeContracts["asset-audits:textures:search"], (...args) => {
		const [request] = args as [TextureAuditSearchRequest];
		return audits.search(request);
	});
	yield* ipc.register(invokeContracts["asset-audits:textures:record"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return audits.record(objectPath);
	});
	yield* ipc.register(invokeContracts["asset-audits:textures:preview"], (...args) => {
		const [objectPath] = args as [GameObjectPath];
		return audits.preview(objectPath);
	});
}).pipe(Effect.withSpan("Workbench.Ipc.registerAssetAudits"));

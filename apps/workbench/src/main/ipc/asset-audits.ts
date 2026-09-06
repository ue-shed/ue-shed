import { Effect } from "effect";
import { ElectronIpc } from "../adapters/electron-ipc.js";
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
	yield* ipc.register(invokeContracts["asset-audits:textures:configured-refresh"], (refresh) =>
		audits.configuredRefresh(refresh)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:choose-and-refresh"], () =>
		audits.chooseAndRefresh().pipe(Effect.orDie)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:progress"], () => audits.progress());
	yield* ipc.register(invokeContracts["asset-audits:textures:investigation-export"], (...args) =>
		audits.investigationExport(...args)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:investigation-save"], (...args) =>
		audits.investigationSave(...args)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:investigation-open"], (...args) =>
		audits.investigationOpen(...args)
	);
	yield* ipc.register(invokeContracts["asset-audits:textures:search"], (...args) => {
		const [request] = args;
		return audits.search(request);
	});
	yield* ipc.register(invokeContracts["asset-audits:textures:record"], (...args) => {
		const [objectPath] = args;
		return audits.record(objectPath);
	});
	yield* ipc.register(invokeContracts["asset-audits:textures:preview"], (...args) => {
		const [objectPath] = args;
		return audits.preview(objectPath);
	});
	yield* ipc.register(invokeContracts["asset-audits:textures:preview-offline"], (...args) => {
		const [objectPath] = args;
		return audits.previewOffline(objectPath);
	});
	yield* ipc.register(
		invokeContracts["asset-audits:textures:preview-offline-batch"],
		(...args) => {
			const [request] = args;
			return audits.previewOfflineBatch(request);
		}
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerAssetAudits"));

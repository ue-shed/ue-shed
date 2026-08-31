import { AssetReader, type AssetReaderError } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import { type BlueprintGraphReadResult, invokeContracts } from "../ipc-contracts.js";

const recovery =
	"Choose an uncooked Blueprint saved by Unreal Engine 5.7 and verify the UAsset reader is configured.";

function readerFailure(assetPath: string, error: AssetReaderError): BlueprintGraphReadResult {
	return {
		assetPath,
		message: error.message,
		recovery,
		status: "failed"
	};
}

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const dialog = yield* ElectronDialog;
	const reader = yield* AssetReader;

	const read = Effect.fn("Workbench.BlueprintGraphs.read")(function* (assetPath: string) {
		return yield* reader.readBlueprint(assetPath).pipe(
			Effect.map(
				(read): BlueprintGraphReadResult => ({
					assetPath,
					...read,
					status: "ready"
				})
			),
			Effect.catchTag("AssetReaderError", (error) =>
				Effect.succeed(readerFailure(assetPath, error))
			)
		);
	});

	yield* ipc.register(invokeContracts["blueprint-graphs:read"], (...args) => read(args[0]));
	yield* ipc.register(invokeContracts["blueprint-graphs:choose"], () =>
		dialog
			.chooseFile({
				filters: [{ extensions: ["uasset"], name: "Unreal asset" }],
				title: "Open a saved Blueprint"
			})
			.pipe(
				Effect.flatMap((choice) =>
					choice.status === "cancelled"
						? Effect.succeed({ status: "cancelled" as const })
						: read(choice.path)
				),
				Effect.catchTag("Workbench.WorkbenchWindowError", (error) =>
					Effect.succeed({
						message: error.message,
						recovery: error.recovery,
						status: "failed" as const
					})
				)
			)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerBlueprintGraphs"));

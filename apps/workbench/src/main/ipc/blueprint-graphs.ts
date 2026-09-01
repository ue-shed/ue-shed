import { AssetReader, isHeaderScanEntry, type AssetReaderError } from "@ue-shed/unreal-assets";
import { Cache, Duration, Effect, Exit } from "effect";
import { resolve } from "node:path";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { ElectronIpc } from "../adapters/electron-ipc.js";
import {
	BLUEPRINT_ASSET_SEARCH_LIMIT,
	type BlueprintAssetCandidate,
	type BlueprintAssetSearchRequest,
	type BlueprintAssetSearchResult,
	type BlueprintGraphFailureReason,
	type BlueprintGraphReadResult,
	invokeContracts
} from "../ipc-contracts.js";
import { WorkbenchProject } from "../services/project-workspace.js";

function blueprintClassName(classNames: readonly string[]): string {
	return classNames.find((className) => className.endsWith("Blueprint")) ?? "Blueprint";
}

function blueprintAssetName(packageName: string, relativePath: string): string {
	const packageSegment = packageName.split("/").at(-1);
	if (packageSegment !== undefined && packageSegment !== "") return packageSegment;
	return (
		relativePath
			.split(/[\\/]/)
			.at(-1)
			?.replace(/\.uasset$/i, "") ?? relativePath
	);
}

function searchText(asset: BlueprintAssetCandidate): string {
	return [asset.assetName, asset.packageName, asset.relativePath, asset.className]
		.join("\n")
		.toLocaleLowerCase();
}

function matchRank(asset: BlueprintAssetCandidate, normalizedQuery: string): number {
	if (normalizedQuery === "") return 4;
	const assetName = asset.assetName.toLocaleLowerCase();
	if (assetName === normalizedQuery) return 0;
	if (assetName.startsWith(normalizedQuery)) return 1;
	if (assetName.includes(normalizedQuery)) return 2;
	if (asset.packageName.toLocaleLowerCase().includes(normalizedQuery)) return 3;
	return 4;
}

function searchCatalog(
	assets: readonly BlueprintAssetCandidate[],
	request: BlueprintAssetSearchRequest
) {
	const normalizedQuery = request.query.toLocaleLowerCase();
	const terms = normalizedQuery.split(/\s+/).filter((term) => term !== "");
	const matches = assets
		.filter((asset) => {
			const evidence = searchText(asset);
			return terms.every((term) => evidence.includes(term));
		})
		.toSorted(
			(left, right) =>
				matchRank(left, normalizedQuery) - matchRank(right, normalizedQuery) ||
				left.assetName.localeCompare(right.assetName) ||
				left.relativePath.localeCompare(right.relativePath)
		);
	return {
		assets: matches.slice(0, BLUEPRINT_ASSET_SEARCH_LIMIT),
		matchCount: matches.length
	};
}

function failureReason(error: AssetReaderError): BlueprintGraphFailureReason {
	switch (error.code) {
		case "unsupported_version":
			return "unsupported_version";
		case "unsupported_capability":
			return "control_rig";
		case "malformed_data":
			return "malformed_package";
		case "executable_missing":
			return "missing_reader";
		case "unsupported":
		case "unsupported_format":
			return "unsupported_asset";
		default:
			return "reader_failure";
	}
}

function failureRecovery(reason: BlueprintGraphFailureReason): string {
	switch (reason) {
		case "unsupported_version":
			return "Choose an uncooked package in the UE 5.7-loadable saved-revision window.";
		case "control_rig":
			return "Inspect this asset in Unreal's Control Rig editor; schema 1 does not project RigVM graphs.";
		case "malformed_package":
			return "Restore or resave the package, then retry. The reader did not modify the file.";
		case "missing_reader":
			return "Build uasset-io and set UE_SHED_UASSET_EXECUTABLE to the resulting uasset executable.";
		case "unsupported_asset":
			return "Choose an uncooked Blueprint .uasset containing saved editor graph data.";
		case "reader_failure":
			return "Verify the configured UAsset reader, package path, and file access, then retry.";
	}
}

function readerFailure(assetPath: string, error: AssetReaderError): BlueprintGraphReadResult {
	const reason = failureReason(error);
	return {
		assetPath,
		message: error.message,
		reason,
		recovery: failureRecovery(reason),
		status: "failed"
	};
}

export const register = Effect.gen(function* () {
	const ipc = yield* ElectronIpc;
	const dialog = yield* ElectronDialog;
	const reader = yield* AssetReader;
	const project = yield* WorkbenchProject;

	const loadBlueprintCatalog = Effect.fn("Workbench.BlueprintGraphs.loadCatalog")(function* (
		projectRoot: string
	) {
		const index = yield* project.candidates("blueprint");
		return index.assets
			.filter(isHeaderScanEntry)
			.map((entry): BlueprintAssetCandidate => {
				const className = blueprintClassName(
					entry.header.exports.flatMap((exported) =>
						exported.class_name === undefined ? [] : [exported.class_name]
					)
				);
				return {
					assetName: blueprintAssetName(entry.header.package.name, entry.header.path),
					assetPath: resolve(projectRoot, entry.header.path),
					className,
					packageName: entry.header.package.name,
					relativePath: entry.header.path
				};
			})
			.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
	});
	const catalogs = yield* Cache.makeWith(loadBlueprintCatalog, {
		capacity: 4,
		timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero)
	});

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
	yield* ipc.register(invokeContracts["blueprint-graphs:search"], (...args) =>
		Effect.gen(function* () {
			const [request] = args;
			const state = yield* project.current();
			if (state.status === "not_configured" || state.status === "cancelled") {
				return { status: "not_configured" as const };
			}
			if (state.status === "failed") {
				return {
					message: state.error.message,
					recovery: state.error.recovery,
					status: "failed" as const
				};
			}
			const match = searchCatalog(
				yield* Cache.get(catalogs, state.project.projectRoot),
				request
			);
			return {
				...match,
				projectName: state.project.projectName,
				status: "ready" as const
			} satisfies BlueprintAssetSearchResult;
		}).pipe(
			Effect.catchTag("WorkbenchProjectUnavailable", (error) =>
				Effect.succeed({
					message: error.message,
					recovery: error.recovery,
					status: "failed" as const
				})
			)
		)
	);
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
						reason: "reader_failure" as const,
						recovery: error.recovery,
						status: "failed" as const
					})
				)
			)
	);
}).pipe(Effect.withSpan("Workbench.Ipc.registerBlueprintGraphs"));

import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect } from "vitest";
import { makeElectronAppTestLayer } from "../adapters/electron-app.js";
import {
	OfflineTexturePreviewHost,
	OfflineTexturePreviewHostError,
	type OfflineTexturePreviewHostApi
} from "../adapters/offline-texture-preview-host.js";
import { workbenchConfigurationFromUnknown } from "../workbench-config.js";
import {
	OfflineTexturePreview,
	OfflineTexturePreviewError,
	OfflineTexturePreviewLive
} from "./offline-texture-preview.js";
const isOfflineTexturePreviewError = Schema.is(OfflineTexturePreviewError);

const stages = [
	["list_project_files", "project_unavailable"],
	["stat_file", "project_unavailable"],
	["create_directory", "cache_failure"],
	["write_file", "cache_failure"],
	["run_commandlet", "commandlet_failed"],
	["read_file", "cache_failure"]
] as const;

for (const [operation, code] of stages) {
	it.effect(`retains the ${operation} host error and its original cause`, () =>
		Effect.gen(function* () {
			const original = new Error("The host refused the operation.");
			const failure = new OfflineTexturePreviewHostError({
				cause: original,
				causeText: original.message,
				code: "offline_texture_preview_host_failed",
				operation,
				path: "host-owned-path",
				message: "The host operation failed.",
				recovery: "Restore host access.",
				nextStep: "fix_input",
				retrySafe: true
			});
			const host: OfflineTexturePreviewHostApi = {
				engineRoots: Effect.succeed([]),
				exists: () => Effect.succeed(true),
				listProjectFiles: () =>
					operation === "list_project_files"
						? failure
						: Effect.succeed(["C:/Project/Test.uproject"]),
				statFile: () =>
					operation === "stat_file"
						? failure
						: Effect.succeed({ size: 4, modifiedMs: 10 }),
				// A cache miss is expected; the generated read must retain the same failure.
				readFile: () => failure,
				makeDirectory: () => (operation === "create_directory" ? failure : Effect.void),
				writeFile: () => (operation === "write_file" ? failure : Effect.void),
				runCommandlet: () =>
					operation === "run_commandlet"
						? failure
						: Effect.succeed({ exitCode: 0, stderr: "" })
			};
			const error = yield* Effect.gen(function* () {
				const previews = yield* OfflineTexturePreview;
				return yield* previews.preview({
					objectPath: "/Game/Test.Test",
					packageFile: "Content/Test.uasset",
					projectRoot: "C:/Project"
				});
			}).pipe(
				Effect.provide(
					OfflineTexturePreviewLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								makeElectronAppTestLayer(),
								workbenchConfigurationFromUnknown({
									UE_SHED_UNREAL_ENGINE_ROOT: "C:/Engine"
								}),
								Layer.succeed(OfflineTexturePreviewHost, host)
							)
						)
					)
				),
				Effect.flip
			);
			expect(isOfflineTexturePreviewError(error)).toBe(true);
			if (isOfflineTexturePreviewError(error)) {
				expect(error.code).toBe(code);
				expect(error.cause).toBe(failure);
				expect(failure.cause).toBe(original);
			}
		})
	);
}

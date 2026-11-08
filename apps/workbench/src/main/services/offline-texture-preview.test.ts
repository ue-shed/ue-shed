import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
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

it.effect("A11.1 coalesces overlapping identical preview cache misses", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		let calls = 0;
		let available = false;
		const result = {
			authority: "saved_asset",
			contract: { name: "texture-preview", version: { major: 1, minor: 0 } },
			status: "available",
			objectPath: "/Game/Test.Test",
			width: 1,
			height: 1,
			mimeType: "image/png",
			dataBase64: "iVBORw0KGgo="
		};
		const host: OfflineTexturePreviewHostApi = {
			engineRoots: Effect.succeed([]),
			exists: () => Effect.succeed(true),
			listProjectFiles: () => Effect.succeed(["C:/Project/Test.uproject"]),
			statFile: () => Effect.succeed({ size: 4, modifiedMs: 10 }),
			readFile: () =>
				available
					? Effect.succeed(new TextEncoder().encode(JSON.stringify(result)))
					: Effect.fail(
							new OfflineTexturePreviewHostError({
								code: "offline_texture_preview_host_failed",
								operation: "read_file",
								path: "cache",
								message: "missing",
								recovery: "generate",
								nextStep: "retry",
								retrySafe: true,
								causeText: "missing"
							})
						),
			makeDirectory: () => Effect.void,
			writeFile: () => Effect.void,
			runCommandlet: () =>
				Effect.gen(function* () {
					calls++;
					yield* Deferred.succeed(started, undefined);
					yield* Deferred.await(release);
					available = true;
					return { exitCode: 0, stderr: "" };
				})
		};
		yield* Effect.gen(function* () {
			const previews = yield* OfflineTexturePreview;
			const input = [
				{
					projectRoot: "C:/Project",
					packageFile: "Content/Test.uasset",
					objectPath: "/Game/Test.Test"
				}
			];
			const first = yield* previews.previewBatch(input).pipe(Effect.forkChild);
			yield* Deferred.await(started);
			const second = yield* previews.previewBatch(input).pipe(Effect.forkChild);
			for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
			yield* Deferred.succeed(release, undefined);
			expect((yield* Fiber.join(first)).previews).toHaveLength(1);
			expect((yield* Fiber.join(second)).previews).toHaveLength(1);
			expect(calls).toBe(1);
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
			)
		);
	})
);

import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	EditorForegroundPermission,
	EditorForegroundPermissionLive,
	OwnedProcessTree,
	OwnedProcessTreeLive,
	processSupervisorExecutable,
	processSupervisorExecutableLayer
} from "./index.js";

const bundled = join(process.cwd(), "missing-bundle", "ue-shed-process-supervisor.exe");

it.effect("a host's supervisor path replaces the platform package's", () =>
	Effect.gen(function* () {
		const fromPackage = yield* processSupervisorExecutable.pipe(Effect.result);
		if (fromPackage._tag === "Success")
			expect(fromPackage.success).toMatch(
				/engine-win32-x64[\\/]bin[\\/]ue-shed-process-supervisor\.exe$/u
			);
		expect(
			yield* processSupervisorExecutable.pipe(
				Effect.provide(processSupervisorExecutableLayer(bundled))
			)
		).toBe(bundled);
	})
);

it.effect.skipIf(process.platform !== "win32")(
	"editor launches and foreground grants run the host's supervisor",
	() =>
		Effect.gen(function* () {
			const launch = yield* Effect.flatMap(OwnedProcessTree, (tree) =>
				tree.launch({
					executable: "UnrealEditor.exe",
					args: [],
					cwd: process.cwd(),
					terminationTimeout: "1 second"
				})
			).pipe(Effect.flip);
			expect(launch.code).toBe("process_tree_supervision_unavailable");
			expect(JSON.stringify(launch.cause)).toContain("missing-bundle");
			const grant = yield* Effect.flatMap(EditorForegroundPermission, (permission) =>
				permission.grant(1234)
			).pipe(Effect.flip);
			expect(JSON.stringify(grant.cause)).toContain("missing-bundle");
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					OwnedProcessTreeLive,
					EditorForegroundPermissionLive,
					processSupervisorExecutableLayer(bundled)
				)
			)
		)
);

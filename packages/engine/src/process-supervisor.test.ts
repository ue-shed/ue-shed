import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expect, expectTypeOf, it as test } from "vitest";
import {
	EditorForegroundPermission,
	EditorForegroundPermissionLive,
	OwnedProcessTree,
	OwnedProcessTreeLive,
	processSupervisorExecutable,
	processSupervisorExecutableLayer,
	type ProcessSupervisorUnavailable
} from "./index.js";

const bundled = join(process.cwd(), "missing-bundle", "ue-shed-process-supervisor.exe");

test("classifies an absent optional supervisor package and retains the resolution cause", async () => {
	expectTypeOf<
		Effect.Error<typeof processSupervisorExecutable>
	>().toEqualTypeOf<ProcessSupervisorUnavailable>();
	const root = await mkdtemp(join(tmpdir(), "ue-shed-supervisor-resolution-"));
	try {
		await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
		await mkdir(join(root, "node_modules", "@ue-shed"), { recursive: true });
		for (const name of ["effect", "@ue-shed/protocol"]) {
			await symlink(
				fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
				join(root, "node_modules", name),
				process.platform === "win32" ? "junction" : "dir"
			);
		}
		// Exercise the real resolver in an installation containing its ordinary dependencies,
		// but no optional supervisor package. The shipped implementation is copied unchanged.
		await copyFile(
			fileURLToPath(new URL("./process-supervisor.ts", import.meta.url)),
			join(root, "process-supervisor.ts")
		);
		await writeFile(
			join(root, "probe.mjs"),
			`
import { Effect } from "effect";
import { processSupervisorExecutable, processSupervisorExecutableLayer } from "./process-supervisor.ts";
const error = await Effect.runPromise(Effect.flip(processSupervisorExecutable));
const explicitPath = await Effect.runPromise(processSupervisorExecutable.pipe(
	Effect.provide(processSupervisorExecutableLayer("missing-explicit-supervisor.exe"))
));
process.stdout.write(JSON.stringify({
	tag: error._tag, packageName: error.packageName, retrySafe: error.retrySafe,
	nextStep: error.nextStep, causeCode: error.cause.code, explicitPath
}));
`
		);
		const result = spawnSync(process.execPath, [join(root, "probe.mjs")], {
			cwd: root,
			env: { ...process.env, NODE_PATH: "" },
			encoding: "utf8",
			timeout: 10_000,
			windowsHide: true
		});
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = Schema.decodeUnknownSync(
			Schema.Struct({
				tag: Schema.Literal("ProcessSupervisorUnavailable"),
				packageName: Schema.Literal("@ue-shed/engine-win32-x64"),
				retrySafe: Schema.Literal(true),
				nextStep: Schema.Literal("fix_input"),
				causeCode: Schema.Literal("MODULE_NOT_FOUND"),
				explicitPath: Schema.Literal("missing-explicit-supervisor.exe")
			})
		)(JSON.parse(result.stdout));
		expect(report.causeCode).toBe("MODULE_NOT_FOUND");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

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

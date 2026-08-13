import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	checkCatalogUsage,
	checkSourcePolicy,
	checkServiceStrategies,
	checkWorkbenchBoundaries
} from "./check-effect-architecture.ts";

let root = "";

before(async () => {
	root = await mkdtemp(join(tmpdir(), "ue-shed-effect-architecture-"));
	for (const directory of ["apps/example/src", "packages", "extensions"]) {
		await mkdir(join(root, directory), { recursive: true });
	}
});

after(async () => {
	await rm(root, { force: true, recursive: true });
});

test("rejects a runtime exit outside an approved adapter with a line diagnostic", async () => {
	await writeFile(join(root, "apps/example/src/index.ts"), "Effect.runPromise(program);\n");
	const failures = await checkSourcePolicy(root);
	assert.deepEqual(failures, [
		"apps/example/src/index.ts:1: Effect runtime exit is not approved"
	]);
});

test("rejects Promise services, environment reads, raw fetch, and unmanaged resources", async () => {
	await writeFile(
		join(root, "apps/example/src/index.ts"),
		"interface Bad { run(): Promise<void> }\nprocess.env.BAD\nfetch('x')\nsetInterval(work, 1)\n"
	);
	assert.deepEqual(await checkSourcePolicy(root), [
		"apps/example/src/index.ts:1: Promise type is only allowed in an approved foreign adapter",
		"apps/example/src/index.ts:2: application configuration must use Effect Config",
		"apps/example/src/index.ts:3: raw fetch is not an approved transport",
		"apps/example/src/index.ts:4: long-lived resource must be owned by an approved scoped adapter"
	]);
});

test("requires every Context service to name operations and provide a layer strategy", async () => {
	await writeFile(
		join(root, "apps/example/src/index.ts"),
		"export class Bad extends Context.Service<Bad, {}>()('Bad') {}\n"
	);
	assert.deepEqual(await checkServiceStrategies(root), [
		"apps/example/src/index.ts: service declaration has no live or test layer strategy",
		"apps/example/src/index.ts: service operations must use Effect.fn"
	]);
});

test("requires catalog-owned dependencies to use catalog protocol", async () => {
	await writeFile(
		join(root, "pnpm-workspace.yaml"),
		`catalog:\n  "@effect/opentelemetry": "4.0.0-beta.98"\n  "@effect/vitest": "4.0.0-beta.98"\n  "@opentelemetry/api": "^1.9.0"\n  "@opentelemetry/api-logs": "^0.205.0"\n  "@opentelemetry/resources": "^2.2.0"\n  "@opentelemetry/sdk-logs": "^0.205.0"\n  "@opentelemetry/sdk-metrics": "^2.2.0"\n  "@opentelemetry/sdk-trace-base": "^2.2.0"\n  "@opentelemetry/sdk-trace-node": "^2.2.0"\n  "@opentelemetry/sdk-trace-web": "^2.2.0"\n  "@opentelemetry/semantic-conventions": "^1.38.0"\n  "@stylexjs/rollup-plugin": "^0.19.0"\n  "@stylexjs/stylex": "^0.19.0"\n  effect: "4.0.0-beta.98"\n  solid-js: "^1.9.14"\n  vite-plugin-solid: "^2.11.12"\n`
	);
	await writeFile(join(root, "pnpm-lock.yaml"), "effect@4.0.0-beta.98:\n");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ dependencies: { effect: "^3.22.0" } })
	);
	const failures = await checkCatalogUsage(root);
	assert.deepEqual(failures, ["package.json: dependencies.effect must use catalog:"]);
});

async function withWorkbenchFixture(
	relativePath: string,
	contents: string,
	run: (fixtureRoot: string) => Promise<void>
) {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-workbench-boundary-"));
	try {
		const absolute = join(fixtureRoot, relativePath);
		await mkdir(join(absolute, ".."), { recursive: true });
		await writeFile(absolute, contents);
		await run(fixtureRoot);
	} finally {
		await rm(fixtureRoot, { force: true, recursive: true });
	}
}

test("rejects Workbench main Effect.runPromise and Effect.runSync", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-exit.ts",
		'import { Effect } from "effect";\nEffect.runPromise(Effect.void);\nEffect.runSync(Effect.void);\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-exit.ts: Workbench main must not call Effect.runPromise or Effect.runSync"
			]);
		}
	);
});

test("rejects Workbench main process.env outside the Electron bootstrap", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-env.ts",
		"export const value = process.env.UE_SHED_PROJECT_ROOT;\n",
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-env.ts: Workbench main must receive environment from the Electron bootstrap"
			]);
		}
	);
});

test("rejects hidden Workbench service layer builds", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-layer.ts",
		'import { Layer } from "effect";\nexport const hidden = Layer.build(layer);\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-layer.ts: Workbench main must compose services through layers"
			]);
		}
	);
});

test("rejects Workbench main raw fetch", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-fetch.ts",
		'export const load = () => fetch("http://127.0.0.1:30001");\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-fetch.ts: Workbench main must not call raw fetch"
			]);
		}
	);
});

test("rejects ipcMain.handle outside bootstrap or adapters", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-ipc.ts",
		'export const register = (ipcMain) => {\n\tipcMain.handle("x", async () => null);\n};\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-ipc.ts: ipcMain.handle is only allowed in the Electron bootstrap or adapters"
			]);
		}
	);
});

test("rejects electron/main imports outside bootstrap or adapters", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/main/services/bad-electron.ts",
		'import { app } from "electron/main";\nexport const ready = app.whenReady;\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/main/services/bad-electron.ts: electron/main imports are only allowed in the Electron bootstrap or adapters"
			]);
		}
	);
});

test("rejects packages importing apps/workbench", async () => {
	await withWorkbenchFixture(
		"packages/example/src/index.ts",
		'import { WorkbenchLive } from "../../../apps/workbench/src/main/workbench-live.js";\n',
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"packages/example/src/index.ts: packages must not import apps/workbench"
			]);
		}
	);
});

test("rejects renderer IPC access outside transport adapters", async () => {
	await withWorkbenchFixture(
		"apps/workbench/src/renderer/bad-component.tsx",
		"export const Bad = () => window.ueShed.getStatus();\n",
		async (fixtureRoot) => {
			const failures = await checkWorkbenchBoundaries(fixtureRoot);
			assert.deepEqual(failures, [
				"apps/workbench/src/renderer/bad-component.tsx: renderer IPC is only allowed in transport adapters"
			]);
		}
	);
});

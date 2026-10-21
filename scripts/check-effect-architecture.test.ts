import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	checkCatalogUsage,
	checkErrorGuidance,
	checkErrorTranslationCauses,
	checkBrowserEntryClosures,
	checkGameTextEntryPoints,
	checkCompositionPolicy,
	checkDecoderExports,
	checkLocalizationBoundaries,
	checkSourcePolicy,
	checkTaggedErrorMatching,
	checkServiceStrategies,
	checkWorkbenchBoundaries
} from "./check-effect-architecture.ts";

let root = "";

test("error translation retains the original failure in mapError and IO catches", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-error-causes-"));
	try {
		const source = join(fixtureRoot, "packages/example/src");
		await mkdir(source, { recursive: true });
		await mkdir(join(fixtureRoot, "apps"));
		await mkdir(join(fixtureRoot, "extensions"));
		await writeFile(
			join(source, "use.ts"),
			[
				"const a = Effect.mapError((error) => new ReadError({message: error.message}));",
				"const b = Effect.tryPromise({try: read, catch: () => new ReadError({message: 'failed'})});",
				"const c = Effect.mapError((cause) => new ReadError({message: 'failed', cause}));",
				"const d = Effect.tryPromise({try: read, catch: (cause) => new ReadError({message: 'failed', cause})});",
				"const expected = () => new ReadError({message: 'no selection'});",
				"const spread = Effect.mapError((cause) => new ReadError({...guidance, message: cause.message}));",
				"function helper(error: ReadError) { return new ReadError({message: error.message}); }",
				"function complete(options: {readonly cause: unknown}) { return new ReadError({...options,message: 'failed'}); }",
				"function local(cause: unknown) { const fields = {cause}; return new ReadError({...fields,message: 'failed'}); }",
				"function optional(cause?: unknown) { return new ReadError({...(cause === undefined ? undefined : {cause}), message: 'failed'}); }",
				"const status = Effect.mapError((cause) => new ReadError({...(cause.status === undefined ? undefined : {status: cause.status}), message: cause.message}));",
				'class ReaderUnavailable extends Schema.TaggedError<ReaderUnavailable>()("ReaderUnavailable", {}) {}',
				"const tagged = Effect.mapError((cause) => new ReaderUnavailable({message: cause.message}));"
			].join("\n")
		);
		assert.deepEqual(await checkErrorTranslationCauses(fixtureRoot), [
			"packages/example/src/use.ts:1: error translation must retain its original cause",
			"packages/example/src/use.ts:2: error translation must retain its original cause",
			"packages/example/src/use.ts:6: error translation must retain its original cause",
			"packages/example/src/use.ts:7: error translation must retain its original cause",
			"packages/example/src/use.ts:11: error translation must retain its original cause",
			"packages/example/src/use.ts:13: error translation must retain its original cause"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("package browser entries reach no Node authority or unreviewed dependency", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-browser-closures-"));
	try {
		const demo = join(fixtureRoot, "packages/demo");
		const shared = join(fixtureRoot, "packages/shared");
		await mkdir(join(demo, "src"), { recursive: true });
		await mkdir(join(shared, "src"), { recursive: true });
		await writeFile(
			join(demo, "package.json"),
			JSON.stringify({
				name: "@ue-shed/demo",
				exports: { "./browser": { import: "./dist/browser.js" } }
			})
		);
		await writeFile(
			join(shared, "package.json"),
			JSON.stringify({ name: "@ue-shed/shared", exports: { "./pure": "./src/pure.ts" } })
		);
		await writeFile(
			join(demo, "src/browser.ts"),
			[
				'export * from "./schema.js";',
				'import { Schema } from "effect";',
				'import { pure } from "@ue-shed/shared/pure";',
				'import chalk from "chalk";'
			].join("\n")
		);
		await writeFile(join(demo, "src/schema.ts"), "export const root = process.cwd();\n");
		await writeFile(join(shared, "src/pure.ts"), 'import { readFile } from "node:fs";\n');
		assert.deepEqual((await checkBrowserEntryClosures(fixtureRoot)).sort(), [
			"packages/demo/src/browser.ts: unreviewed browser dependency chalk",
			"packages/demo/src/schema.ts: browser closure must not use process",
			"packages/shared/src/pure.ts: browser closure must not import node:fs"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("browser closures follow JavaScript sources and Node-only subpaths of guarded packages", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-browser-closures-js-"));
	try {
		const wasm = join(fixtureRoot, "packages/wasm");
		const demo = join(fixtureRoot, "packages/demo");
		const localization = join(fixtureRoot, "packages/localization");
		for (const folder of [wasm, demo, localization])
			await mkdir(join(folder, "src"), { recursive: true });
		await writeFile(
			join(wasm, "package.json"),
			JSON.stringify({ exports: { "./browser": { import: "./dist/browser.js" } } })
		);
		await writeFile(join(wasm, "src/browser.js"), 'export * from "./runtime.js";\n');
		await writeFile(
			join(wasm, "src/runtime.js"),
			'export { readFile } from "node:fs/promises";\n'
		);
		await writeFile(
			join(demo, "package.json"),
			JSON.stringify({ exports: { "./browser": { import: "./dist/browser.js" } } })
		);
		await writeFile(
			join(demo, "src/browser.ts"),
			[
				'export { format } from "@ue-shed/localization/browser";',
				'export { readFile } from "@ue-shed/localization";'
			].join("\n")
		);
		await writeFile(
			join(localization, "package.json"),
			JSON.stringify({
				exports: {
					".": { import: "./dist/index.js" },
					"./browser": { import: "./dist/browser.js" }
				}
			})
		);
		// The localization guard walks only `src/browser.ts`; the Node root is not exempt.
		await writeFile(join(localization, "src/browser.ts"), 'import "node:path";\n');
		await writeFile(join(localization, "src/index.ts"), 'export * from "./file-access.js";\n');
		await writeFile(
			join(localization, "src/file-access.ts"),
			'export { readFile } from "node:fs/promises";\n'
		);
		assert.deepEqual((await checkBrowserEntryClosures(fixtureRoot)).sort(), [
			"packages/localization/src/file-access.ts: browser closure must not import node:fs/promises",
			"packages/wasm/src/runtime.js: browser closure must not import node:fs/promises"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("Game Text entry points are named and first-party code imports focused entry points", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-game-text-entries-"));
	try {
		const source = join(fixtureRoot, "packages/game-text/src");
		const consumer = join(fixtureRoot, "apps/cli/src");
		await mkdir(source, { recursive: true });
		await mkdir(consumer, { recursive: true });
		await writeFile(
			join(source, "entry-schema.ts"),
			'/* Example only:\nexport * from "./private.js";\n*/\nexport { TextUnit } from "./schema.js";\n'
		);
		await writeFile(join(source, "entry-corpus.ts"), 'export * from "./query.js";\n');
		await writeFile(
			join(consumer, "ok.ts"),
			'import { TextUnit } from "@ue-shed/game-text/schema";\n'
		);
		await writeFile(
			join(consumer, "metadata.ts"),
			[
				'export const packageName = "@ue-shed/game-text";',
				'export const browserName = "@ue-shed/game-text/browser";',
				'export const example = `import("@ue-shed/game-text")`;',
				'// import { TextUnit } from "@ue-shed/game-text";',
				'/* export * from "@ue-shed/game-text/browser"; */'
			].join("\n")
		);
		await writeFile(
			join(consumer, "root.ts"),
			'import { TextUnit } from "@ue-shed/game-text";\n'
		);
		await writeFile(
			join(consumer, "browser.ts"),
			"const load = () => import('@ue-shed/game-text/browser');\n"
		);
		assert.deepEqual((await checkGameTextEntryPoints(fixtureRoot)).sort(), [
			"apps/cli/src/browser.ts: import a focused @ue-shed/game-text entry point (/schema, /rules, /checks, /labels, /corpus, /index or /workspace)",
			"apps/cli/src/root.ts: import a focused @ue-shed/game-text entry point (/schema, /rules, /checks, /labels, /corpus, /index or /workspace)",
			"packages/game-text/src/entry-corpus.ts: Game Text entry points use named exports only"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("tagged errors are matched by tag, not instanceof", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-tagged-matching-"));
	try {
		const source = join(fixtureRoot, "packages/example/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "errors.ts"),
			[
				'import { Schema } from "effect";',
				'export class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {}) {}',
				"export class PlainError extends Error {}",
				"export const isRead = Schema.is(ReadError);"
			].join("\n")
		);
		await writeFile(
			join(source, "use.ts"),
			[
				'import { ReadError, PlainError } from "./errors.js";',
				"export const a = (cause: unknown) => cause instanceof PlainError;",
				"export const b = (cause: unknown) => cause instanceof Error;",
				"export const c = (cause: unknown) => cause instanceof ReadError;"
			].join("\n")
		);
		assert.deepEqual(await checkTaggedErrorMatching(fixtureRoot), [
			"packages/example/src/use.ts:4: match ReadError by tag (catchTag, Schema.is or Predicate.isTagged), not instanceof"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("browser import scanning distinguishes module syntax from strings and comments", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-localization-import-syntax-"));
	try {
		const source = join(fixtureRoot, "packages/localization/src");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "../package.json"), '{"dependencies":{"effect":"catalog:"}}');
		await writeFile(join(source, "browser.ts"), 'export * from "./formats.js";\n');
		await writeFile(
			join(source, "formats.ts"),
			[
				"import {",
				"  Schema",
				'} from "effect";',
				'import "effect";',
				'export const operations = Schema.Literals(["import", "export"]);',
				'export const isImport = (operation: string) => operation === "import" || operation === "export";',
				'export const label = \'import("node:fs") from ","\';',
				'export const template = `import("node:fs")`;',
				"/** Runs in a browser process. No Node API is required. */",
				'export const processExample = "process.env.EXAMPLE";',
				'// import { readFile } from "node:fs/promises";',
				'/* export * from "electron"; */'
			].join("\n")
		);
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), []);
		await writeFile(
			join(source, "formats.ts"),
			[
				'import { readFile } from "node:fs/promises";',
				'export { spawn } from "node:child_process";',
				'export type FileInfo = import("node:fs").Stats;',
				'export const load = () => import("electron");',
				'import events = require("node:events");',
				'export const socket = require("node:net");'
			].join("\n")
		);
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), [
			"packages/localization/src/formats.ts: browser closure must not import node:fs/promises",
			"packages/localization/src/formats.ts: browser closure must not import node:child_process",
			"packages/localization/src/formats.ts: browser closure must not import node:fs",
			"packages/localization/src/formats.ts: browser closure must not import electron",
			"packages/localization/src/formats.ts: browser closure must not import node:events",
			"packages/localization/src/formats.ts: browser closure must not import node:net"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("checks the Game Text browser closure and its localization dependency", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-localization-join-boundary-"));
	try {
		const formats = join(fixtureRoot, "packages/localization");
		const corpus = join(fixtureRoot, "packages/game-text/src");
		await mkdir(join(formats, "src"), { recursive: true });
		await mkdir(corpus, { recursive: true });
		await writeFile(join(formats, "package.json"), '{"dependencies":{"effect":"catalog:"}}');
		await writeFile(join(formats, "src/browser.ts"), 'import { Schema } from "effect";\n');
		await writeFile(join(corpus, "browser.ts"), 'export * from "./join.js";\n');
		await writeFile(join(corpus, "join.ts"), 'import { readFile } from "node:fs/promises";\n');
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), [
			"packages/game-text/src/join.ts: browser closure must not import node:fs/promises"
		]);
		await writeFile(
			join(corpus, "join.ts"),
			'import { LocalizationIdentity } from "@ue-shed/localization/browser";\n'
		);
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), []);
		await writeFile(
			join(corpus, "localization-words.ts"),
			'import LineBreaker from "linebreak";\n'
		);
		await writeFile(join(corpus, "browser.ts"), 'export * from "./localization-words.js";\n');
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), []);
		await writeFile(join(corpus, "join.ts"), 'import LineBreaker from "linebreak";\n');
		await writeFile(join(corpus, "browser.ts"), 'export * from "./join.js";\n');
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), [
			"packages/game-text/src/join.ts: linebreak must be confined to localization-words.ts"
		]);
		const reader = join(fixtureRoot, "packages/unreal-assets/src");
		const protocol = join(fixtureRoot, "packages/protocol/src");
		await mkdir(reader, { recursive: true });
		await mkdir(protocol, { recursive: true });
		await writeFile(
			join(corpus, "join.ts"),
			'import { SavedAssetTextCoverageGap } from "@ue-shed/unreal-assets/text-extraction";\n'
		);
		await writeFile(
			join(reader, "text-extraction.ts"),
			'export { SavedAssetTextCoverageGap } from "@ue-shed/protocol";\n'
		);
		await writeFile(join(protocol, "index.ts"), 'import { Schema } from "effect";\n');
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), []);
		await writeFile(
			join(protocol, "index.ts"),
			'import { readFile } from "node:fs/promises";\n'
		);
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), [
			"packages/protocol/src/index.ts: browser closure must not import node:fs/promises"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("rejects corpus dependencies and Node authority in the localization browser closure", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-localization-boundary-"));
	try {
		const source = join(fixtureRoot, "packages/localization/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "../package.json"),
			'{"dependencies":{"@ue-shed/game-text":"workspace:*"}}'
		);
		await writeFile(join(source, "browser.ts"), 'export * from "./formats.js";\n');
		await writeFile(
			join(source, "formats.ts"),
			'import { readFile } from "node:fs/promises";\nprocess.cwd();\n'
		);
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), [
			"packages/localization/package.json: localization must not depend on the Game Text corpus",
			"packages/localization/src/formats.ts: browser closure must not use process",
			"packages/localization/src/formats.ts: browser closure must not import node:fs/promises"
		]);
		await writeFile(join(source, "../package.json"), '{"dependencies":{"effect":"catalog:"}}');
		await writeFile(join(source, "formats.ts"), 'import { Schema } from "effect";\n');
		assert.deepEqual(await checkLocalizationBoundaries(fixtureRoot), []);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

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

test("keeps test subprocess helpers outside production source policy", async () => {
	const helper = join(root, "apps/example/src/process.test-support.ts");
	await writeFile(join(root, "apps/example/src/index.ts"), "export {};\n");
	await writeFile(helper, "function run(): Promise<void> { return process.env.TEST; }\n");
	try {
		assert.deepEqual(await checkSourcePolicy(root), []);
	} finally {
		await rm(helper);
	}
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
		`catalog:\n  "@effect/opentelemetry": "4.0.4"\n  "@effect/vitest": "4.0.4"\n  "@opentelemetry/api": "^1.9.0"\n  "@opentelemetry/api-logs": "^0.205.0"\n  "@opentelemetry/resources": "^2.2.0"\n  "@opentelemetry/sdk-logs": "^0.205.0"\n  "@opentelemetry/sdk-metrics": "^2.2.0"\n  "@opentelemetry/sdk-trace-base": "^2.2.0"\n  "@opentelemetry/sdk-trace-node": "^2.2.0"\n  "@opentelemetry/sdk-trace-web": "^2.2.0"\n  "@opentelemetry/semantic-conventions": "^1.38.0"\n  "@stylexjs/rollup-plugin": "^0.19.0"\n  "@stylexjs/stylex": "^0.19.0"\n  effect: "4.0.4"\n  solid-js: "^1.9.14"\n  vite-plugin-solid: "^2.11.12"\n`
	);
	await writeFile(join(root, "pnpm-lock.yaml"), "effect@4.0.4:\n");
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ private: true, dependencies: { effect: "^3.22.0" } })
	);
	const failures = await checkCatalogUsage(root);
	assert.deepEqual(failures, ["package.json: dependencies.effect must use catalog:"]);
	const publicManifest = {
		peerDependencies: { effect: "^4.0.0", "@effect/opentelemetry": "^4.0.0" },
		devDependencies: { effect: "catalog:", "@effect/opentelemetry": "catalog:" }
	};
	await writeFile(join(root, "package.json"), JSON.stringify(publicManifest));
	assert.deepEqual(await checkCatalogUsage(root), []);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ ...publicManifest, peerDependencies: { effect: "catalog:" } })
	);
	assert.deepEqual(await checkCatalogUsage(root), [
		"package.json: effect must be a ^4.0.0 peer dependency"
	]);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ ...publicManifest, devDependencies: {} })
	);
	assert.deepEqual(await checkCatalogUsage(root), [
		"package.json: devDependencies.effect must use catalog:",
		"package.json: devDependencies.@effect/opentelemetry must use catalog:"
	]);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ ...publicManifest, dependencies: { effect: "catalog:" } })
	);
	assert.deepEqual(await checkCatalogUsage(root), [
		"package.json: effect must be a ^4.0.0 peer dependency"
	]);
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

test("rejects new exported raw Schema decoders outside the baseline", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-raw-decoders-"));
	try {
		const source = join(fixtureRoot, "packages/example/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "schema.ts"),
			[
				'import { Effect, Schema } from "effect";',
				"export const decodeKnown = Schema.decodeUnknownEffect(Known);",
				"export const decodeNew = Schema.decodeUnknownSync(New);",
				"export const validateNew: (input: unknown) => New =",
				"\tSchema.validateSync(New);",
				"const decodeLocal = Schema.decodeUnknownEffect(Local);",
				"export const parseNew = (encoded: New) => decodeLocal(encoded).pipe(Effect.orDie);"
			].join("\n")
		);
		await writeFile(
			join(source, "schema.test.ts"),
			"export const decodeInTest = Schema.decodeUnknownSync(New);\n"
		);
		assert.deepEqual(
			await checkDecoderExports(
				fixtureRoot,
				new Set(["packages/example/src/schema.ts:decodeKnown"])
			),
			[
				"packages/example/src/schema.ts:3: decodeNew exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:4: validateNew exports a raw Schema decoder; export a domain parser"
			]
		);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("checks named, renamed and default decoder exports through their local bindings", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-decoder-bindings-"));
	try {
		const source = join(fixtureRoot, "packages/example/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "schema.ts"),
			[
				'import { Effect, Schema } from "effect";',
				"const decodeNamed = Schema.decodeUnknownEffect(New);",
				"const decodeRenamed = Schema.decodeUnknownSync(New);",
				"const decodeKnown = Schema.validateSync(Known);",
				"const decodeLocal = Schema.decodeUnknownEffect(Local);",
				"const parseLocal = (input: Local) => decodeLocal(input).pipe(Effect.orDie);",
				"export { decodeNamed };",
				"export { decodeRenamed as parseRenamed };",
				"export { decodeKnown as parseKnown };",
				"export type { decodeLocal };",
				"export { parseLocal };",
				"export default decodeLocal;",
				"export type { decodeNamed as DecoderType };",
				"// export const decodeComment = Schema.decodeUnknownSync(New);",
				'export const label = "export const decodeString = Schema.decodeUnknownSync(New);";',
				"export { decodeLater as parseLater };",
				"const decodeLater = Schema.validateSync(New);",
				"const decodeAlias = decodeNamed;",
				"export { decodeAlias as parseAlias };",
				"const decodeWrapped = (Schema.validateSync(New) satisfies (input: unknown) => New);",
				"export { decodeWrapped };",
				"export const decodePreviouslyKnown = Schema.decodeUnknownEffect(Known);",
				"export { decodePreviouslyKnown as decodeCompatibilityAlias };"
			].join("\n")
		);
		assert.deepEqual(
			await checkDecoderExports(
				fixtureRoot,
				new Set([
					"packages/example/src/schema.ts:parseKnown",
					"packages/example/src/schema.ts:decodePreviouslyKnown"
				])
			),
			[
				"packages/example/src/schema.ts:7: decodeNamed exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:8: parseRenamed exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:12: default exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:16: parseLater exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:19: parseAlias exports a raw Schema decoder; export a domain parser",
				"packages/example/src/schema.ts:21: decodeWrapped exports a raw Schema decoder; export a domain parser"
			]
		);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("rejects layer factories taking a Layer and make* exports only their module uses", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-composition-"));
	try {
		const source = join(fixtureRoot, "packages/example/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "service.ts"),
			[
				'import { Layer } from "effect";',
				"export function serviceLayer(config: string, ids: Layer.Layer<Ids>) {",
				"\treturn ids;",
				"}",
				"export const viewLayer = <E>(",
				"\tbacking: Layer.Layer<Index, E>",
				") => backing;",
				"export const makeUnused = () => 1;",
				"export function makeShared() {",
				"\treturn 2;",
				"}",
				"export function configuredLayer(config: string) {",
				"\treturn config;",
				"}"
			].join("\n")
		);
		await writeFile(
			join(source, "service.test.ts"),
			'import { makeShared } from "./service.js";\nmakeShared();\n'
		);
		assert.deepEqual(await checkCompositionPolicy(fixtureRoot), [
			"packages/example/src/service.ts:2: serviceLayer takes a Layer; require its service instead",
			"packages/example/src/service.ts:5: viewLayer takes a Layer; require its service instead",
			"packages/example/src/service.ts:8: makeUnused is used only in its module; do not export it"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});

test("tagged errors in migrated packages carry the guidance fields", async () => {
	const fixtureRoot = await mkdtemp(join(tmpdir(), "ue-shed-error-shape-"));
	try {
		const source = join(fixtureRoot, "packages/unreal-connection/src");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "errors.ts"),
			[
				'import { Schema } from "effect";',
				'import { ErrorGuidanceFields } from "@ue-shed/protocol";',
				"const Shared = { ...ErrorGuidanceFields, message: Schema.String };",
				'export class Good extends Schema.TaggedError<Good>()("Good", { id: Schema.String, ...ErrorGuidanceFields }) {}',
				'export class Local extends Schema.TaggedError<Local>()("Local", Shared) {}',
				'export class Bad extends Schema.TaggedError<Bad>()("Bad", { message: Schema.String, retrySafe: Schema.Boolean }) {}'
			].join("\n")
		);
		assert.deepEqual(await checkErrorGuidance(fixtureRoot), [
			"packages/unreal-connection/src/errors.ts: Bad must carry recovery, nextStep (spread ErrorGuidanceFields from @ue-shed/protocol)"
		]);
	} finally {
		await rm(fixtureRoot, { recursive: true, force: true });
	}
});
